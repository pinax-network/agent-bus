// A tiny leveled logger — no dependencies, matching the rest of agent-bus.
// Each line is `<iso-ts> <LEVEL> <msg> key=val key=val…`, coloured on a TTY so
// it's readable when you're tailing the server, and greppable when you're not.
//
// Verbosity is controlled by AGENT_BUS_LOG_LEVEL (debug|info|warn|error,
// default "info"). Set it to "debug" to see every agent action — registers,
// heartbeats, messages, inbox polls, claims — as it happens.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // grey
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

// Honour TTY for colour; plain text when piped to a file or log collector.
const useColor = Boolean(process.stdout.isTTY);

let threshold = ORDER.info;

export function parseLevel(v: string | undefined): LogLevel {
  const l = (v ?? "").trim().toLowerCase();
  return l === "debug" || l === "info" || l === "warn" || l === "error" ? l : "info";
}

/** Set the minimum level that is emitted. Levels below it are dropped. */
export function setLevel(level: LogLevel): void {
  threshold = ORDER[level];
}

/** Render structured fields as ` key=val`, JSON-encoding anything non-scalar. */
function fmtFields(fields?: Record<string, unknown>): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let val: string;
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      val = String(v);
    } else if (typeof v === "string") {
      // Quote strings containing spaces so the k=v pairs stay parseable.
      val = /\s/.test(v) ? JSON.stringify(v) : v;
    } else {
      val = JSON.stringify(v);
    }
    parts.push(`${k}=${val}`);
  }
  if (!parts.length) return "";
  const joined = parts.join(" ");
  return " " + (useColor ? `${DIM}${joined}${RESET}` : joined);
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${DIM}${ts}${RESET} ${COLORS[level]}${tag}${RESET}` : `${ts} ${tag}`;
  const line = `${head} ${msg}${fmtFields(fields)}`;
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
