// The release-watcher: an in-process poller that lives inside the bus. On an
// interval it reads the watchlist, asks the GitHub API for each active repo's
// latest release, and — when a repo's release tag changes — posts a PUBLIC
// broadcast onto the bus. Those broadcasts land in agents' inboxes and on the
// /feed.xml + /feed.json feeds. State (the last tag seen per repo) lives in the
// bus's SQLite file, so a restart never re-announces or misses a release.
//
// It runs in-process deliberately: there's no separate CronJob to deploy, the
// k8s manifest stays static, and the source + watchlist config live here in
// agent-bus. Disabled unless AGENT_BUS_WATCH=1 and a GITHUB_TOKEN is present.

import type { BusStore } from "./db.ts";
import { loadWatchlist, watchableRepos, type WatchlistEntry } from "./watchlist.ts";

/** The agent name the watcher posts under (appears on the board + as feed author). */
export const WATCHER_AGENT = "release-watcher";

export interface WatcherOptions {
  /** Path to the validated watchlist.json. */
  watchlistPath: string;
  /** GitHub token — for the 5000/hr authenticated rate limit and private repos. */
  githubToken: string;
  /** Milliseconds between full polls. */
  intervalMs: number;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Injected for tests; defaults to console.log with a prefix. */
  log?: (msg: string) => void;
}

interface LatestRelease {
  tag: string;
  url: string | null;
  name: string | null;
  publishedAt: string | null;
}

interface PollSummary {
  checked: number;
  announced: number;
  seeded: number;
  noRelease: number;
  errors: number;
  rateLimited: boolean;
}

const GITHUB_API = "https://api.github.com";
const POLL_CONCURRENCY = 8;

/** Fetch a repo's latest release. null = no published release (404). Throws on rate limit/other. */
async function fetchLatestRelease(repo: string, token: string, fetchFn: typeof fetch): Promise<LatestRelease | null> {
  const res = await fetchFn(`${GITHUB_API}/repos/${repo}/releases/latest`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-bus-release-watcher",
    },
  });
  if (res.status === 404) return null; // repo has no published releases
  if (res.status === 403 || res.status === 429) {
    const err = new Error(`rate limited (${res.status})`) as Error & { rateLimited?: boolean };
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${repo}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string; name?: string; published_at?: string };
  if (!body.tag_name) return null;
  return {
    tag: body.tag_name,
    url: body.html_url ?? null,
    name: body.name ?? null,
    publishedAt: body.published_at ?? null,
  };
}

/** Build the public broadcast body + structured data for a new release. */
function releaseMessage(repo: WatchlistEntry & { github_full_name: string }, rel: LatestRelease) {
  const label = rel.name && rel.name !== rel.tag ? `${rel.tag} — ${rel.name}` : rel.tag;
  return {
    body: `${repo.github_full_name} ${label}`,
    data: {
      kind: "github_release",
      repo: repo.github_full_name,
      tag: rel.tag,
      url: rel.url ?? repo.url,
      name: rel.name,
      published_at: rel.publishedAt,
      domain: repo.domain,
      component: repo.component,
      assignee: repo.assignee,
    },
  };
}

/** Run `tasks` with bounded concurrency, preserving order of completion side effects. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * One full pass over the watchable repos. Seeds (records without announcing) the
 * first time a repo is seen, and broadcasts a public message when a repo's tag
 * changes thereafter. Returns a summary; stops early if GitHub rate-limits us.
 */
export async function pollOnce(store: BusStore, opts: WatcherOptions): Promise<PollSummary> {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((m) => console.log(`[watcher] ${m}`));
  const repos = watchableRepos(loadWatchlist(opts.watchlistPath));
  const summary: PollSummary = { checked: 0, announced: 0, seeded: 0, noRelease: 0, errors: 0, rateLimited: false };

  await pool(repos, POLL_CONCURRENCY, async (repo) => {
    if (summary.rateLimited) return; // drain remaining workers without more calls
    try {
      const rel = await fetchLatestRelease(repo.github_full_name, opts.githubToken, fetchFn);
      summary.checked++;
      if (!rel) {
        summary.noRelease++;
        return;
      }
      const seen = store.getSeenRelease(repo.github_full_name);
      if (seen === null) {
        // First time we've looked at this repo — remember where it is, stay quiet.
        store.setSeenRelease(repo.github_full_name, rel.tag);
        summary.seeded++;
        return;
      }
      if (seen !== rel.tag) {
        const { body, data } = releaseMessage(repo, rel);
        store.send(WATCHER_AGENT, "*", body, data, "public");
        store.setSeenRelease(repo.github_full_name, rel.tag);
        summary.announced++;
        log(`announced ${body}`);
      }
    } catch (e) {
      const err = e as Error & { rateLimited?: boolean };
      if (err.rateLimited) {
        summary.rateLimited = true;
        log(`rate limited — backing off until next cycle`);
      } else {
        summary.errors++;
        log(`error checking ${repo.github_full_name}: ${err.message}`);
      }
    }
  });

  return summary;
}

/**
 * Start the watcher loop. Registers the watcher as an agent, polls immediately,
 * then every `intervalMs`. Returns a stop function. Caller is responsible for
 * deciding whether to start it at all (see config.watch).
 */
export function startWatcher(store: BusStore, opts: WatcherOptions): () => void {
  const log = opts.log ?? ((m) => console.log(`[watcher] ${m}`));
  store.register(WATCHER_AGENT, "agent-bus", ["github-releases"], "watching releases");

  let running = false;
  const cycle = async () => {
    if (running) return; // never overlap a slow poll with the next tick
    running = true;
    try {
      store.heartbeat(WATCHER_AGENT, "polling GitHub releases");
      const s = await pollOnce(store, opts);
      store.heartbeat(WATCHER_AGENT, `idle — checked ${s.checked}, announced ${s.announced}`);
      log(
        `cycle done: checked ${s.checked}, announced ${s.announced}, seeded ${s.seeded}, ` +
          `no-release ${s.noRelease}, errors ${s.errors}${s.rateLimited ? ", RATE LIMITED" : ""}`,
      );
    } catch (e) {
      log(`cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  void cycle();
  const timer = setInterval(() => void cycle(), opts.intervalMs);
  log(`started — polling every ${Math.round(opts.intervalMs / 1000)}s as '${WATCHER_AGENT}'`);
  return () => clearInterval(timer);
}
