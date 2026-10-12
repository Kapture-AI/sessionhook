import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NewEvent } from "../event.js";
import { EventStore } from "../store.js";
import { JiraPoller } from "./jiraPoller.js";
import { fixture, site } from "./jiraFixtures.test.js";

const token = "fake-api-token-for-tests";
const startedAt = Date.parse("2026-10-12T09:31:00Z");
// The poll window opens a minute before the cursor.
const windowStart = Date.parse("2026-10-12T09:30:00Z");

type Recorded = { method: string; url: string; authorization: string; body: any };
type Reply = () => Response | Promise<Response>;

let directory: string;
let store: EventStore;
let requests: Recorded[];
let replies: Reply[];
let delivered: NewEvent[][];
let lines: string[];
let clock: number;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return () => new Response(JSON.stringify(body), { status, headers });
}

const fakeFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  requests.push({
    method: init?.method ?? "GET",
    url: String(input),
    authorization: headers.get("authorization") ?? "",
    body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
  });
  const reply = replies.shift();
  if (reply === undefined) throw new Error("the test queued no reply for this request");
  return reply();
};

function makePoller(overrides: { intervalMs?: number; fetch?: typeof fetch } = {}): JiraPoller {
  return new JiraPoller({
    name: "jira",
    site,
    email: "ada@example.com",
    token,
    intervalMs: overrides.intervalMs ?? 30_000,
    store,
    intake: (events) => delivered.push(events),
    log: (line) => lines.push(line),
    fetch: overrides.fetch ?? fakeFetch,
    now: () => clock,
  });
}

function open(): EventStore {
  return new EventStore(join(directory, "events.db"));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-poller-"));
  store = open();
  store.subscribe("watcher", "jira:PROJ-123");
  requests = [];
  replies = [];
  delivered = [];
  lines = [];
  clock = startedAt;
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a poll with nothing subscribed makes no request", async () => {
  store.unsubscribe("watcher", "jira:PROJ-123");
  store.subscribe("watcher", "other:ABC-1");
  await makePoller().pollOnce();
  assert.equal(requests.length, 0);
  assert.deepEqual(delivered, []);
});

test("the search is one authenticated POST with the key list and unquoted epoch milliseconds", async () => {
  store.subscribe("watcher", "jira:PROJ-7");
  replies.push(json(fixture("poll-search")));
  await makePoller().pollOnce();

  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request!.method, "POST");
  assert.equal(request!.url, "https://example.atlassian.net/rest/api/3/search/jql");
  assert.equal(request!.authorization, `Basic ${Buffer.from(`ada@example.com:${token}`).toString("base64")}`);
  assert.deepEqual(request!.body, {
    jql: `key in (PROJ-123,PROJ-7) AND updated >= ${windowStart}`,
    fields: ["comment", "updated", "summary", "status"],
    expand: "changelog",
    maxResults: 100,
  });
});

test("the events of a tick reach the broker in one call, ordered by time", async () => {
  replies.push(json(fixture("poll-search")));
  await makePoller().pollOnce();
  assert.equal(delivered.length, 1);
  assert.deepEqual(
    delivered[0]!.map((event) => [event.id, event.at]),
    [
      ["jira:changelog:30001", "2026-10-12T09:36:10.213Z"],
      ["jira:comment:20001", "2026-10-12T09:56:41.681Z"],
      ["jira:comment:20002:updated:1791799090000", "2026-10-12T09:58:10.000Z"],
    ],
  );
});

test("only subscribed text shaped like a ticket key reaches the query, and each ignored topic is logged once", async () => {
  for (const topic of ["jira:proj-1", "jira:PROJ-1 OR 1=1", "jira:PROJ-9)", "other:ABC-1"]) store.subscribe("watcher", topic);
  replies.push(json({ issues: [], isLast: true }), json({ issues: [], isLast: true }));
  const poller = makePoller();
  await poller.pollOnce();
  await poller.pollOnce();

  assert.match(requests[0]!.body.jql, /^key in \(PROJ-123\) AND updated >= \d+$/);
  const ignored = lines.filter((line) => line.includes("can never match"));
  assert.equal(ignored.length, 3);
  assert.ok(ignored.some((line) => line.includes('"jira:proj-1"')));
});

test("a search that is not on its last page is followed with the page token", async () => {
  const first = fixture("poll-search");
  first.isLast = false;
  first.nextPageToken = "page-two";
  const second = fixture("poll-search");
  second.issues[0].key = "PROJ-124";
  replies.push(json(first), json(second));
  await makePoller().pollOnce();

  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.body.nextPageToken, undefined);
  assert.equal(requests[1]!.body.nextPageToken, "page-two");
  assert.deepEqual(
    [...new Set(delivered[0]!.map((event) => event.topic))].sort(),
    ["jira:PROJ-123", "jira:PROJ-124"],
  );
});

test("the first poll starts from the start time and a successful poll moves the cursor to the tick start", async () => {
  replies.push(json({ issues: [], isLast: true }), json({ issues: [], isLast: true }));
  const poller = makePoller();
  clock = startedAt + 5_000;
  await poller.pollOnce();
  clock = startedAt + 35_000;
  await poller.pollOnce();

  assert.match(requests[0]!.body.jql, new RegExp(`updated >= ${windowStart}$`));
  assert.match(requests[1]!.body.jql, new RegExp(`updated >= ${startedAt + 5_000 - 60_000}$`));
  assert.equal(store.getState("poll-cursor:jira"), String(startedAt + 35_000));
});

test("the cursor survives a restart and is the same for a new poller", async () => {
  replies.push(json({ issues: [], isLast: true }));
  clock = startedAt + 10_000;
  await makePoller().pollOnce();

  store.close();
  store = open();
  clock = startedAt + 3_600_000;
  replies.push(json({ issues: [], isLast: true }));
  await makePoller().pollOnce();
  assert.match(requests[1]!.body.jql, new RegExp(`updated >= ${startedAt + 10_000 - 60_000}$`));
});

test("a tick with nothing subscribed still moves the cursor, so a later subscription does not replay old events", async () => {
  store.unsubscribe("watcher", "jira:PROJ-123");
  clock = startedAt + 20_000;
  await makePoller().pollOnce();
  assert.equal(store.getState("poll-cursor:jira"), String(startedAt + 20_000));
});

test("a failed tick leaves the cursor where it was, and so does a broker that cannot store the events", async () => {
  replies.push(json({}, 500));
  clock = startedAt + 10_000;
  await makePoller().pollOnce();
  assert.equal(store.getState("poll-cursor:jira"), undefined);

  replies.push(json(fixture("poll-search")));
  const failing = new JiraPoller({
    name: "jira", site, email: "ada@example.com", token, intervalMs: 30_000, store,
    intake: () => {
      throw new Error("disk full");
    },
    log: (line) => lines.push(line), fetch: fakeFetch, now: () => clock,
  });
  await failing.pollOnce();
  assert.equal(store.getState("poll-cursor:jira"), undefined);
  assert.ok(lines.some((line) => line.includes("disk full")));
});

test("cut comments trigger one follow-up for the newest hundred, and complete ones trigger none", async () => {
  const cut = fixture("poll-search");
  cut.issues[0].fields.comment.total = 25;
  const newest = fixture("poll-comment");
  newest.id = "20099";
  newest.created = newest.updated = "2026-10-12T14:30:00.000+0400";
  replies.push(json(cut), json({ comments: [newest], total: 25 }));
  await makePoller().pollOnce();

  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.method, "GET");
  assert.equal(requests[1]!.url, "https://example.atlassian.net/rest/api/3/issue/PROJ-123/comment?orderBy=-created&maxResults=100");
  assert.ok(delivered[0]!.some((event) => event.id === "jira:comment:20099"));
  assert.ok(!delivered[0]!.some((event) => event.id === "jira:comment:20001"), "the follow-up replaces the inline list");

  requests.length = 0;
  replies.push(json(fixture("poll-search")));
  await makePoller().pollOnce();
  assert.equal(requests.length, 1);
});

test("a cut changelog whose oldest shown entry is inside the window fetches the newest entries from the end", async () => {
  const cut = fixture("poll-search");
  cut.issues[0].changelog = { histories: [cut.issues[0].changelog.histories[0]], total: 150, maxResults: 40 };
  const older = { id: "29999", author: { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Grace Hopper" }, created: "2026-10-12T13:31:00.000+0400", items: [{ field: "priority", fromString: "Low", toString: "High" }] };
  replies.push(json(cut), json({ values: [older], total: 150 }));
  await makePoller().pollOnce();

  assert.equal(requests[1]!.url, "https://example.atlassian.net/rest/api/3/issue/PROJ-123/changelog?startAt=50&maxResults=100");
  assert.ok(delivered[0]!.some((event) => event.id === "jira:changelog:29999"));
});

test("a cut changelog whose oldest shown entry is before the window needs no follow-up", async () => {
  const cut = fixture("poll-search");
  cut.issues[0].changelog.total = 150;
  replies.push(json(cut));
  await makePoller().pollOnce();
  assert.equal(requests.length, 1);
});

test("one line is logged when polling starts failing and one when it recovers, never the token or a body", async () => {
  replies.push(
    json({ message: "secret-response-text" }, 401),
    json({ message: "secret-response-text" }, 401),
    json({ issues: [], isLast: true }),
    json({ issues: [], isLast: true }),
  );
  const poller = makePoller();
  for (let tick = 0; tick < 4; tick++) await poller.pollOnce();

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^poll jira: failed, HTTP 401, the email or API token is wrong/);
  assert.equal(lines[1], "poll jira: recovered");
  const everything = lines.join("\n");
  for (const secret of [token, "secret-response-text", "Basic ", "Authorization"]) assert.ok(!everything.includes(secret), secret);
});

test("a forbidden answer is also reported as a wrong email or token, other statuses only by number", async () => {
  replies.push(json({}, 403));
  await makePoller().pollOnce();
  assert.match(lines[0]!, /HTTP 403, the email or API token is wrong/);

  lines.length = 0;
  replies.push(json({}, 503));
  await makePoller().pollOnce();
  assert.match(lines[0]!, /failed, HTTP 503, it keeps retrying/);
  assert.ok(!lines[0]!.includes("wrong"));
});

test("a network error and a body that is not JSON are logged without the body", async () => {
  await makePoller({
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  }).pollOnce();
  assert.match(lines[0]!, /failed, fetch failed/);

  lines.length = 0;
  replies.push(() => new Response("<html>secret page</html>", { status: 200 }));
  await makePoller().pollOnce();
  assert.match(lines[0]!, /failed, the response was not JSON/);
  assert.ok(!lines[0]!.includes("secret page"));
});

test("after a 429 the next tick waits for Retry-After instead of the interval", async () => {
  let count = 0;
  const poller = makePoller({
    intervalMs: 20,
    fetch: async () => {
      count++;
      return new Response("{}", { status: 429, headers: { "Retry-After": "1" } });
    },
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await poller.stop();
  assert.equal(count, 1);
  assert.match(lines[0]!, /HTTP 429/);
});

test("ticks run on the interval and never overlap", async () => {
  let running = 0;
  let overlapped = false;
  let count = 0;
  const poller = makePoller({
    intervalMs: 10,
    fetch: async () => {
      count++;
      if (++running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 40));
      running--;
      return new Response(JSON.stringify({ issues: [], isLast: true }));
    },
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await poller.stop();
  assert.ok(count >= 3, `only ${count} requests`);
  assert.equal(overlapped, false);
});

test("stop aborts a request in flight and ends the loop", async () => {
  let aborted = false;
  const poller = makePoller({
    intervalMs: 10,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  poller.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await poller.stop();
  assert.equal(aborted, true);
  assert.deepEqual(lines, [], "a stop is not a polling failure");
});
