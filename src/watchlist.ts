// The watchlist: the set of repositories the release-watcher tracks. It is the
// maintained source of truth (converted once from a Google Sheet export) and is
// validated against this schema — a malformed edit fails the schema test in CI.
//
// Each entry describes one repo. The watcher only acts on entries that are
// `active` with `watch: "releases"`; everything else (paused repos, repos with
// no GitHub home like MegaETH, tag-only repos) is recorded here so the list
// stays the single source of truth, including the things we deliberately skip.

import { z } from "zod";
import { readFileSync } from "node:fs";

/** What kind of GitHub activity to watch for a repo. v1 only acts on "releases". */
export const WatchKind = z.enum(["releases", "tags", "none"]);
export type WatchKind = z.infer<typeof WatchKind>;

export const WatchlistEntry = z.object({
  /** "owner/repo" — the GitHub API target. null when the repo has no GitHub home. */
  github_full_name: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "must be 'owner/repo'")
    .nullable(),
  /** Canonical URL (may be a /tags page or a non-GitHub link). */
  url: z.string().url().nullable(),
  /** Grouping facets, surfaced as feed categories. */
  domain: z.string().nullable(),
  component: z.string().nullable(),
  /** Person responsible. null = unassigned / paused. */
  assignee: z.string().nullable(),
  /** Whether the watcher should consider this entry at all. */
  active: z.boolean(),
  /** Which activity to watch. */
  watch: WatchKind,
  default_branch: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  stars: z.number().int().nonnegative().nullable(),
  /** Free-form human note (e.g. why a repo is inactive or special-cased). */
  note: z.string().optional(),
});
export type WatchlistEntry = z.infer<typeof WatchlistEntry>;

export const Watchlist = z.object({
  repos: z.array(WatchlistEntry),
});
export type Watchlist = z.infer<typeof Watchlist>;

/** Parse + validate a watchlist object, throwing a readable error on mismatch. */
export function parseWatchlist(raw: unknown): Watchlist {
  return Watchlist.parse(raw);
}

/** Load and validate the watchlist JSON from disk. */
export function loadWatchlist(path: string): Watchlist {
  return parseWatchlist(JSON.parse(readFileSync(path, "utf8")));
}

/** The repos the watcher should actually poll right now (active + releases). */
export function watchableRepos(list: Watchlist): (WatchlistEntry & { github_full_name: string })[] {
  return list.repos.filter(
    (r): r is WatchlistEntry & { github_full_name: string } =>
      r.active && r.watch === "releases" && r.github_full_name !== null,
  );
}
