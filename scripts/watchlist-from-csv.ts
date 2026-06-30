#!/usr/bin/env bun
// One-time / occasional converter: a Google-Sheet CSV export → the validated
// watchlist.json the release-watcher reads. watchlist.json is the maintained
// source of truth going forward; re-run this only when re-importing from the
// Sheet.
//
//   bun run scripts/watchlist-from-csv.ts watchlist.csv > watchlist.json
//
// It normalises the Sheet's quirks: the three spellings of "paused"
// (paused/PAUSE/Paused) collapse to active:false, an empty github_full_name is
// recovered from the url, and rows with no GitHub home (e.g. MegaETH) are kept
// as inactive entries with a note so the list stays complete.

import { parseWatchlist, type WatchlistEntry, type WatchKind } from "../src/watchlist.ts";

/** Minimal RFC-4180-ish CSV parser: handles quoted fields, commas, "" escapes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const PAUSED = new Set(["paused", "pause"]);

/** Recover "owner/repo" from a GitHub URL, dropping trailing paths like /tags. */
function fullNameFromUrl(url: string): string | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

function clean(s: string | undefined): string | null {
  const v = (s ?? "").trim();
  return v.length ? v : null;
}

const csvPath = process.argv[2] ?? "watchlist.csv";
const rows = parseCsv(await Bun.file(csvPath).text());
const [header, ...body] = rows;
const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
const col = (r: string[], name: string) => clean(r[idx[name]]);

const repos: WatchlistEntry[] = [];
for (const r of body) {
  const repoName = col(r, "repo_name");
  // Skip blank spacer rows and the "Not tracking yet" section divider.
  if (!repoName || repoName === "Not tracking yet") continue;

  const assigneeRaw = col(r, "Asignee");
  const paused = assigneeRaw !== null && PAUSED.has(assigneeRaw.toLowerCase());
  const assignee = paused ? null : assigneeRaw;

  const url = col(r, "url");
  const fullName = col(r, "github_full_name") ?? (url ? fullNameFromUrl(url) : null);

  // A row with no GitHub home (e.g. MegaETH) is kept but never polled.
  const hasGithub = fullName !== null;
  const starsRaw = col(r, "stars");
  const stars = starsRaw !== null && Number.isFinite(Number(starsRaw)) ? Number(starsRaw) : null;

  // MegaETH-style rows carry their explanation in the domain column.
  const note = !hasGithub ? clean(r[idx["blockchain_or_domain"]]) ?? undefined : undefined;

  const active = !paused && hasGithub && assignee !== null;
  const watch: WatchKind = active ? "releases" : "none";

  repos.push({
    github_full_name: fullName,
    url,
    domain: hasGithub ? col(r, "blockchain_or_domain") : null,
    component: col(r, "component"),
    assignee,
    active,
    watch,
    default_branch: col(r, "default_branch"),
    title: col(r, "title"),
    description: col(r, "description"),
    stars,
    ...(note ? { note } : {}),
  });
}

const watchlist = parseWatchlist({ repos }); // validate before emitting
const active = watchlist.repos.filter((r) => r.active).length;
console.error(`converted ${watchlist.repos.length} repos (${active} active, ${watchlist.repos.length - active} inactive)`);
process.stdout.write(JSON.stringify(watchlist, null, 2) + "\n");
