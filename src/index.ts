#!/usr/bin/env bun
// agent-bus — a tiny MCP coordination server for a fleet of autonomous coding
// agents on separate hosts. One process, one SQLite file, exposing a shared
// board + mailbox + work-claim bus over streamable HTTP. Each agent connects via
// its host's .mcp.json and identifies itself with the X-Agent-Name header.

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { BusStore } from "./db.ts";
import { buildMcpServer } from "./server.ts";
import { log, setLevel } from "./log.ts";

// Static assets read once at startup; null if absent.
function readAsset(relPath: string): string | null {
  try {
    return readFileSync(new URL(relPath, import.meta.url), "utf8");
  } catch {
    return null;
  }
}
// Usage doc, served verbatim at GET /SKILL.md so an agent (or human) can fetch
// how to use the bus as markdown.
const skillMd: string | null = readAsset("../skills/SKILL.md");
// The landing page — a live, retro visualization of the fleet.
const landingHtml: string | null = readAsset("../web/index.html");

const cfg = loadConfig();
setLevel(cfg.logLevel);
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
    service: "agent-bus",
    agents: agents.length,
    online: agents.filter((a) => a.online).map((a) => a.name),
    claims: store.listClaims().length,
  });
});

// --- SKILL.md: unauthenticated. How to use the bus, as markdown — so an agent
// can self-onboard by fetching it. No secrets here, just the protocol.
app.get("/SKILL.md", (_req, res) => {
  if (skillMd === null) {
    res.status(404).type("text/plain").send("SKILL.md not found");
    return;
  }
  res.type("text/markdown").send(skillMd);
});

// --- landing page: unauthenticated. A live, retro visualization of the fleet.
app.get("/", (_req, res) => {
  if (landingHtml === null) {
    res.status(404).type("text/plain").send("landing page not found");
    return;
  }
  res.type("text/html").send(landingHtml);
});

// --- stats: unauthenticated aggregate for the landing page. Presence + message
// FLOW (who→whom, how much, when) but NO message bodies. Answers "which agents
// are talking" without revealing what was said.
app.get("/stats", (_req, res) => {
  const agents = store.listAgents();
  res.json({
    ok: true,
    now: Date.now(),
    staleAfter: cfg.staleAfter,
    agents: agents.map((a) => ({ name: a.name, online: a.online, status: a.status, host: a.host, lastSeen: a.last_seen })),
    messages: store.messageStats(),
    claims: store.listClaims().length,
  });
});

// --- board: token-gated. The full picture including message BODIES and claim
// details — this is what the AGENT_BUS_TOKEN "unlocks" in the UI.
app.get("/board", auth, (_req, res) => {
  res.json({
    ok: true,
    now: Date.now(),
    agents: store.listAgents(),
    claims: store.listClaims(),
    messages: store.recentMessages(50),
  });
});

// --- MCP endpoint: stateless streamable HTTP. A fresh server + transport per
// request (no session state to lose across restarts); identity comes from the
// X-Agent-Name header and is closed over by the tools.
app.post("/mcp", auth, async (req: Request, res: Response) => {
  const identity = (req.header("x-agent-name") ?? "").trim() || null;
  // The JSON-RPC envelope tells us what the agent is actually doing: `method`
  // is e.g. "tools/call", and for tool calls params.name is the tool invoked.
  const rpc = (req.body ?? {}) as { method?: string; params?: { name?: string } };
  const method = rpc.method ?? "?";
  const tool = method === "tools/call" ? rpc.params?.name : undefined;
  const started = Date.now();
  log.debug("mcp request", { agent: identity, method, tool, ip: req.ip });

  const server = buildMcpServer(store, cfg, identity);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    log.debug("mcp response", { agent: identity, method, tool, status: res.statusCode, ms: Date.now() - started });
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log.error("mcp error", { agent: identity, method, tool, err: e instanceof Error ? e.message : String(e) });
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

// --- error handler: a malformed JSON body makes express.json() throw. Without
// this, Express's default handler dumps a stack trace to the logs on every junk
// request (bots, probes, broken clients). Turn it into a clean 400 instead.
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const e = err as { type?: string; status?: number; statusCode?: number } | null;
  const isBadBody = e?.type === "entity.parse.failed" || err instanceof SyntaxError;
  if (res.headersSent) return next(err);
  const status = isBadBody ? 400 : e?.status ?? e?.statusCode ?? 500;
  const message = isBadBody ? "Parse error: request body is not valid JSON" : "internal server error";
  if (isBadBody) log.warn("bad request body", { ip: req.ip, status });
  else log.error("unhandled error", { ip: req.ip, status, err: err instanceof Error ? err.message : String(err) });
  res.status(status).json({ jsonrpc: "2.0", error: { code: isBadBody ? -32700 : -32603, message }, id: null });
});

// Always bind all interfaces — every place this runs (Railway, Docker, k8s)
// needs the platform router to reach the container.
const httpServer = app.listen(cfg.port, "0.0.0.0", () => {
  const authNote = cfg.allowNoAuth ? "\x1b[33mNO AUTH (dev)\x1b[0m" : "bearer-token auth";
  console.log(`agent-bus listening on http://0.0.0.0:${cfg.port}  ·  MCP at POST /mcp  ·  ${authNote}  ·  db ${cfg.dbPath}`);
  log.info("started", { port: cfg.port, auth: cfg.allowNoAuth ? "none" : "bearer", db: cfg.dbPath, logLevel: cfg.logLevel });
});

function shutdown() {
  log.info("shutting down");
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
