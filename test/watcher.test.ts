import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusStore } from "../src/db.ts";
import { pollOnce, WATCHER_AGENT, type WatcherOptions } from "../src/watcher.ts";

/** A watchlist file with a single active repo, written to a temp path. */
function tmpWatchlist(fullName = "acme/widget"): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-wl-"));
  const path = join(dir, "watchlist.json");
  writeFileSync(
    path,
    JSON.stringify({
      repos: [
        {
          github_full_name: fullName,
          url: `https://github.com/${fullName}`,
          domain: "Testing",
          component: "Widget",
          assignee: "Johnathan",
          active: true,
          watch: "releases",
          default_branch: "main",
          title: "widget",
          description: null,
          stars: 1,
        },
      ],
    }),
  );
  return path;
}

/** A fetch stub that returns a fixed status/body for the releases/latest call. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(body === undefined ? "" : JSON.stringify(body), { status })) as unknown as typeof fetch;
}

function opts(path: string, fetchFn: typeof fetch): WatcherOptions {
  return { watchlistPath: path, githubToken: "t", intervalMs: 1000, fetchFn, log: () => {} };
}

test("watcher: first sight seeds silently, a changed tag announces a public release", async () => {
  const s = new BusStore(":memory:", 60);
  const path = tmpWatchlist();

  // First pass: seed, no broadcast.
  let sum = await pollOnce(s, opts(path, fakeFetch(200, { tag_name: "v1.0.0", html_url: "https://github.com/acme/widget/releases/tag/v1.0.0", name: "Widget 1.0" })));
  expect(sum).toMatchObject({ checked: 1, seeded: 1, announced: 0 });
  expect(s.publicMessages()).toHaveLength(0);
  expect(s.getSeenRelease("acme/widget")).toBe("v1.0.0");

  // Same tag again: nothing.
  sum = await pollOnce(s, opts(path, fakeFetch(200, { tag_name: "v1.0.0" })));
  expect(sum.announced).toBe(0);
  expect(s.publicMessages()).toHaveLength(0);

  // New tag: announce a public broadcast carrying the watchlist facets.
  sum = await pollOnce(s, opts(path, fakeFetch(200, { tag_name: "v1.1.0", html_url: "https://github.com/acme/widget/releases/tag/v1.1.0", name: "v1.1.0" })));
  expect(sum.announced).toBe(1);
  const pub = s.publicMessages();
  expect(pub).toHaveLength(1);
  expect(pub[0].sender).toBe(WATCHER_AGENT);
  expect(pub[0].body).toBe("acme/widget v1.1.0");
  expect(pub[0].data).toMatchObject({ kind: "github_release", repo: "acme/widget", tag: "v1.1.0", assignee: "Johnathan", domain: "Testing" });
});

test("watcher: a repo with no published releases (404) is counted, not announced", async () => {
  const s = new BusStore(":memory:", 60);
  const sum = await pollOnce(s, opts(tmpWatchlist(), fakeFetch(404, undefined)));
  expect(sum).toMatchObject({ checked: 1, noRelease: 1, announced: 0 });
  expect(s.publicMessages()).toHaveLength(0);
});

test("watcher: GitHub rate limiting (403) is surfaced and announces nothing", async () => {
  const s = new BusStore(":memory:", 60);
  const sum = await pollOnce(s, opts(tmpWatchlist(), fakeFetch(403, { message: "rate limited" })));
  expect(sum.rateLimited).toBe(true);
  expect(sum.announced).toBe(0);
});
