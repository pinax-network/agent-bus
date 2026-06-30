#!/usr/bin/env bun
// agent-bus — a tiny MCP coordination server for a fleet of autonomous coding
// agents on separate hosts. One process, one SQLite file, exposing a shared
// board + mailbox + work-claim bus over streamable HTTP. Each agent connects via
// its host's .mcp.json and identifies itself with the X-Agent-Name header.

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { BusStore, type FeedFilter, type MessageRow } from "./db.ts";
import { buildMcpServer, VERSION } from "./server.ts";
import { startWatcher } from "./watcher.ts";

// --- feed helpers: render the public-message stream as RSS 2.0 / JSON Feed.

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
}

/** Pull the recognised feed filters out of a query string. */
function feedFilter(q: Record<string, unknown>): FeedFilter {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { assignee: str(q.assignee), domain: str(q.domain), kind: str(q.kind) };
}

/** Best-effort link for a message: its data.url, else the feed's own home. */
function itemLink(m: MessageRow, base: string): string {
  const url = (m.data as { url?: unknown } | null)?.url;
  return typeof url === "string" && url ? url : base;
}

/** Categories from a message's structured data (domain, component). */
function itemCategories(m: MessageRow): string[] {
  const d = m.data as { domain?: unknown; component?: unknown } | null;
  return [d?.domain, d?.component].filter((v): v is string => typeof v === "string" && v.length > 0);
}

function renderRss(messages: MessageRow[], base: string): string {
  const items = messages
    .map((m) => {
      const link = itemLink(m, base);
      const cats = itemCategories(m).map((c) => `      <category>${xmlEscape(c)}</category>`).join("\n");
      return [
        "    <item>",
        `      <title>${xmlEscape(m.body)}</title>`,
        `      <link>${xmlEscape(link)}</link>`,
        `      <guid isPermaLink="false">agent-bus:msg:${m.id}</guid>`,
        `      <pubDate>${new Date(m.ts).toUTCString()}</pubDate>`,
        `      <dc:creator>${xmlEscape(m.sender)}</dc:creator>`,
        cats,
        "    </item>",
      ]
        .filter((l) => l.length > 0)
        .join("\n");
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "  <channel>",
    "    <title>agent-bus</title>",
    `    <link>${xmlEscape(base)}</link>`,
    "    <description>Public broadcasts from the agent-bus fleet</description>",
    items,
    "  </channel>",
    "</rss>",
  ]
    .filter((l) => l.length > 0)
    .join("\n");
}

function renderJsonFeed(messages: MessageRow[], base: string, feedUrl: string) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "agent-bus",
    home_page_url: base,
    feed_url: feedUrl,
    description: "Public broadcasts from the agent-bus fleet",
    items: messages.map((m) => ({
      id: `agent-bus:msg:${m.id}`,
      url: itemLink(m, base),
      title: m.body,
      content_text: m.body,
      date_published: new Date(m.ts).toISOString(),
      authors: [{ name: m.sender }],
      tags: itemCategories(m),
      _agent_bus: { data: m.data },
    })),
  };
}

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
const store = new BusStore(cfg.dbPath, cfg.staleAfter);

// --- release-watcher: optional in-process poller. Disabled unless explicitly
// enabled AND given a GitHub token (without one the ~70-repo poll would blow the
// 60/hr unauthenticated rate limit). Logs to stdout; k8s collects it.
let stopWatcher: (() => void) | null = null;
if (cfg.watch) {
  if (!cfg.githubToken) {
    console.warn("[watcher] disabled: AGENT_BUS_WATCH is set but GITHUB_TOKEN is missing");
  } else {
    const watchlistPath = cfg.watchlistPath ?? fileURLToPath(new URL("../watchlist.json", import.meta.url));
    stopWatcher = startWatcher(store, {
      watchlistPath,
      githubToken: cfg.githubToken,
      intervalMs: cfg.watchIntervalSec * 1000,
    });
  }
}

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
    version: VERSION,
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
    version: VERSION,
    now: Date.now(),
    staleAfter: cfg.staleAfter,
    agents: agents.map((a) => ({ name: a.name, online: a.online, status: a.status, host: a.host, lastSeen: a.last_seen })),
    messages: store.messageStats(),
    // Public messages CAN show their bodies here — that's what 'public' means.
    // Private bodies are still withheld; only the flow in `messages` reveals them.
    publicMessages: store.publicMessages({}, 25),
    claims: store.listClaims().length,
  });
});

// --- feed: unauthenticated. The public projection of the message bus — only
// messages sent with visibility='public' (e.g. release alerts), newest first.
// Optional ?assignee= / ?domain= / ?kind= filters match the message's `data`.
// Two formats: /feed.xml (RSS 2.0) and /feed.json (JSON Feed).
function feedBase(req: Request): string {
  return `${req.protocol}://${req.get("host") ?? `localhost:${cfg.port}`}`;
}

app.get("/feed.xml", (req, res) => {
  const messages = store.publicMessages(feedFilter(req.query as Record<string, unknown>), 50);
  res.type("application/rss+xml").send(renderRss(messages, feedBase(req)));
});

app.get("/feed.json", (req, res) => {
  const base = feedBase(req);
  const messages = store.publicMessages(feedFilter(req.query as Record<string, unknown>), 50);
  res.type("application/feed+json").json(renderJsonFeed(messages, base, `${base}/feed.json`));
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

// --- error handler: a malformed JSON body makes express.json() throw. Without
// this, Express's default handler dumps a stack trace to the logs on every junk
// request (bots, probes, broken clients). Turn it into a clean 400 instead.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const e = err as { type?: string; status?: number; statusCode?: number } | null;
  const isBadBody = e?.type === "entity.parse.failed" || err instanceof SyntaxError;
  if (res.headersSent) return next(err);
  const status = isBadBody ? 400 : e?.status ?? e?.statusCode ?? 500;
  const message = isBadBody ? "Parse error: request body is not valid JSON" : "internal server error";
  res.status(status).json({ jsonrpc: "2.0", error: { code: isBadBody ? -32700 : -32603, message }, id: null });
});

// Always bind all interfaces — every place this runs (Railway, Docker, k8s)
// needs the platform router to reach the container.
const httpServer = app.listen(cfg.port, "0.0.0.0", () => {
  const authNote = cfg.allowNoAuth ? "\x1b[33mNO AUTH (dev)\x1b[0m" : "bearer-token auth";
  console.log(`agent-bus listening on http://0.0.0.0:${cfg.port}  ·  MCP at POST /mcp  ·  ${authNote}  ·  db ${cfg.dbPath}`);
});

function shutdown() {
  stopWatcher?.();
  httpServer.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
