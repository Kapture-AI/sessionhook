import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "./broker.js";
import { validateConfig } from "./config.js";
import { resolvePaths } from "./paths.js";
import { WebhookSource } from "./sources/webhook.js";

const secret = "fake-test-secret";

const sourceConfig = {
  type: "webhook",
  signature: { header: "X-Hub-Signature-256", prefix: "sha256=", secret: "FAKE" },
  map: { key: "repository.full_name", id: "delivery.id", actorName: "sender.login", summary: "message" },
};

const config = validateConfig({
  listen: { host: "127.0.0.1", port: 0 },
  sources: {
    deploys: sourceConfig,
    quiet: { ...sourceConfig, ignoreMarker: "[agent]", allowActors: ["ada"] },
  },
});

let directory: string;
let broker: Broker;
let lines: string[];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-listener-"));
  const paths = resolvePaths({
    SESSIONHOOK_CONFIG_DIR: join(directory, "config"),
    SESSIONHOOK_STATE_DIR: join(directory, "state"),
  });
  lines = [];
  broker = await Broker.start({
    paths,
    config,
    sources: Object.fromEntries(
      Object.entries(config.sources).map(([name, source]) => [name, new WebhookSource(name, source, secret)]),
    ),
    log: (line) => lines.push(line),
  });
  broker.store.subscribe("watcher", "deploys:org/web");
  broker.store.subscribe("watcher", "quiet:org/web");
});

after(async () => {
  await broker.stop();
  rmSync(directory, { recursive: true, force: true });
});

function sign(body: string, key = secret): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port: broker.webhookPort, path, method: "POST", agent: false, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function signedPost(path: string, payload: object) {
  const body = JSON.stringify(payload);
  return post(path, body, { "X-Hub-Signature-256": sign(body), "Content-Type": "application/json" });
}

function unreadFor(name: string): string[] {
  return broker.store.unread(name, 100).map((event) => event.id);
}

function acknowledgeAll(name: string): void {
  const seqs = broker.store.unread(name, 1000).map((event) => event.seq);
  if (seqs.length > 0) broker.store.ack(name, Math.max(...seqs));
}

test("a correctly signed POST is stored as one event and the same request sent twice is stored once", async () => {
  acknowledgeAll("watcher");
  const payload = { repository: { full_name: "org/web" }, delivery: { id: 1 }, message: "first" };
  const first = await signedPost("/hooks/deploys", payload);
  const second = await signedPost("/hooks/deploys", payload);
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), { results: ["stored"] });
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(second.body), { results: ["duplicate"] });
  assert.deepEqual(unreadFor("watcher"), ["deploys:1"]);
});

test("a POST with a wrong signature gets 401 and stores nothing", async () => {
  acknowledgeAll("watcher");
  const body = JSON.stringify({ repository: { full_name: "org/web" }, delivery: { id: 2 } });
  const wrong = await post("/hooks/deploys", body, { "X-Hub-Signature-256": sign(body, "another-secret") });
  const missing = await post("/hooks/deploys", body);
  assert.equal(wrong.status, 401);
  assert.equal(missing.status, 401);
  assert.deepEqual(unreadFor("watcher"), []);
});

test("an unknown source, another path and another method get 404", async () => {
  const body = "{}";
  assert.equal((await post("/hooks/nothing", body)).status, 404);
  assert.equal((await post("/status", body)).status, 404);
  assert.equal((await post("/", body)).status, 404);
  const get = await new Promise<number>((resolve, reject) => {
    request(
      { host: "127.0.0.1", port: broker.webhookPort, path: "/hooks/deploys", agent: false },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    )
      .on("error", reject)
      .end();
  });
  assert.equal(get, 404);
});

test("a signed body that is not JSON or lacks the key gets 400", async () => {
  const notJson = "not json";
  const response = await post("/hooks/deploys", notJson, { "X-Hub-Signature-256": sign(notJson) });
  assert.equal(response.status, 400);
  assert.equal((await signedPost("/hooks/deploys", { delivery: { id: 3 } })).status, 400);
  assert.ok(lines.some((line) => line.startsWith("rejected deploys:")));
});

test("a body over 1 MB gets 413 and stores nothing", async () => {
  acknowledgeAll("watcher");
  const body = JSON.stringify({ repository: { full_name: "org/web" }, delivery: { id: 4 }, message: "x".repeat(1024 * 1024) });
  const response = await post("/hooks/deploys", body, { "X-Hub-Signature-256": sign(body) });
  assert.equal(response.status, 413);
  assert.deepEqual(unreadFor("watcher"), []);
});

test("a filtered event gets 200, is not stored and is logged with the rule", async () => {
  acknowledgeAll("watcher");
  const fromOther = await signedPost("/hooks/quiet", { repository: { full_name: "org/web" }, delivery: { id: 5 }, sender: { login: "grace" } });
  const marked = await signedPost("/hooks/quiet", { repository: { full_name: "org/web" }, delivery: { id: 6 }, sender: { login: "ada" }, message: "done [agent]" });
  const allowed = await signedPost("/hooks/quiet", { repository: { full_name: "org/web" }, delivery: { id: 7 }, sender: { login: "ada" }, message: "hello" });
  assert.deepEqual(JSON.parse(fromOther.body), { results: ["filtered"] });
  assert.deepEqual(JSON.parse(marked.body), { results: ["filtered"] });
  assert.deepEqual(JSON.parse(allowed.body), { results: ["stored"] });
  assert.deepEqual(unreadFor("watcher"), ["quiet:7"]);
  assert.ok(lines.includes("filtered quiet:org/web by allowActors"));
  assert.ok(lines.includes("filtered quiet:org/web by ignoreMarker"));
});

test("log lines never contain the secret or a request body", async () => {
  await signedPost("/hooks/deploys", { repository: { full_name: "org/web" }, delivery: { id: 8 }, message: "sensitive-body-text" });
  const everything = lines.join("\n");
  assert.ok(!everything.includes(secret));
  assert.ok(!everything.includes("sensitive-body-text"));
});

test("a store failure gets 500 so the sender retries", async () => {
  const other = mkdtempSync(join(tmpdir(), "sessionhook-listener-fail-"));
  const paths = resolvePaths({ SESSIONHOOK_STATE_DIR: join(other, "state") });
  const failing = await Broker.start({
    paths,
    config,
    sources: { deploys: new WebhookSource("deploys", config.sources.deploys!, secret) },
    log: () => {},
  });
  try {
    const database = new DatabaseSync(paths.databaseFile);
    database.exec("DROP TABLE events");
    database.close();
    const body = JSON.stringify({ repository: { full_name: "org/web" }, delivery: { id: 9 } });
    const response = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        { host: "127.0.0.1", port: failing.webhookPort, path: "/hooks/deploys", method: "POST", agent: false, headers: { "X-Hub-Signature-256": sign(body) } },
        (reply) => {
          reply.resume();
          resolve(reply.statusCode!);
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
    assert.equal(response, 500);
  } finally {
    await failing.stop();
    rmSync(other, { recursive: true, force: true });
  }
});
