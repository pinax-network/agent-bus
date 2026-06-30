import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusStore } from "../src/db.ts";

function store() {
  return new BusStore(":memory:", 60);
}

test("register + presence: agents are online right after registering", () => {
  const s = store();
  s.register("pinax1", "host-a", ["allocate"], "booting");
  s.register("pinax2", "host-b");
  const agents = s.listAgents();
  expect(agents.map((a) => a.name)).toEqual(["pinax1", "pinax2"]);
  expect(agents.every((a) => a.online)).toBe(true);
  expect(s.getAgent("pinax1")?.capabilities).toEqual(["allocate"]);
});

test("messages: direct delivery, broadcast fan-out, no self-echo, cursor advances", () => {
  const s = store();
  s.register("a");
  s.register("b");
  s.send("a", "b", "direct hello");
  s.send("a", "*", "broadcast hi");

  // b sees both the direct message and the broadcast.
  const bInbox = s.inbox("b", 0);
  expect(bInbox.map((m) => m.body)).toEqual(["direct hello", "broadcast hi"]);

  // a does NOT receive its own broadcast.
  expect(s.inbox("a", 0)).toHaveLength(0);

  // cursor: reading past the last id returns nothing new.
  const cursor = bInbox[bInbox.length - 1].id;
  expect(s.inbox("b", cursor)).toHaveLength(0);
});

test("messages: visibility defaults to private and does not leak into the feed", () => {
  const s = store();
  s.register("a");
  s.send("a", "*", "internal coordination");
  expect(s.recentMessages().at(-1)?.visibility).toBe("private");
  expect(s.publicMessages()).toHaveLength(0);
});

test("messages: public messages surface on the feed; private stay off it", () => {
  const s = store();
  s.register("watcher");
  s.send("watcher", "*", "private note");
  s.send("watcher", "*", "ethereum/go-ethereum v1.14.0", { kind: "github_release", domain: "Ethereum", assignee: "Johnathan" }, "public");

  const pub = s.publicMessages();
  expect(pub.map((m) => m.body)).toEqual(["ethereum/go-ethereum v1.14.0"]);
  expect(pub[0].visibility).toBe("public");
});

test("messages: public broadcasts still deliver to agent inboxes", () => {
  const s = store();
  s.register("watcher");
  s.register("b");
  s.send("watcher", "*", "release alert", undefined, "public");
  // visibility is about who can READ bodies publicly; delivery is unchanged.
  expect(s.inbox("b", 0).map((m) => m.body)).toEqual(["release alert"]);
});

test("publicMessages: filters by assignee / domain / kind inside data", () => {
  const s = store();
  s.register("watcher");
  s.send("watcher", "*", "eth release", { kind: "github_release", domain: "Ethereum", assignee: "Johnathan" }, "public");
  s.send("watcher", "*", "tooling release", { kind: "github_release", domain: "Developer Tooling", assignee: "Matthew" }, "public");

  expect(s.publicMessages({ assignee: "Johnathan" }).map((m) => m.body)).toEqual(["eth release"]);
  expect(s.publicMessages({ domain: "Developer Tooling" }).map((m) => m.body)).toEqual(["tooling release"]);
  expect(s.publicMessages({ kind: "github_release" })).toHaveLength(2);
  expect(s.publicMessages({ assignee: "Nobody" })).toHaveLength(0);
});

test("migration: a pre-existing messages table without `visibility` is upgraded in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-bus-mig-"));
  const path = join(dir, "legacy.db");

  // Simulate a DB created before the column existed, with one row already in it.
  const legacy = new Database(path, { create: true });
  legacy.exec(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sender TEXT NOT NULL,
    recipient TEXT NOT NULL, body TEXT NOT NULL, data TEXT
  )`);
  legacy.query(`INSERT INTO messages (ts, sender, recipient, body, data) VALUES (1, 'old', '*', 'pre-migration', NULL)`).run();
  legacy.close();

  // Opening through BusStore must add the column (defaulting old rows to private)
  // and keep working for both reads and new public sends.
  const s = new BusStore(path, 60);
  expect(s.recentMessages().at(-1)?.visibility).toBe("private");
  s.send("watcher", "*", "post-migration public", undefined, "public");
  expect(s.publicMessages().map((m) => m.body)).toEqual(["post-migration public"]);
  s.close();
});

test("claims: exclusive ownership — a second agent cannot steal a live claim", () => {
  const s = store();
  const first = s.claim("QmDeploy", "pinax1", 900);
  expect(first.acquired).toBe(true);
  expect(first.claim.owner).toBe("pinax1");

  const steal = s.claim("QmDeploy", "pinax2", 900);
  expect(steal.acquired).toBe(false);
  expect(steal.claim.owner).toBe("pinax1"); // unchanged

  // owner can renew its own claim
  const renew = s.claim("QmDeploy", "pinax1", 900);
  expect(renew.acquired).toBe(true);
});

test("claims: expired claim can be taken over by another agent", () => {
  const s = store();
  s.claim("QmDeploy", "pinax1", 0 /* ttl 0 → never expires */);
  // ttl 0 means no expiry; a live claim by someone else is not stealable.
  expect(s.claim("QmDeploy", "pinax2", 900).acquired).toBe(false);

  // A claim with a negative-effectively-past expiry: simulate by claiming with a
  // tiny ttl is time-dependent, so instead verify release frees it.
  expect(s.release("QmDeploy", "pinax2")).toBe(false); // not the owner
  expect(s.release("QmDeploy", "pinax1")).toBe(true);
  expect(s.claim("QmDeploy", "pinax2", 900).acquired).toBe(true);
});

test("claims: a crashed owner's claim expires and is taken over (self-healing)", async () => {
  const s = store();
  // pinax1 grabs the key with a 1s TTL, then "crashes" (never releases).
  expect(s.claim("QmDeploy", "pinax1", 1).acquired).toBe(true);
  // While live, pinax2 can't take it.
  expect(s.claim("QmDeploy", "pinax2", 1).acquired).toBe(false);
  // After the TTL lapses, pinax2 takes it over.
  await Bun.sleep(1100);
  const takeover = s.claim("QmDeploy", "pinax2", 1);
  expect(takeover.acquired).toBe(true);
  expect(takeover.claim.owner).toBe("pinax2");
});

test("listClaims reflects only live claims", () => {
  const s = store();
  s.claim("k1", "a", 900);
  s.claim("k2", "b", 900);
  expect(s.listClaims().map((c) => c.key).sort()).toEqual(["k1", "k2"]);
  s.release("k1", "a");
  expect(s.listClaims().map((c) => c.key)).toEqual(["k2"]);
});
