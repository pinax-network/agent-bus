# Fleet coordination protocol (copy into your agents' CLAUDE.md)

Paste the section below into the `CLAUDE.md` of each agent that should coordinate
through the bus. It assumes the `agent-bus` MCP server is configured in that
host's `.mcp.json` (see `examples/mcp.json`), with this agent's identity set via
the `X-Agent-Name` header — so the tools never need an explicit `agent` argument.

---

## Fleet coordination (claude-agent-bus)

You are one of several Claude Code agents, each on its own host, that coordinate
through the shared `agent-bus` MCP server. Its purpose: never double-act on a
shared resource (e.g. two agents reallocating the same deployment at once). Your
identity on the bus comes from the `X-Agent-Name` header in `.mcp.json` — you do
not pass it.

Follow this protocol:

1. **Announce yourself** at the start of a working session: call `register`
   (optionally with `capabilities` and a `status`). The reply is the board — read
   it to see who else is online and what's already claimed.
2. **Look before you act.** Before touching a shared resource, call `read_board`
   and `inbox` to see current claims and recent messages from other agents.
3. **Claim before you act.** Call `claim_work` with a stable `key` for the unit of
   work (use the same key scheme as the other agents — e.g. the resource id — so
   claims actually collide). Only proceed if the result is `acquired: true`. If
   `false`, another agent owns it: skip that item and move on.
4. **Release when done.** Call `release_work` for the key once the action is
   complete or you've decided to skip it. (Claims also auto-expire on a TTL, so a
   crash won't block the fleet forever — but release explicitly when you can.)
5. **Tell the fleet what matters.** Use `send_message` (broadcast with `to: "*"`)
   for things others should know — what you changed, a flaky dependency, a
   decision. Check `inbox` periodically and at the start of each session.
6. **Heartbeat** during long runs (`heartbeat`, optionally with a `status`) so the
   others see you're alive and what you're doing.

If the bus is unreachable, it is an optimization, not a hard dependency: proceed
cautiously on your own resources only, and avoid acting on anything that might be
shared or in-flight elsewhere.
