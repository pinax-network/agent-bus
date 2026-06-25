// Runtime configuration, read from the environment with sensible defaults.

export interface Config {
  /** TCP port the HTTP server listens on. */
  port: number;
  /** SQLite file path. The whole bus is one file — back it up and you have everything. */
  dbPath: string;
  /**
   * Shared bearer token. Every request must send `Authorization: Bearer <token>`.
   * REQUIRED in production — the server refuses to start without it unless
   * AGENT_BUS_ALLOW_NO_AUTH=1 (only for local dev). Set via AGENT_BUS_TOKEN.
   */
  token: string | null;
  /** When true, run with no auth (local dev only). */
  allowNoAuth: boolean;
  /**
   * Default claim TTL in seconds. A claim auto-expires after this so a crashed
   * agent can't hold a deployment forever. 0 = claims never expire. Per-claim
   * override via the `ttl` tool argument.
   */
  defaultClaimTtl: number;
  /** Mark an agent stale (offline) after this many seconds without a heartbeat. */
  staleAfter: number;
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const allowNoAuth = env.AGENT_BUS_ALLOW_NO_AUTH === "1" || env.AGENT_BUS_ALLOW_NO_AUTH === "true";
  const token = env.AGENT_BUS_TOKEN?.trim() || null;
  if (!token && !allowNoAuth) {
    throw new Error(
      "AGENT_BUS_TOKEN is not set. Set a shared bearer token, or pass AGENT_BUS_ALLOW_NO_AUTH=1 for local dev only.",
    );
  }
  return {
    port: num(env.PORT ?? env.AGENT_BUS_PORT, 7077),
    dbPath: env.AGENT_BUS_DB ?? "data/agent-bus.db",
    token,
    allowNoAuth,
    defaultClaimTtl: num(env.AGENT_BUS_CLAIM_TTL, 900), // 15 min
    staleAfter: num(env.AGENT_BUS_STALE_AFTER, 120), // 2 min
  };
}
