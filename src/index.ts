#!/usr/bin/env bun
// claude-agent-bus — a tiny MCP coordination server for a fleet of Claude Code
// agents on separate hosts. One process, one SQLite file, exposing a shared
// board + mailbox + work-claim bus over streamable HTTP. Each agent connects via
// its host's .mcp.json and identifies itself with the X-Agent-Name header.

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.ts";
import { BusStore } from "./db.ts";
import { buildMcpServer } from "./server.ts";

const cfg = loadConfig();
const store = new BusStore(cfg.dbPath, cfg.staleAfter);

const app = express();
app.use(express.json({ limit: "1mb" }));

// --- auth: every request needs `Authorization: Bearer <token>` (except /health).
function auth(req: Request, res: Response, next: NextFunction) {
  if (cfg.allowNoAuth) return next();
  const header = req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!cfg.token || token !== cfg.token) {
    res.status(401).json({ error: "unauthorized — send Authorization: Bearer <AGENT_BUS_TOKEN>" });
    return;
  }
  next();
}

// --- health: unauthenticated liveness + a one-glance fleet summary.
app.get("/health", (_req, res) => {
  const agents = store.listAgents();
  res.json({
    ok: true,
    service: "claude-agent-bus",
    agents: agents.length,
    online: agents.filter((a) => a.online).map((a) => a.name),
    claims: store.listClaims().length,
  });
});

// --- MCP endpoint: stateless streamable HTTP. A fresh server + transport per
// request (no session state to lose across restarts); identity comes from the
// X-Agent-Name header and is closed over by the tools.
app.post("/mcp", auth, async (req: Request, res: Response) => {
  const identity = (req.header("x-agent-name") ?? "").trim() || null;
  const server = buildMcpServer(store, cfg, identity);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e instanceof Error ? e.message : e) }, id: null });
    }
  }
});

// Stateless transport has no server→client stream, so GET/DELETE aren't supported.
const noStream = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — this server is stateless; POST JSON-RPC to /mcp." }, id: null });
app.get("/mcp", auth, noStream);
app.delete("/mcp", auth, noStream);

const httpServer = app.listen(cfg.port, cfg.host, () => {
  const authNote = cfg.allowNoAuth ? "\x1b[33mNO AUTH (dev)\x1b[0m" : "bearer-token auth";
  console.log(`claude-agent-bus listening on http://${cfg.host}:${cfg.port}  ·  MCP at POST /mcp  ·  ${authNote}  ·  db ${cfg.dbPath}`);
});

function shutdown() {
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
