import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent } from "./event.js";
import { EventStore } from "./store.js";

let directory: string;
let store: EventStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-store-"));
  store = new EventStore(join(directory, "events.db"));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(id: string, topic = "deploys:org/web"): NewEvent {
  return {
    id,
    topic,
    type: "deploy",
    actor: { id: "7", name: "Ada Lovelace" },
    at: "2026-10-12T10:00:00.000Z",
    url: "https://example.com/1",
    summary: `summary ${id}`,
  };
}

function seqs(name: string): number[] {
  return store.unread(name, 100).map((record) => record.seq);
}

test("append returns the stored record with its sequence number", () => {
  const first = store.append(event("a"));
  const second = store.append(event("b"));
  assert.equal(first?.seq, 1);
  assert.equal(second?.seq, 2);
  assert.deepEqual(first, { seq: 1, ...event("a") });
});

test("appending an id that exists returns undefined and stores nothing", () => {
  store.append(event("a"));
  assert.equal(store.append(event("a")), undefined);
  assert.equal(store.append(event("b"))?.seq, 2);
});

test("a new subscriber starts at the latest event and sees only later ones", () => {
  store.append(event("old"));
  store.subscribe("s1", "deploys:org/web");
  assert.deepEqual(seqs("s1"), []);
  store.append(event("new"));
  assert.deepEqual(seqs("s1"), [2]);
});

test("a subscription yields nothing that arrived before it was made, even for a subscriber with an older cursor", () => {
  store.subscribe("s1", "deploys:one");
  store.append(event("a", "deploys:two"));
  store.subscribe("s1", "deploys:two");
  store.append(event("b", "deploys:two"));
  assert.deepEqual(seqs("s1"), [2]);
});

test("subscribing twice keeps the original since_seq", () => {
  store.subscribe("s1", "deploys:org/web");
  store.append(event("a"));
  store.subscribe("s1", "deploys:org/web");
  assert.deepEqual(seqs("s1"), [1]);
});

test("only events on a subscribed topic are unread, matched exactly", () => {
  store.subscribe("s1", "deploys:org/web");
  store.append(event("a", "deploys:org/web"));
  store.append(event("b", "deploys:org/web2"));
  store.append(event("c", "deploys:org"));
  store.append(event("d", "other:org/web"));
  assert.deepEqual(seqs("s1"), [1]);
});

test("unread is ordered by sequence and honours the limit", () => {
  store.subscribe("s1", "deploys:org/web");
  for (const id of ["a", "b", "c"]) store.append(event(id));
  assert.deepEqual(seqs("s1"), [1, 2, 3]);
  assert.deepEqual(store.unread("s1", 2).map((record) => record.seq), [1, 2]);
});

test("ack moves the cursor forward and never backward", () => {
  store.subscribe("s1", "deploys:org/web");
  for (const id of ["a", "b", "c"]) store.append(event(id));
  store.ack("s1", 2);
  assert.deepEqual(seqs("s1"), [3]);
  store.ack("s1", 1);
  assert.deepEqual(seqs("s1"), [3]);
});

test("rewind sets the cursor to just before the sequence and never forward", () => {
  store.subscribe("s1", "deploys:org/web");
  for (const id of ["a", "b", "c"]) store.append(event(id));
  store.ack("s1", 3);
  store.rewind("s1", 2);
  assert.deepEqual(seqs("s1"), [2, 3]);
  store.rewind("s1", 10);
  assert.deepEqual(seqs("s1"), [2, 3]);
});

test("rewind does not reach back before the subscription was made", () => {
  store.append(event("before"));
  store.subscribe("s1", "deploys:org/web");
  store.append(event("after"));
  store.ack("s1", 2);
  store.rewind("s1", 1);
  assert.deepEqual(seqs("s1"), [2]);
});

test("two subscribers on one topic each receive every event with their own cursor", () => {
  store.subscribe("s1", "deploys:org/web");
  store.subscribe("s2", "deploys:org/web");
  store.append(event("a"));
  store.append(event("b"));
  store.ack("s1", 2);
  assert.deepEqual(seqs("s1"), []);
  assert.deepEqual(seqs("s2"), [1, 2]);
});

test("unsubscribe stops delivery and reports whether anything was removed", () => {
  store.subscribe("s1", "deploys:org/web");
  assert.equal(store.unsubscribe("s1", "deploys:org/web"), true);
  assert.equal(store.unsubscribe("s1", "deploys:org/web"), false);
  store.append(event("a"));
  assert.deepEqual(seqs("s1"), []);
});

test("status lists each subscriber with topics, unread count, cursor and last seen", () => {
  store.subscribe("s2", "deploys:org/web");
  store.subscribe("s1", "deploys:org/web");
  store.subscribe("s1", "deploys:org/api");
  store.append(event("a", "deploys:org/web"));
  store.append(event("b", "deploys:org/api"));
  store.ack("s2", 1);
  const status = store.status();
  assert.deepEqual(
    status.map(({ name, topics, unread, cursor }) => ({ name, topics, unread, cursor })),
    [
      { name: "s1", topics: ["deploys:org/api", "deploys:org/web"], unread: 2, cursor: 0 },
      { name: "s2", topics: ["deploys:org/web"], unread: 0, cursor: 1 },
    ],
  );
  assert.match(status[0]!.lastSeen, /^\d{4}-\d{2}-\d{2}T/);
});

test("touch updates last seen and hasSubscriber reports membership", async () => {
  assert.equal(store.hasSubscriber("s1"), false);
  store.subscribe("s1", "deploys:org/web");
  assert.equal(store.hasSubscriber("s1"), true);
  const before = store.status()[0]!.lastSeen;
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.touch("s1");
  assert.notEqual(store.status()[0]!.lastSeen, before);
});

test("subscribedTopics lists each topic once", () => {
  store.subscribe("s1", "deploys:org/web");
  store.subscribe("s2", "deploys:org/web");
  store.subscribe("s2", "jira:PROJ-1");
  assert.deepEqual(store.subscribedTopics(), ["deploys:org/web", "jira:PROJ-1"]);
});

test("events, subscribers and subscriptions survive reopening the file", () => {
  store.subscribe("s1", "deploys:org/web");
  store.append(event("a"));
  store.close();
  store = new EventStore(join(directory, "events.db"));
  assert.deepEqual(seqs("s1"), [1]);
});
