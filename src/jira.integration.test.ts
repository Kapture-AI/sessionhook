// Runs real brokers in this process on port 0 with temporary directories. The Jira site is never
// contacted, and webhooks are posted over loopback with a made-up secret.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerFromFiles, type Broker } from "./broker.js";
import type { EventRecord } from "./event.js";
import { resolvePaths } from "./paths.js";
import { fixture, site } from "./sources/jiraFixtures.test.js";

const webhookSecret = "fake-jira-webhook-secret";
const root = mkdtempSync(join(tmpdir(), "sessionhook-jira-"));
after(() => rmSync(root, { recursive: true, force: true }));

const jiraSource = { type: "jira", site, webhookSecret: "TEST_JIRA_WEBHOOK_SECRET" };

let brokerCount = 0;
async function withBroker(
  sources: Record<string, object>,
  run: (broker: Broker, lines: string[]) => Promise<void>,
): Promise<void> {
  const directory = join(root, `broker-${brokerCount++}`);
  mkdirSync(join(directory, "config"), { recursive: true });
  writeFileSync(join(directory, "config", "config.json"), JSON.stringify({ listen: { port: 0 }, sources }));
  const paths = resolvePaths({
    SESSIONHOOK_CONFIG_DIR: join(directory, "config"),
    SESSIONHOOK_STATE_DIR: join(directory, "state"),
  });
  const lines: string[] = [];
  const broker = await startBrokerFromFiles(paths, { TEST_JIRA_WEBHOOK_SECRET: webhookSecret }, (line) => lines.push(line));
  try {
    await run(broker, lines);
  } finally {
    await broker.stop();
  }
}

function post(broker: Broker, source: string, payload: object, secret = webhookSecret): Promise<number> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Promise((resolve, reject) => {
    request(
      {
        host: "127.0.0.1",
        port: broker.webhookPort,
        path: `/hooks/${source}`,
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
