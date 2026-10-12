// Each test runs the built CLI as a child process against a broker started in this process
// on port 0 with temporary directories, so nothing here touches the host's own configuration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerFromFiles, type Broker } from "./broker.js";
import { resolvePaths } from "./paths.js";

const cliPath = new URL("./cli.js", import.meta.url).pathname;
const secret = "fake-integration-secret";

let directory: string;
let broker: Broker;
let environment: Record<string, string>;
const children: ChildProcess[] = [];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-integration-"));
  const configDir = join(directory, "config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      listen: { port: 0 },
      sources: {
        deploys: {
          type: "webhook",
          signature: { header: "X-Hub-Signature-256", prefix: "sha256=", secret: "INTEGRATION_SECRET" },
          map: {
            key: "repository.full_name",
            id: "delivery.id",
            type: "action",
            actorName: "sender.login",
            url: "html_url",
            summary: "message",
          },
        },
      },
    }),
  );
  environment = {
    SESSIONHOOK_CONFIG_DIR: configDir,
    SESSIONHOOK_STATE_DIR: join(directory, "state"),
  };
  broker = await startBrokerFromFiles(resolvePaths(environment), { INTEGRATION_SECRET: secret }, () => {});
});

after(async () => {
  for (const child of children) child.kill("SIGKILL");
  await broker.stop();
  rmSync(directory, { recursive: true, force: true });
});

type Finished = { status: number | null; stdout: string; stderr: string };

function start(args: string[], extraEnvironment: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: { ...environment, ...extraEnvironment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => (output.stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk.toString()));
  const finished = once(child, "close").then(([status]): Finished => ({ status, ...output }));
  return { child, output, finished };
}

function sessionhook(args: string[], extraEnvironment: Record<string, string> = {}): Promise<Finished> {
  return start(args, extraEnvironment).finished;
}

function deliver(repository: string, deliveryId: number, extra: object = {}): Promise<number> {
  const body = JSON.stringify({
    repository: { full_name: repository },
    delivery: { id: deliveryId },
    action: "deployed",
    sender: { login: "Ada Lovelace" },
    html_url: `https://example.com/deploys/${deliveryId}`,
    message: `deploy ${deliveryId}`,
    ...extra,
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return new Promise((resolve, reject) => {
    request(
      {
        host: "127.0.0.1",
        port: broker.webhookPort,
        path: "/hooks/deploys",
        method: "POST",
        agent: false,
        headers: { "X-Hub-Signature-256": signature },
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

test("status lists each subscriber with its topics and unread count", async () => {
  await sessionhook(["subscribe", "deploys:org/status-a", "--name", "status-one"]);
  await sessionhook(["subscribe", "deploys:org/status-b", "--name", "status-one"]);
  await sessionhook(["subscribe", "deploys:org/status-a", "--name", "status-two"]);
  assert.equal(await deliver("org/status-a", 1001), 200);
  assert.equal(await deliver("org/status-a", 1002), 200);
  assert.equal(await deliver("org/status-b", 1003), 200);

  const json = await sessionhook(["status", "--json"]);
  assert.equal(json.status, 0);
  const subscribers = JSON.parse(json.stdout) as Array<{ name: string; topics: string[]; unread: number }>;
  const summary = (name: string) => subscribers.find((s) => s.name === name);
  assert.deepEqual(summary("status-one")?.topics, ["deploys:org/status-a", "deploys:org/status-b"]);
  assert.equal(summary("status-one")?.unread, 3);
  assert.deepEqual(summary("status-two")?.topics, ["deploys:org/status-a"]);
  assert.equal(summary("status-two")?.unread, 2);

  const text = await sessionhook(["status"]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^SUBSCRIBER\s+TOPICS\s+UNREAD\s+LAST SEEN$/m);
  assert.match(text.stdout, /^status-one\s+deploys:org\/status-a, deploys:org\/status-b\s+3\s+\d{4}-/m);
  assert.match(text.stdout, /^status-two\s+deploys:org\/status-a\s+2\s+\d{4}-/m);
});

test("status says when there are no subscribers", async () => {
  const other = mkdtempSync(join(tmpdir(), "sessionhook-empty-"));
  const empty = await startBrokerFromFiles(
    resolvePaths({ SESSIONHOOK_CONFIG_DIR: join(other, "c"), SESSIONHOOK_STATE_DIR: join(other, "s") }),
    {},
    () => {},
  );
  try {
    const result = await sessionhook(["status"], {
      SESSIONHOOK_CONFIG_DIR: join(other, "c"),
      SESSIONHOOK_STATE_DIR: join(other, "s"),
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /no subscribers yet/);
  } finally {
    await empty.stop();
    rmSync(other, { recursive: true, force: true });
  }
});

test("unsubscribe removes the subscription and says so when there was none", async () => {
  await sessionhook(["subscribe", "deploys:org/unsub", "--name", "unsub-one"]);
  const first = await sessionhook(["unsubscribe", "deploys:org/unsub", "--name", "unsub-one"]);
  assert.match(first.stdout, /no longer subscribed/);
  const second = await sessionhook(["unsubscribe", "deploys:org/unsub", "--name", "unsub-one"]);
  assert.match(second.stdout, /was not subscribed/);
});

test("the subscriber name comes from --name, then SESSIONHOOK_SUBSCRIBER, then CLAUDE_CODE_SESSION_ID", async () => {
  await sessionhook(["subscribe", "deploys:org/names", "--name", "from-flag"], {
    SESSIONHOOK_SUBSCRIBER: "from-env",
    CLAUDE_CODE_SESSION_ID: "from-session",
  });
  await sessionhook(["subscribe", "deploys:org/names"], {
    SESSIONHOOK_SUBSCRIBER: "from-env",
    CLAUDE_CODE_SESSION_ID: "from-session",
  });
  await sessionhook(["subscribe", "deploys:org/names"], { CLAUDE_CODE_SESSION_ID: "from-session" });
  const names = JSON.parse((await sessionhook(["status", "--json"])).stdout).map((s: { name: string }) => s.name);
  for (const expected of ["from-flag", "from-env", "from-session"]) assert.ok(names.includes(expected), expected);
});

test("a command without a subscriber name fails and says how to pass one", async () => {
  const result = await sessionhook(["subscribe", "deploys:org/anon"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pass --name <name> or set SESSIONHOOK_SUBSCRIBER/);
});

test("an invalid topic is refused before the broker is contacted", async () => {
  const result = await sessionhook(["subscribe", "nocolon", "--name", "x"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid topic "nocolon"/);
});

test("commands say the broker is not running when it is not", async () => {
  const result = await sessionhook(["status"], { SESSIONHOOK_STATE_DIR: join(directory, "no-broker-here") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the broker is not running, start it with `sessionhook serve`/);
});

test("commands other than serve do not load the experimental SQLite module", async () => {
  const result = await sessionhook(["status"]);
  assert.equal(result.stderr, "");
});
