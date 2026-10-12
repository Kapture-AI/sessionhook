// Runs real brokers in this process on port 0 with temporary directories. The Jira site is never
// contacted, and webhooks are posted over loopback with a made-up secret.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerFromFiles, type Broker } from "./broker.js";
import type { EventRecord } from "./event.js";
import { ensureStateDir, resolvePaths } from "./paths.js";
import type { JiraRuntime } from "./sources/jiraPoller.js";
import { EventStore } from "./store.js";
import { fixture, site } from "./sources/jiraFixtures.test.js";

const webhookSecret = "fake-jira-webhook-secret";
const apiToken = "fake-jira-api-token";
// The moment the poller considers itself started, a minute after the window the fixtures fall in.
const startedAt = Date.parse("2026-10-12T09:31:00Z");
const cliPath = new URL("./cli.js", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "sessionhook-jira-"));
after(() => rmSync(root, { recursive: true, force: true }));

const jiraSource = { type: "jira", site, webhookSecret: "TEST_JIRA_WEBHOOK_SECRET" };

type BrokerOptions = {
  // Topics the subscriber "watcher" holds before the broker starts, so that its first poll already has work.
  subscriptions?: string[];
  runtime?: JiraRuntime;
};

let brokerCount = 0;
async function withBroker(
  sources: Record<string, object>,
  run: (broker: Broker, lines: string[], environment: Record<string, string>) => Promise<void>,
  options: BrokerOptions = {},
): Promise<void> {
  const directory = join(root, `broker-${brokerCount++}`);
  mkdirSync(join(directory, "config"), { recursive: true });
  writeFileSync(join(directory, "config", "config.json"), JSON.stringify({ listen: { port: 0 }, sources }));
  const environment = {
    SESSIONHOOK_CONFIG_DIR: join(directory, "config"),
    SESSIONHOOK_STATE_DIR: join(directory, "state"),
  };
  const paths = resolvePaths(environment);
  if (options.subscriptions) {
    ensureStateDir(paths);
    const seed = new EventStore(paths.databaseFile);
    for (const topic of options.subscriptions) seed.subscribe("watcher", topic);
    seed.close();
  }
  const lines: string[] = [];
  const secrets = { TEST_JIRA_WEBHOOK_SECRET: webhookSecret, TEST_JIRA_TOKEN: apiToken };
  const runtime = { now: () => startedAt, ...options.runtime };
  const broker = await startBrokerFromFiles(paths, secrets, (line) => lines.push(line), runtime);
  try {
    await run(broker, lines, environment);
  } finally {
    await broker.stop();
  }
}

function post(broker: Broker, source: string, payload: object, secret = webhookSecret, query = ""): Promise<number> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Promise((resolve, reject) => {
    request(
      {
        host: "127.0.0.1",
        port: broker.webhookPort,
        path: `/hooks/${source}${query}`,
        method: "POST",
        agent: false,
        headers: { "X-Hub-Signature": signature },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    )
      .on("error", reject)
      .end(body);
  });
}

function stored(broker: Broker, subscriber: string): EventRecord[] {
  return broker.store.unread(subscriber, 100);
}

function commentBy(accountId: string, displayName: string, body: string) {
  const payload = fixture("webhook-comment-created");
  payload.comment.author = { accountId, displayName };
  payload.comment.body = body;
  return payload;
}

test("a signed comment payload is stored as a comment_created event", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    const [event, ...rest] = stored(broker, "watcher");
    assert.equal(rest.length, 0);
    assert.equal(event!.type, "comment_created");
    assert.equal(event!.actor.name, "Ada Lovelace");
    assert.equal(event!.url, "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001");
  });
});

test("a comment payload posted with the query string Jira appends is stored", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    const query = "?user_id=5b10a2844c20165700ede21g&user_key=ada";
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created"), webhookSecret, query), 200);
    const [event, ...rest] = stored(broker, "watcher");
    assert.equal(rest.length, 0);
    assert.equal(event!.type, "comment_created");
  });
});

test("a payload with a wrong signature is rejected and stores nothing", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created"), "another-secret"), 401);
    assert.deepEqual(stored(broker, "watcher"), []);
  });
});

test("a Jira retry of the same payload is stored once", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    assert.equal(stored(broker, "watcher").length, 1);
  });
});

test("an event kind the source does not translate is answered 200 and stores nothing", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    assert.equal(await post(broker, "jira", { webhookEvent: "sprint_started" }), 200);
    assert.deepEqual(stored(broker, "watcher"), []);
  });
});

test("when the store write fails in webhook mode the listener answers 5xx so Jira retries", async () => {
  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    const append = broker.store.append.bind(broker.store);
    broker.store.append = () => {
      throw new Error("disk full");
    };
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 500);
    broker.store.append = append;
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    assert.equal(stored(broker, "watcher").length, 1);
  });
});

test("webhook mode drops a comment from an actor outside the allowlist, on the ignore list or carrying the marker", async () => {
  const sources = {
    "jira-allow": { ...jiraSource, allowActors: ["Ada Lovelace"] },
    "jira-ignore": { ...jiraSource, ignoreActors: ["5b10ac8d82e05b22cc7d4ef5"] },
    "jira-marker": { ...jiraSource, ignoreMarker: "[agent]" },
  };
  await withBroker(sources, async (broker, lines) => {
    for (const name of Object.keys(sources)) broker.store.subscribe("watcher", `${name}:PROJ-123`);
    const ada = commentBy("5b10a2844c20165700ede21g", "Ada Lovelace", "Looks fine.");
    const grace = commentBy("5b10ac8d82e05b22cc7d4ef5", "Grace Hopper", "Looks fine.");
    const marked = commentBy("5b10a2844c20165700ede21g", "Ada Lovelace", "Looks fine. [agent]");

    assert.equal(await post(broker, "jira-allow", grace), 200);
    assert.equal(await post(broker, "jira-ignore", grace), 200);
    assert.equal(await post(broker, "jira-marker", marked), 200);
    assert.deepEqual(stored(broker, "watcher"), []);
    assert.ok(lines.some((line) => line.includes("by allowActors")));
    assert.ok(lines.some((line) => line.includes("by ignoreActors")));
    assert.ok(lines.some((line) => line.includes("by ignoreMarker")));

    assert.equal(await post(broker, "jira-allow", ada), 200);
    assert.equal(await post(broker, "jira-ignore", ada), 200);
    assert.equal(await post(broker, "jira-marker", ada), 200);
    assert.equal(stored(broker, "watcher").length, 3);
  });
});

const pollSource = { type: "jira", site, email: "ada@example.com", token: "TEST_JIRA_TOKEN", poll: {} };

type SearchResponse = ReturnType<typeof searchResponse>;
function searchResponse() {
  return fixture("poll-search");
}

// Replays the recorded search for every request and counts them. A gate holds the first answer back when a test needs it.
function recordedJira(response: SearchResponse = searchResponse(), gate: Promise<void> = Promise.resolve()) {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetchJira: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    await gate;
    return new Response(JSON.stringify(response));
  };
  return { requests, fetchJira };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(condition(), `timed out waiting for ${what}`);
}

function withoutSeq({ seq: _, ...event }: EventRecord) {
  return event;
}

test("poll mode delivers a new comment with the commenter, the ticket and a link to the comment", async () => {
  const jira = recordedJira();
  await withBroker({ jira: pollSource }, async (_broker, _lines, environment) => {
    const waiting = spawn(process.execPath, [cliPath, "wait", "--json", "--name", "watcher"], {
      env: environment,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    waiting.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await once(waiting, "close");
    const events = output.split("\n").filter(Boolean).map((line) => JSON.parse(line) as EventRecord);
    const comment = events.find((event) => event.type === "comment_created")!;
    assert.equal(comment.actor.name, "Ada Lovelace");
    assert.equal(comment.topic, "jira:PROJ-123");
    assert.equal(comment.url, "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001");
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: jira.fetchJira } });
});

test("poll mode stores a status change as an event naming the changed field", async () => {
  const jira = recordedJira();
  await withBroker({ jira: pollSource }, async (broker) => {
    await until(() => broker.store.unread("watcher", 100).length === 3, "the poll to store its events");
    const change = broker.store.unread("watcher", 100).find((event) => event.type === "issue_updated")!;
    assert.match(change.summary, /^status: To Do -> In Progress$/m);
    assert.equal(change.actor.name, "Ada Lovelace");
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: jira.fetchJira } });
});

test("poll mode makes no API request when nothing is subscribed", async () => {
  const jira = recordedJira();
  await withBroker({ jira: pollSource }, async (broker) => {
    broker.store.subscribe("watcher", "other:ABC-1");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(jira.requests.length, 0);
  }, { runtime: { fetch: jira.fetchJira } });
});

test("poll mode sends the user's token to the site and nowhere else", async () => {
  const jira = recordedJira();
  await withBroker({ jira: pollSource }, async (_broker, lines) => {
    await until(() => jira.requests.length > 0, "the first request");
    assert.equal(jira.requests[0]!.url, "https://example.atlassian.net/rest/api/3/search/jql");
    assert.equal(jira.requests[0]!.authorization, `Basic ${Buffer.from(`ada@example.com:${apiToken}`).toString("base64")}`);
    assert.ok(!lines.join("\n").includes(apiToken));
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: jira.fetchJira } });
});

test("a webhook and a poll describing the same comment store the same event record", async () => {
  const jira = recordedJira();
  let polled: EventRecord | undefined;
  await withBroker({ jira: pollSource }, async (broker) => {
    await until(() => broker.store.unread("watcher", 100).length === 3, "the poll to store its events");
    polled = broker.store.unread("watcher", 100).find((event) => event.id === "jira:comment:20001");
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: jira.fetchJira } });

  await withBroker({ jira: jiraSource }, async (broker) => {
    broker.store.subscribe("watcher", "jira:PROJ-123");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    const hooked = stored(broker, "watcher")[0]!;
    assert.deepEqual(withoutSeq(hooked), withoutSeq(polled!));
  });
});

test("with both modes on for one ticket a comment is stored once, whichever mode is first", async () => {
  const both = { ...pollSource, webhookSecret: "TEST_JIRA_WEBHOOK_SECRET" };
  const commentCount = (broker: Broker) =>
    broker.store.unread("watcher", 100).filter((event) => event.id === "jira:comment:20001").length;

  await withBroker({ jira: both }, async (broker) => {
    await until(() => commentCount(broker) === 1, "the poll to store the comment");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    assert.equal(commentCount(broker), 1);
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: recordedJira().fetchJira } });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = recordedJira(searchResponse(), gate);
  await withBroker({ jira: both }, async (broker) => {
    await until(() => held.requests.length === 1, "the poll to ask Jira");
    assert.equal(await post(broker, "jira", fixture("webhook-comment-created")), 200);
    assert.equal(commentCount(broker), 1);
    release();
    await until(() => broker.store.unread("watcher", 100).length === 3, "the poll to finish");
    assert.equal(commentCount(broker), 1);
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: held.fetchJira } });
});

test("poll mode drops events from an actor outside the allowlist, on the ignore list or carrying the marker", async () => {
  const filtered = (lines: string[]) => lines.filter((line) => line.startsWith("filtered ")).length;
  const options = (response: SearchResponse = searchResponse()) => ({
    subscriptions: ["jira:PROJ-123"],
    runtime: { fetch: recordedJira(response).fetchJira },
  });

  await withBroker({ jira: { ...pollSource, allowActors: ["Grace Hopper"] } }, async (broker, lines) => {
    await until(() => filtered(lines) === 3, "all three events to be filtered");
    assert.deepEqual(broker.store.unread("watcher", 100), []);
  }, options());

  await withBroker({ jira: { ...pollSource, ignoreActors: ["5b10a2844c20165700ede21g"] } }, async (broker, lines) => {
    await until(() => filtered(lines) === 3, "all three events to be filtered");
    assert.deepEqual(broker.store.unread("watcher", 100), []);
  }, options());

  const marked = searchResponse();
  marked.issues[0].fields.comment.comments[2].body.content[0].content[0].text += " [agent]";
  await withBroker({ jira: { ...pollSource, ignoreMarker: "[agent]" } }, async (broker, lines) => {
    await until(() => lines.filter((line) => line.startsWith("stored ")).length === 2, "the other events to be stored");
    assert.equal(filtered(lines), 1);
    assert.ok(!broker.store.unread("watcher", 100).some((event) => event.id === "jira:comment:20001"));
  }, options(marked));

  await withBroker({ jira: { ...pollSource, allowActors: ["Ada Lovelace"] } }, async (broker) => {
    await until(() => broker.store.unread("watcher", 100).length === 3, "the allowed events to be stored");
  }, options());
});

test("serve names each Jira source with its modes", async () => {
  const both = { ...pollSource, poll: { intervalSeconds: 45 }, webhookSecret: "TEST_JIRA_WEBHOOK_SECRET" };
  await withBroker({ jira: both, "jira-hooks": jiraSource, "jira-poll": pollSource }, async (_broker, lines) => {
    assert.ok(lines.includes("jira source jira (https://example.atlassian.net): poll every 45 seconds, webhook at /hooks/jira"));
    assert.ok(lines.includes("jira source jira-hooks (https://example.atlassian.net): webhook at /hooks/jira-hooks"));
    assert.ok(lines.includes("jira source jira-poll (https://example.atlassian.net): poll every 30 seconds"));
  }, { runtime: { fetch: recordedJira().fetchJira } });
});

test("a poll source whose token cannot be found stops the broker from starting and names the secret", async () => {
  const missing = { ...pollSource, token: "TEST_MISSING_TOKEN" };
  await assert.rejects(withBroker({ jira: missing }, async () => {}), /needs the secret "TEST_MISSING_TOKEN"/);
});

test("ignoreFields drops an update made only of listed fields in both modes and still answers the webhook 200", async () => {
  const both = { ...pollSource, webhookSecret: "TEST_JIRA_WEBHOOK_SECRET", ignoreFields: ["status", "resolution"] };
  const jira = recordedJira();
  await withBroker({ jira: both }, async (broker) => {
    await until(() => broker.store.unread("watcher", 100).length === 2, "the poll to store its comments");
    assert.equal(await post(broker, "jira", fixture("webhook-issue-updated")), 200);
    const types = broker.store.unread("watcher", 100).map((event) => event.type);
    assert.deepEqual(types.sort(), ["comment_created", "comment_updated"]);
  }, { subscriptions: ["jira:PROJ-123"], runtime: { fetch: jira.fetchJira } });
});
