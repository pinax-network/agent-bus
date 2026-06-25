# Design brief — landing page revamp

A prompt for Claude Code to redesign the live fleet monitor at [`web/index.html`](./index.html).
Paste the block below (or hand Claude Code this file) to kick off a design pass.

---

Revamp the visual design of the claude-agent-bus landing page at `web/index.html`.
Start by loading the `artifact-design` skill and applying its process (brainstorm a
token system, critique it, commit a palette, then build).

## What this page is

A live fleet monitor for claude-agent-bus — an MCP coordination server where
multiple Claude Code agents on separate hosts register, pass messages, and claim
work. This page visualizes that fleet in real time. It's served directly by our
own Express server (not a sandboxed artifact), but **keep it fully self-contained**:
one HTML file, all CSS/JS inline, **no** external fonts/CDNs/network calls beyond the
same-origin endpoints below. It must work offline-of-the-internet.

## Aesthetic direction

Retro / sketchy / hand-drawn terminal vibe. Monochrome dark: dark grey + off-white,
maybe one restrained accent. ASCII stick-figure agents are the centerpiece — lean
into the CRT/teletype feeling (scanlines, phosphor glow, blinking cursor, monospace).
Think "old terminal meets a sketchbook," not a polished SaaS dashboard. Playful and
alive, but legible and not noisy. Surprise me with the execution — the current
version is a rough first pass, treat it as a starting point, not a spec to preserve.

## Data contract (do not change the endpoints)

- `GET /stats` (public, poll ~2.5s):
  ```
  {
    now, staleAfter,
    agents: [{name, online, status, host, lastSeen}],
    messages: { total, edges: [{sender, recipient, count, lastTs}] },  // recipient "*" = broadcast
    claims  // integer count
  }
  ```
- `GET /board` (requires `Authorization: Bearer <token>`, poll ~3s once unlocked):
  ```
  { agents:[...full], claims:[...full], messages:[{id, ts, sender, recipient, body, data}] }
  ```
- `GET /SKILL.md` (public): the usage protocol as raw markdown text.

## Behaviors that MUST remain

1. ASCII stick-figure agents: online = lively/bright, offline/stale = dimmed.
   Show name + status. Handle 1 to ~20 agents gracefully (responsive wrap).
2. Animated message **flow**: when an edge's count grows between polls, animate
   something traveling sender→recipient (broadcasts `"*"` fan out to all others) and
   react on the figures. On first load, set a baseline — do **not** animate historical
   messages as a burst.
3. Live counters: online / agents / messages / claims.
4. A "who's talking to whom" flow read-out derived from `messages.edges`.
5. Privacy model: message **bodies** are hidden by default. A token box ("unlock"/
   "decrypt") takes `AGENT_BUS_TOKEN`, then fetches `/board` to reveal a live message
   feed with bodies. Token stays in the browser tab only (in-memory, never stored).
   Handle 401 (wrong token) with a clear error + re-lock. Include a re-lock action.
6. `SKILL.md` is viewable inline (fetched from `/SKILL.md`) plus a raw link.

## Constraints

- Mobile-friendly: never let the page scroll horizontally; wide content (flow lines,
  message bodies, the SKILL.md block) scrolls inside its own container.
- Escape all server-provided strings (agent names, statuses, message bodies) — they
  are untrusted input.
- Graceful degradation: if `/stats` fetch fails transiently, keep the last view; if
  there are zero agents/messages, show a tasteful empty state.
- Set a good `<title>`.

When done, verify it renders and the animation fires by running the server with a
couple of seeded agents/messages (`AGENT_BUS_ALLOW_NO_AUTH=1`, `AGENT_BUS_DB=:memory:`).
