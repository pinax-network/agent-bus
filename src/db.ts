// The entire shared state of the bus lives in one SQLite file: who's online
// (agents), the mailbox (messages), and work claims (claims). The server is a
// single process with one writer, and bun:sqlite runs synchronously, so there
// are no cross-request races — the claim upsert is still written defensively
// (atomic ON CONFLICT) so it's correct regardless of how it's called.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AgentRow {
  name: string;
  host: string | null;
  capabilities: string[];
  status: string | null;
  data: unknown;
  registered_at: number;
  last_seen: number;
  online: boolean;
}

/**
 * Who may read a message's body. `private` (the default) is the original
 * behaviour: bodies surface only through the token-gated board and inbox.
 * `public` additionally projects the message onto the unauthenticated feed
 * (RSS/JSON) and shows its body on the landing page — for things meant to be
 * broadcast beyond the fleet, e.g. GitHub release alerts.
 */
export type Visibility = "private" | "public";

export interface MessageRow {
  id: number;
  ts: number;
  sender: string;
  recipient: string; // agent name, or "*" for broadcast
  body: string;
  data: unknown;
  visibility: Visibility;
}

/** Match against a public message's structured `data` for feed filtering. */
export interface FeedFilter {
  assignee?: string;
  domain?: string;
  kind?: string;
}

export interface ClaimRow {
  key: string;
  owner: string;
  note: string | null;
  claimed_at: number;
  expires_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  name          TEXT PRIMARY KEY,
  host          TEXT,
  capabilities  TEXT NOT NULL DEFAULT '[]',
  status        TEXT,
  data          TEXT,
  registered_at INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  sender     TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  body       TEXT NOT NULL,
  data       TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient, id);

CREATE TABLE IF NOT EXISTS claims (
  key        TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  note       TEXT,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER
);
`;

export class BusStore {
  private db: Database;
  /** Seconds without a heartbeat before an agent is reported offline. */
  private staleAfter: number;

  constructor(dbPath: string, staleAfter = 120) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
    this.staleAfter = staleAfter;
  }

  /**
   * Idempotent schema upgrades for databases created before a column existed.
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so new columns
   * have to be added explicitly. Safe to run on every startup.
   */
  private migrate(): void {
    const cols = (this.db.query(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("visibility")) {
      this.db.exec(`ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`);
    }
    // Index creation references the column, so it must follow the ALTER above.
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_visibility ON messages (visibility, id)`);
  }

  private now(): number {
    return Date.now();
  }

  // ---- agents / presence -------------------------------------------------

  /** Create or update an agent's registration; refreshes last_seen. */
  register(name: string, host?: string, capabilities: string[] = [], status?: string, data?: unknown): AgentRow {
    const now = this.now();
    this.db
      .query(
        `INSERT INTO agents (name, host, capabilities, status, data, registered_at, last_seen)
         VALUES ($name, $host, $caps, $status, $data, $now, $now)
         ON CONFLICT(name) DO UPDATE SET
           host = COALESCE($host, agents.host),
           capabilities = $caps,
           status = COALESCE($status, agents.status),
           data = COALESCE($data, agents.data),
           last_seen = $now`,
      )
      .run({
        $name: name,
        $host: host ?? null,
        $caps: JSON.stringify(capabilities),
        $status: status ?? null,
        $data: data === undefined ? null : JSON.stringify(data),
        $now: now,
      });
    return this.getAgent(name)!;
  }

  /** Bump last_seen (and optionally status/data) for a heartbeat. */
  heartbeat(name: string, status?: string, data?: unknown): AgentRow | null {
    const now = this.now();
    const res = this.db
      .query(
        `UPDATE agents SET last_seen = $now,
           status = COALESCE($status, status),
           data = COALESCE($data, data)
         WHERE name = $name`,
      )
      .run({ $name: name, $now: now, $status: status ?? null, $data: data === undefined ? null : JSON.stringify(data) });
    if (res.changes === 0) return null;
    return this.getAgent(name);
  }

  getAgent(name: string): AgentRow | null {
    const row = this.db.query(`SELECT * FROM agents WHERE name = $name`).get({ $name: name }) as
      | Record<string, unknown>
      | null;
    return row ? this.toAgent(row) : null;
  }

  listAgents(): AgentRow[] {
    const rows = this.db.query(`SELECT * FROM agents ORDER BY name`).all() as Record<string, unknown>[];
    return rows.map((r) => this.toAgent(r));
  }

  private toAgent(r: Record<string, unknown>): AgentRow {
    const lastSeen = Number(r.last_seen);
    return {
      name: String(r.name),
      host: (r.host as string) ?? null,
      capabilities: safeJson(r.capabilities, []),
      status: (r.status as string) ?? null,
      data: safeJson(r.data, null),
      registered_at: Number(r.registered_at),
      last_seen: lastSeen,
      online: this.now() - lastSeen <= this.staleAfter * 1000,
    };
  }

  // ---- messages / mailbox ------------------------------------------------

  /**
   * Post a message. `recipient` is an agent name or "*" for broadcast.
   * `visibility` defaults to "private" (board/inbox only); "public" also
   * projects the message onto the unauthenticated feed.
   */
  send(sender: string, recipient: string, body: string, data?: unknown, visibility: Visibility = "private"): MessageRow {
    const now = this.now();
    const res = this.db
      .query(`INSERT INTO messages (ts, sender, recipient, body, data, visibility) VALUES ($ts, $s, $r, $b, $d, $v)`)
      .run({
        $ts: now,
        $s: sender,
        $r: recipient,
        $b: body,
        $d: data === undefined ? null : JSON.stringify(data),
        $v: visibility,
      });
    return this.getMessage(Number(res.lastInsertRowid))!;
  }

  private getMessage(id: number): MessageRow | null {
    const row = this.db.query(`SELECT * FROM messages WHERE id = $id`).get({ $id: id }) as Record<string, unknown> | null;
    return row ? this.toMessage(row) : null;
  }

  /**
   * Messages addressed to `name` (direct) or broadcast (recipient "*"), with
   * id > since. Broadcasts don't echo back to their own sender. Ordered oldest
   * first so the caller can advance its cursor to the last id returned.
   */
  inbox(name: string, since = 0, limit = 100): MessageRow[] {
    const rows = this.db
      .query(
        `SELECT * FROM messages
         WHERE id > $since AND (recipient = $name OR (recipient = '*' AND sender != $name))
         ORDER BY id ASC LIMIT $limit`,
      )
      .all({ $since: since, $name: name, $limit: limit }) as Record<string, unknown>[];
    return rows.map((r) => this.toMessage(r));
  }

  /**
   * Aggregate message flow for the public landing page: a total count and one
   * edge per (sender → recipient) pair with a count and the last timestamp.
   * Deliberately returns NO message bodies — it answers "who is talking to
   * whom, how much" without revealing what was said.
   */
  messageStats(): { total: number; edges: { sender: string; recipient: string; count: number; lastTs: number }[] } {
    const total = Number((this.db.query(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c);
    const edges = this.db
      .query(
        `SELECT sender, recipient, COUNT(*) AS count, MAX(ts) AS lastTs
         FROM messages GROUP BY sender, recipient ORDER BY lastTs DESC`,
      )
      .all() as { sender: string; recipient: string; count: number; lastTs: number }[];
    return { total, edges: edges.map((e) => ({ ...e, count: Number(e.count), lastTs: Number(e.lastTs) })) };
  }

  /** Most recent messages across all recipients — for the board view. */
  recentMessages(limit = 25): MessageRow[] {
    const rows = this.db.query(`SELECT * FROM messages ORDER BY id DESC LIMIT $limit`).all({ $limit: limit }) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.toMessage(r)).reverse();
  }

  /**
   * Public messages, newest first, optionally filtered by fields inside their
   * structured `data` (assignee / domain / kind). Backs the unauthenticated
   * RSS/JSON feed. Only `visibility = 'public'` rows are ever returned.
   */
  publicMessages(filter: FeedFilter = {}, limit = 50): MessageRow[] {
    const where = [`visibility = 'public'`];
    const params: Record<string, string | number> = { $limit: limit };
    if (filter.assignee) {
      where.push(`json_extract(data, '$.assignee') = $assignee`);
      params.$assignee = filter.assignee;
    }
    if (filter.domain) {
      where.push(`json_extract(data, '$.domain') = $domain`);
      params.$domain = filter.domain;
    }
    if (filter.kind) {
      where.push(`json_extract(data, '$.kind') = $kind`);
      params.$kind = filter.kind;
    }
    const rows = this.db
      .query(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT $limit`)
      .all(params) as Record<string, unknown>[];
    return rows.map((r) => this.toMessage(r));
  }

  private toMessage(r: Record<string, unknown>): MessageRow {
    return {
      id: Number(r.id),
      ts: Number(r.ts),
      sender: String(r.sender),
      recipient: String(r.recipient),
      body: String(r.body),
      data: safeJson(r.data, null),
      visibility: (r.visibility as Visibility) ?? "private",
    };
  }

  // ---- claims ------------------------------------------------------------

  /**
   * Atomically claim `key` for `owner`. Succeeds when the key is free, already
   * held by the same owner (renewal), or held by someone whose claim has
   * expired. Returns the resulting claim plus whether THIS caller now owns it.
   */
  claim(key: string, owner: string, ttl: number, note?: string): { claim: ClaimRow; acquired: boolean } {
    const now = this.now();
    const expires = ttl > 0 ? now + ttl * 1000 : null;
    this.db
      .query(
        `INSERT INTO claims (key, owner, note, claimed_at, expires_at)
         VALUES ($key, $owner, $note, $now, $exp)
         ON CONFLICT(key) DO UPDATE SET
           owner = excluded.owner,
           note = excluded.note,
           claimed_at = excluded.claimed_at,
           expires_at = excluded.expires_at
         WHERE claims.owner = excluded.owner
            OR (claims.expires_at IS NOT NULL AND claims.expires_at < $now)`,
      )
      .run({ $key: key, $owner: owner, $note: note ?? null, $now: now, $exp: expires });
    const claim = this.getClaim(key)!;
    return { claim, acquired: claim.owner === owner && claim.claimed_at === now };
  }

  /** Release a claim, but only if `owner` holds it. Returns true if released. */
  release(key: string, owner: string): boolean {
    const res = this.db.query(`DELETE FROM claims WHERE key = $key AND owner = $owner`).run({ $key: key, $owner: owner });
    return res.changes > 0;
  }

  getClaim(key: string): ClaimRow | null {
    const row = this.db.query(`SELECT * FROM claims WHERE key = $key`).get({ $key: key }) as Record<string, unknown> | null;
    return row ? this.toClaim(row) : null;
  }

  /** All live claims (expired ones are filtered out and lazily reaped). */
  listClaims(): ClaimRow[] {
    const now = this.now();
    this.db.query(`DELETE FROM claims WHERE expires_at IS NOT NULL AND expires_at < $now`).run({ $now: now });
    const rows = this.db.query(`SELECT * FROM claims ORDER BY key`).all() as Record<string, unknown>[];
    return rows.map((r) => this.toClaim(r));
  }

  private toClaim(r: Record<string, unknown>): ClaimRow {
    return {
      key: String(r.key),
      owner: String(r.owner),
      note: (r.note as string) ?? null,
      claimed_at: Number(r.claimed_at),
      expires_at: r.expires_at == null ? null : Number(r.expires_at),
    };
  }

  close(): void {
    this.db.close();
  }
}

function safeJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
