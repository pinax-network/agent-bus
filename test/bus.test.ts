import { test, expect } from "bun:test";
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
