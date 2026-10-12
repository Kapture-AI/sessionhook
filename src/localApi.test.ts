import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "./broker.js";
import { BrokerClient } from "./client.js";
import { validateConfig } from "./config.js";
import type { NewEvent } from "./event.js";
import { resolvePaths } from "./paths.js";

const config = validateConfig({
  listen: { port: 0 },
  sources: {
    deploys: {
      type: "webhook",
      signature: { header: "x-sig", secret: "FAKE" },
      map: { key: "repo" },
    },
  },
});

let directory: string;
let paths: ReturnType<typeof resolvePaths>;
let broker: Broker;
let client: BrokerClient;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-api-"));
  paths = resolvePaths({ SESSIONHOOK_STATE_DIR: join(directory, "state") });
  broker = await Broker.start({ paths, config, sources: {}, log: () => {} });
  client = new BrokerClient(paths.socketFile);
});

after(async () => {
  await broker.stop();
  rmSync(directory, { recursive: true, force: true });
});

function arrive(topic: string): void {
  const event: NewEvent = {
    id: `deploys:${counter++}`,
    topic,
    type: "deploy",
    actor: { id: "1", name: "Ada Lovelace" },
    at: "2026-10-12T10:00:00.000Z",
    url: "",
    summary: "",
  };
  broker.intake("deploys", [event]);
}

test("subscribe then events returns what arrives afterwards and ack clears it", async () => {
  await client.subscribe("api-a", "deploys:one");
  arrive("deploys:one");
  arrive("deploys:other");
  const events = await client.events("api-a", 0);
  assert.deepEqual(events.map((event) => event.topic), ["deploys:one"]);
  await client.ack("api-a", events[0]!.seq);
  assert.deepEqual(await client.events("api-a", 0), []);
});

test("events held open return as soon as a matching event arrives", async () => {
  await client.subscribe("api-b", "deploys:held");
  const started = Date.now();
  const pending = client.events("api-b", 30);
  setTimeout(() => arrive("deploys:held"), 100);
  const events = await pending;
  assert.equal(events.length, 1);
  assert.ok(Date.now() - started < 5000);
});

test("an event on another topic does not end the wait early", async () => {
  await client.subscribe("api-c", "deploys:mine");
  const started = Date.now();
  const pending = client.events("api-c", 1);
  setTimeout(() => arrive("deploys:not-mine"), 100);
  assert.deepEqual(await pending, []);
  assert.ok(Date.now() - started >= 900);
});

test("a wait that runs out returns an empty list", async () => {
  await client.subscribe("api-d", "deploys:quiet");
  assert.deepEqual(await client.events("api-d", 0.2), []);
});

test("reading events updates last seen", async () => {
  await client.subscribe("api-e", "deploys:seen");
  const lastSeen = async () => (await client.status()).find((s) => s.name === "api-e")!.lastSeen;
  const before = await lastSeen();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await client.events("api-e", 0);
  assert.notEqual(await lastSeen(), before);
});

test("unsubscribe reports whether a subscription was removed", async () => {
  await client.subscribe("api-f", "deploys:gone");
  assert.equal(await client.unsubscribe("api-f", "deploys:gone"), true);
  assert.equal(await client.unsubscribe("api-f", "deploys:gone"), false);
});

test("rewind makes events unread again and reports how many", async () => {
  await client.subscribe("api-g", "deploys:replayed");
  arrive("deploys:replayed");
  arrive("deploys:replayed");
  const events = await client.events("api-g", 0);
  await client.ack("api-g", events[1]!.seq);
  assert.equal(await client.rewind("api-g", events[0]!.seq), 2);
});

test("an unknown subscriber is told to subscribe first", async () => {
  await assert.rejects(client.events("api-nobody", 0), /unknown subscriber "api-nobody", subscribe to a topic first/);
  await assert.rejects(client.ack("api-nobody", 1), /subscribe to a topic first/);
  await assert.rejects(client.rewind("api-nobody", 1), /subscribe to a topic first/);
});

test("bad input is a 400 with a message", async () => {
  await assert.rejects(client.subscribe("api-h", "no-colon"), /invalid topic/);
  await assert.rejects(client.subscribe("bad name", "deploys:x"), /invalid subscriber name/);
});

function rawStatus(options: { socketPath?: string; port?: number; method: string; path: string; body?: string }): Promise<number> {
  const { body, ...target } = options;
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", agent: false, ...target }, (response) => {
      response.resume();
      resolve(response.statusCode!);
    })
      .on("error", reject)
      .end(body);
  });
}

test("the local API is not reachable through the webhook listener's port", async () => {
  const port = broker.webhookPort;
  assert.equal(await rawStatus({ socketPath: paths.socketFile, method: "GET", path: "/status" }), 200);
  const body = JSON.stringify({ subscriber: "through-listener", topic: "deploys:x", seq: 1 });
  for (const [method, path] of [
    ["GET", "/status"],
    ["GET", "/events?subscriber=api-a"],
    ["POST", "/subscribe"],
    ["POST", "/ack"],
    ["POST", "/rewind"],
    ["POST", "/unsubscribe"],
  ] as const) {
    assert.equal(await rawStatus({ port, method, path, body: method === "POST" ? body : undefined }), 404, `${method} ${path}`);
  }
  assert.equal((await client.status()).some((s) => s.name === "through-listener"), false);
});

test("a second broker on the same state directory refuses to start and leaves the first working", async () => {
  await assert.rejects(
    Broker.start({ paths, config, sources: {}, log: () => {} }),
    /a broker is already running/,
  );
  assert.ok(Array.isArray(await client.status()));
});

// A process killed with SIGKILL leaves its socket file behind, as a crashed broker would.
async function leaveStaleSocket(file: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", "require('node:net').createServer().listen(process.argv[1], () => console.log('ready'))", file],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
}

test("the client says the broker is not running when the socket is missing or refuses", async () => {
  const missing = new BrokerClient(join(directory, "nothing.sock"));
  await assert.rejects(missing.status(), /broker is not running.*sessionhook serve/);

  const staleSocket = join(directory, "stale.sock");
  await leaveStaleSocket(staleSocket);
  assert.ok(existsSync(staleSocket));
  await assert.rejects(new BrokerClient(staleSocket).status(), /broker is not running/);
});

test("a stale socket file is removed on start, and stopping removes the socket", async () => {
  const stateDirectory = join(directory, "second");
  const secondPaths = resolvePaths({ SESSIONHOOK_STATE_DIR: stateDirectory });
  const first = await Broker.start({ paths: secondPaths, config, sources: {}, log: () => {} });
  const socketFile = secondPaths.socketFile;
  await first.stop();
  assert.equal(existsSync(socketFile), false);

  await leaveStaleSocket(socketFile);
  const second = await Broker.start({ paths: secondPaths, config, sources: {}, log: () => {} });
  assert.ok(Array.isArray(await new BrokerClient(socketFile).status()));
  await second.stop();
  assert.equal(existsSync(socketFile), false);
});

test("stopping a broker releases a held events request with an empty list", async () => {
  const stateDirectory = join(directory, "third");
  const thirdPaths = resolvePaths({ SESSIONHOOK_STATE_DIR: stateDirectory });
  const third = await Broker.start({ paths: thirdPaths, config, sources: {}, log: () => {} });
  const thirdClient = new BrokerClient(thirdPaths.socketFile);
  await thirdClient.subscribe("api-stop", "deploys:x");
  const pending = thirdClient.events("api-stop", 60);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await third.stop();
  assert.deepEqual(await pending, []);
});
