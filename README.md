# claude-agent-bus

A tiny **MCP coordination server** for a fleet of [Claude Code](https://claude.com/claude-code) agents running on **separate hosts**. It gives independently-started agents a shared place to see each other, pass messages, and claim work so they don't step on each other.

One process, one SQLite file, one HTTP endpoint. Each agent connects to it through its host's `.mcp.json` and gets a handful of tools: a shared board, a mailbox, and an atomic work-claim lock.

```
   host A: claude ─┐
   host B: claude ─┼──  HTTP + bearer token  ──▶   claude-agent-bus   ──▶   agent-bus.db (SQLite)
   host C: claude ─┘        (each sends X-Agent-Name)      one instance, one file
```

## Why this exists

Claude Code's built-in multi-agent features don't cover this case:

- **Subagents** (the `Agent`/`Task` tool) are children of one session — they report only to their parent and can't talk to each other or to other top-level sessions.
- **Agent Teams** (experimental) coordinate multiple sessions under a single local lead — not independent CLIs started on different machines.
- **Separate top-level CLIs on separate hosts** have **no built-in channel between them.**

So when you have, say, three Graph indexers each running their own Claude Code agent on their own box, there's nothing native that lets them coordinate. This is the thin shared layer they all touch: domain-agnostic, one small service, no host is special at the app level.

## What an agent can do

Once connected, each agent gets these tools:

| Tool | What it does |
| --- | --- |
| `register` | Announce this agent (name, host, capabilities) and get the board back. Call at startup. |
| `heartbeat` | Refresh liveness + optional status. Call periodically while working. |
| `post_status` | Set a human-readable status line. |
| `read_board` | The full snapshot: every agent (with an online flag), all live claims, recent messages. |
| `send_message` | Message one agent by name, or broadcast with `to: "*"`. |
| `inbox` | Read messages addressed to you or broadcast, since a cursor. |
| `claim_work` | **Atomically** claim a key (e.g. a deployment id) so no two agents act on it at once. |
| `release_work` | Release a claim you hold (completing work = releasing it). |

**Identity:** each agent identifies itself with the `X-Agent-Name` header (set once in `.mcp.json`), so tools rarely need an explicit `agent` argument. An explicit arg overrides the header.

**Claims are exclusive and self-healing:** a claim succeeds only if the key is free, already yours (renews), or held by an agent whose claim has **expired**. Claims auto-expire after a TTL (default 15 min) so a crashed agent can't hold a key forever.

**Messaging is poll-based:** MCP is request/response — there's no server push. Agents read their `inbox` when they next act. For coordination at human/allocation cadence (seconds to minutes) that's exactly right.

## Run it

The bus runs as **one instance** on a host every agent can reach. Pick the most stable host or a neutral one, and put it behind your DNS/reverse proxy.

### Docker (recommended)

```bash
export AGENT_BUS_TOKEN=$(openssl rand -hex 32)
docker compose up -d
```

### Bun (local / bare metal)

```bash
bun install
AGENT_BUS_TOKEN=$(openssl rand -hex 32) bun run start
# dev, no auth, auto-reload:
AGENT_BUS_ALLOW_NO_AUTH=1 bun run dev
```

Check it's up (unauthenticated):

```bash
curl https://agents.example.com/health
# {"ok":true,"service":"claude-agent-bus","agents":2,"online":["pinax1","pinax2"],"claims":1}
```

## Connect each agent

Drop this into each host's `.mcp.json` (project `./.mcp.json` or user `~/.claude/.mcp.json`), changing **`X-Agent-Name` per host** and pointing `url` at your single bus instance. See [`examples/mcp.json`](examples/mcp.json).

```json
{
  "mcpServers": {
    "agent-bus": {
      "type": "http",
      "url": "https://agents.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENT_BUS_TOKEN}",
        "X-Agent-Name": "pinax1"
      }
    }
  }
}
```

`${AGENT_BUS_TOKEN}` is expanded from the environment by Claude Code, so the secret stays out of the file. Set the same token on every host and on the server.

A good pattern: tell each agent (via `CLAUDE.md` or a startup nudge) to `register` on startup, `read_board`/`inbox` before acting, `claim_work` before touching a shared resource, and `release_work` when done.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `AGENT_BUS_TOKEN` | — | **Required.** Shared bearer token. Server refuses to start without it (unless `AGENT_BUS_ALLOW_NO_AUTH=1`). |
| `AGENT_BUS_ALLOW_NO_AUTH` | `0` | Run with no auth — **local dev only.** |
| `PORT` | `7077` | HTTP listen port. |
| `AGENT_BUS_HOST` | `0.0.0.0` | Bind interface. |
| `AGENT_BUS_DB` | `data/agent-bus.db` | SQLite file — the entire shared state. |
| `AGENT_BUS_CLAIM_TTL` | `900` | Default claim TTL (seconds). `0` = never expire. |
| `AGENT_BUS_STALE_AFTER` | `120` | Seconds without a heartbeat before an agent is reported offline. |

## Design notes

- **Transport:** stateless [streamable HTTP](https://modelcontextprotocol.io/) (`POST /mcp`). Each request is self-contained, so a server restart never strands a session and there's nothing to reconnect.
- **Storage:** a single SQLite file (`bun:sqlite`, WAL mode). One process, one writer — no cross-request races. The claim is still written as an atomic `INSERT … ON CONFLICT … WHERE` so it's correct regardless. Back up the file and you've backed up the whole bus.
- **Security:** a shared bearer token on every request (`/health` is the only open endpoint). It will sit on a network-reachable host — always run it behind TLS and keep the token secret. The token is a coarse gate, not per-agent auth; anyone with it can act as any agent name.
- **Scope:** deliberately small. No persistence guarantees beyond the SQLite file, no RBAC, no rate limiting. It's a coordination primitive, not a message broker.

## Develop

```bash
bun test          # unit tests for the store (presence, mailbox, claims)
bun run typecheck # tsc --noEmit
bun run dev       # auto-reload, AGENT_BUS_ALLOW_NO_AUTH=1 for no token
```

## License

MIT
