// Builds the MCP server surface: the tools a Claude Code agent calls to
// coordinate with the rest of the fleet. The server is rebuilt per request
// (stateless HTTP transport), so we close over the caller's identity (the
// X-Agent-Name header) — every tool defaults its acting agent to that, with an
// explicit `agent` argument as override.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BusStore } from "./db.ts";
import type { Config } from "./config.ts";

/** The bus version, surfaced over MCP and on the HTTP endpoints / UI. */
export const VERSION = "0.3.3";

/** JSON → MCP text content. Agents parse the JSON; humans can read it too. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

export function buildMcpServer(store: BusStore, cfg: Config, identity: string | null): McpServer {
  const server = new McpServer({ name: "agent-bus", version: VERSION });

  /** Resolve who is acting: explicit arg wins, else the header identity. */
  const who = (arg?: string): string | null => (arg && arg.trim()) || identity || null;

  server.registerTool(
    "register",
    {
      title: "Register / announce this agent",
      description:
        "Announce this agent to the fleet (or update its registration) and refresh its heartbeat. " +
        "Call this once at startup. Returns the current board so you immediately see who else is online, " +
        "what work is claimed, and recent messages. The agent name defaults to the X-Agent-Name header.",
      inputSchema: {
        agent: z.string().optional().describe("This agent's stable name (e.g. 'pinax1'). Defaults to the X-Agent-Name header."),
        host: z.string().optional().describe("Host/machine identifier this agent runs on."),
        capabilities: z.array(z.string()).optional().describe("Free-form tags describing what this agent can do."),
        status: z.string().optional().describe("Initial human-readable status line."),
      },
    },
    async ({ agent, host, capabilities, status }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      store.register(name, host, capabilities ?? [], status);
      return json(board(store, cfg));
    },
  );

  server.registerTool(
    "heartbeat",
    {
      title: "Heartbeat",
      description:
        "Refresh this agent's liveness (so the fleet knows it's still online) and optionally update its status. " +
        "Returns a compact board snapshot. Call periodically while working.",
      inputSchema: {
        agent: z.string().optional(),
        status: z.string().optional().describe("Updated human-readable status line."),
        data: z.unknown().optional().describe("Optional structured status payload (any JSON)."),
      },
    },
    async ({ agent, status, data }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      const row = store.heartbeat(name, status, data);
      if (!row) {
        // First heartbeat before register: register implicitly so we never drop a ping.
        store.register(name, undefined, [], status, data);
      }
      return json(board(store, cfg));
    },
  );

  server.registerTool(
    "read_board",
    {
      title: "Read the shared board",
      description:
        "The full coordination snapshot: every known agent (with an online flag), all live work claims, and recent " +
        "messages. Read-only — safe to call any time to see what the fleet is doing.",
      inputSchema: {},
    },
    async () => json(board(store, cfg)),
  );

  server.registerTool(
    "post_status",
    {
      title: "Post a status update",
      description: "Set this agent's human-readable status line (and refresh its heartbeat). Shorthand for heartbeat with a status.",
      inputSchema: {
        agent: z.string().optional(),
        status: z.string().describe("The status line, e.g. 'reallocating QmABC… on pinax1'."),
        data: z.unknown().optional(),
      },
    },
    async ({ agent, status, data }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      if (!store.heartbeat(name, status, data)) store.register(name, undefined, [], status, data);
      return json({ ok: true, agent: name, status });
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message",
      description:
        "Post a message to another agent by name, or broadcast to the whole fleet with to='*' (the default). " +
        "Messages land in the recipient's inbox; they read them with the `inbox` tool. Fire-and-forget — there is no " +
        "delivery push, agents poll their inbox when they act. " +
        "Set visibility='public' to also publish the message on the unauthenticated feed (/feed.xml, /feed.json) and " +
        "the landing page — use it for things meant to be seen beyond the fleet, e.g. release alerts. Default 'private'.",
      inputSchema: {
        from: z.string().optional().describe("Sender name. Defaults to the X-Agent-Name header."),
        to: z.string().optional().describe("Recipient agent name, or '*' to broadcast. Default '*'."),
        body: z.string().describe("Message text."),
        data: z.unknown().optional().describe("Optional structured payload (any JSON)."),
        visibility: z
          .enum(["private", "public"])
          .optional()
          .describe("'private' (default) = board/inbox only. 'public' also publishes to the feed and landing page."),
      },
    },
    async ({ from, to, body, data, visibility }) => {
      const sender = who(from);
      if (!sender) return err("no sender name (pass `from` or set the X-Agent-Name header)");
      const msg = store.send(sender, to?.trim() || "*", body, data, visibility ?? "private");
      return json({ ok: true, message: msg });
    },
  );

  server.registerTool(
    "inbox",
    {
      title: "Read inbox",
      description:
        "Fetch messages addressed to this agent (direct) or broadcast to all, newer than `since`. Returns the messages " +
        "and a `cursor` — pass it back as `since` next time to get only new messages. Your own broadcasts are not echoed back.",
      inputSchema: {
        agent: z.string().optional(),
        since: z.number().int().nonnegative().optional().describe("Last message id you've already seen. Omit for all."),
        limit: z.number().int().positive().max(500).optional(),
      },
    },
    async ({ agent, since, limit }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      const messages = store.inbox(name, since ?? 0, limit ?? 100);
      const cursor = messages.length ? messages[messages.length - 1].id : (since ?? 0);
      return json({ messages, cursor });
    },
  );

  server.registerTool(
    "claim_work",
    {
      title: "Claim a unit of work",
      description:
        "Atomically claim exclusive ownership of a work key (e.g. a deployment id) so no two agents act on it at once. " +
        "Succeeds if the key is free, already yours (renews it), or held by an agent whose claim has expired. " +
        "Returns { acquired } — only act if it's true; otherwise `claim.owner` tells you who holds it. " +
        "Claims auto-expire after `ttl` seconds so a crashed agent can't block work forever.",
      inputSchema: {
        agent: z.string().optional(),
        key: z.string().describe("The work identifier to claim, e.g. a subgraph deployment id."),
        ttl: z.number().int().nonnegative().optional().describe(`Seconds until auto-expiry. Default ${cfg.defaultClaimTtl}. 0 = never.`),
        note: z.string().optional().describe("Optional note about what you're doing with it."),
      },
    },
    async ({ agent, key, ttl, note }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      const { claim, acquired } = store.claim(key, name, ttl ?? cfg.defaultClaimTtl, note);
      return json({ acquired, claim });
    },
  );

  server.registerTool(
    "release_work",
    {
      title: "Release a claim",
      description:
        "Release a work claim you hold (call this when done — completing work = releasing it). Only succeeds if you own " +
        "the claim. Returns { released }.",
      inputSchema: {
        agent: z.string().optional(),
        key: z.string().describe("The work identifier to release."),
      },
    },
    async ({ agent, key }) => {
      const name = who(agent);
      if (!name) return err("no agent name (pass `agent` or set the X-Agent-Name header)");
      const released = store.release(key, name);
      return json({ released, key });
    },
  );

  return server;
}

/** The shared snapshot returned by read_board / register / heartbeat. */
function board(store: BusStore, cfg: Config) {
  const agents = store.listAgents();
  return {
    now: Date.now(),
    staleAfterSeconds: cfg.staleAfter,
    agents,
    online: agents.filter((a) => a.online).map((a) => a.name),
    claims: store.listClaims(),
    recentMessages: store.recentMessages(25),
  };
}
