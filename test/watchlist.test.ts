import { test, expect } from "bun:test";
import { loadWatchlist, parseWatchlist, watchableRepos } from "../src/watchlist.ts";

const WATCHLIST = new URL("../watchlist.json", import.meta.url).pathname;

test("watchlist.json is present and valid against the schema", () => {
  const list = loadWatchlist(WATCHLIST);
  expect(list.repos.length).toBeGreaterThan(0);
});

test("watchableRepos: only active + releases + a real github_full_name", () => {
  const list = loadWatchlist(WATCHLIST);
  const watchable = watchableRepos(list);
  expect(watchable.length).toBeGreaterThan(0);
  for (const r of watchable) {
    expect(r.active).toBe(true);
    expect(r.watch).toBe("releases");
    expect(r.github_full_name).toMatch(/^[^/]+\/[^/]+$/);
  }
  // Inactive / GitHub-less entries are retained but never watched.
  expect(watchable.length).toBeLessThan(list.repos.length);
});

test("schema rejects a malformed entry (bad github_full_name)", () => {
  expect(() =>
    parseWatchlist({
      repos: [
        {
          github_full_name: "not-a-full-name",
          url: null, domain: null, component: null, assignee: null,
          active: false, watch: "none", default_branch: null,
          title: null, description: null, stars: null,
        },
      ],
    }),
  ).toThrow();
});
