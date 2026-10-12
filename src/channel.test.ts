// Each test starts the built `channel` command through the MCP SDK's client, as Claude Code would,
// against a broker started in this process on port 0 with temporary directories.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBrokerFromFiles, type Broker } from "./broker.js";
import { BrokerClient } from "./client.js";
import { resolvePaths } from "./paths.js";

const cliPath = new URL("./cli.js", import.meta.url).pathname;
const secret = "fake-channel-secret";

let directory: string;
let environment: Record<string, string>;
let broker: Broker;
const sessions: Session[] = [];

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-channel-"));
  const configDir = join(directory, "config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      listen: { port: 0 },
      sources: {
        deploys: {
          type: "webhook",
          signature: { header: "X-Hub-Signature-256", prefix: "sha256=", secret: "CHANNEL_SECRET" },
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
  environment = { SESSIONHOOK_CONFIG_DIR: configDir, SESSIONHOOK_STATE_DIR: join(directory, "state") };
  broker = await startBroker();
});

after(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  await broker.stop();
  rmSync(directory, { recursive: true, force: true });
});

function startBroker(): Promise<Broker> {
  return startBrokerFromFiles(resolvePaths(environment), { CHANNEL_SECRET: secret }, () => {});
}

type Notification = { method: string; params?: { content?: string; meta?: Record<string, string> } };

class Session {
  readonly notifications: Notification[] = [];
  private constructor(
    readonly client: Client,
    private stderr: string,
  ) {}

  static async start(subscriber?: string): Promise<Session> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, "channel"],
      env: { ...environment, ...(subscriber && { SESSIONHOOK_SUBSCRIBER: subscriber }) },
      stderr: "pipe",
    });
    const client = new Client({ name: "test-claude-code", version: "0.0.0" });
    const session = new Session(client, "");
    transport.stderr?.on("data", (chunk: Buffer) => (session.stderr += chunk.toString()));
    client.fallbackNotificationHandler = async (notification) => {
      session.notifications.push(notification as Notification);
    };
    await client.connect(transport);
    sessions.push(session);
    return session;
  }

  async call(name: string, args: Record<string, unknown> = {}) {
    const result = await this.client.callTool({ name, arguments: args });
    const content = result.content as Array<{ type: string; text: string }>;
    return { isError: result.isError === true, text: content[0]!.text };
  }

  channelMessages(): Notification[] {
    return this.notifications.filter((notification) => notification.method === "notifications/claude/channel");
  }

  get log(): string {
    return this.stderr;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function deliver(repository: string, deliveryId: number): Promise<number> {
  const body = JSON.stringify({
    repository: { full_name: repository },
    delivery: { id: deliveryId },
    action: "deployed",
    sender: { login: "Ada Lovelace" },
    html_url: `https://example.com/deploys/${deliveryId}`,
    message: `deploy ${deliveryId}`,
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

async function until(condition: () => boolean | Promise<boolean>, what: string, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts && !(await condition()); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await condition(), `timed out waiting for ${what}`);
}

const socketClient = () => new BrokerClient(resolvePaths(environment).socketFile);

async function unreadFor(name: string): Promise<number | undefined> {
  return (await socketClient().status()).find((subscriber) => subscriber.name === name)?.unread;
}

test("the initialize result declares the channel capability, the tools and the instructions", async () => {
  const session = await Session.start("init-one");
  assert.deepEqual(session.client.getServerCapabilities()?.experimental?.["claude/channel"], {});
  assert.match(session.client.getInstructions() ?? "", /outside events/);
  assert.match(session.client.getInstructions() ?? "", /written by other people/);
  const { tools } = await session.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["subscribe", "unsubscribe", "list_subscriptions"]);
  for (const tool of tools) assert.ok(tool.description && tool.inputSchema.type === "object", tool.name);
});

test("after subscribe by tool call a signed event arrives as a channel notification and is acknowledged", async () => {
  const session = await Session.start("deliver-one");
  const subscribed = await session.call("subscribe", { topic: "deploys:org/one" });
  assert.equal(subscribed.isError, false);
  assert.match(subscribed.text, /Subscribed to deploys:org\/one/);

  assert.equal(await deliver("org/one", 1001), 200);
  await until(() => session.channelMessages().length === 1, "the notification");
  const [message] = session.channelMessages();
  assert.match(
    message!.params!.content!,
    /^#\d+ deploys:org\/one deployed\nby Ada Lovelace at \d{4}-\d\d-\d\dT[\d:.]+Z\nhttps:\/\/example\.com\/deploys\/1001\ndeploy 1001$/,
  );
  assert.deepEqual(message!.params!.meta, {
    topic: "deploys:org/one",
    event_type: "deployed",
    seq: message!.params!.meta!.seq,
    actor: "Ada Lovelace",
    at: message!.params!.meta!.at,
    url: "https://example.com/deploys/1001",
  });
  assert.match(message!.params!.meta!.seq!, /^\d+$/);
  await until(async () => (await unreadFor("deliver-one")) === 0, "the broker to show the event acknowledged");
});

test("a second topic subscribed by tool call receives its next event", async () => {
  const session = await Session.start("second-topic");
  await session.call("subscribe", { topic: "deploys:org/first" });
  await session.call("subscribe", { topic: "deploys:org/second" });
  await deliver("org/second", 1101);
  await until(() => session.channelMessages().length === 1, "the notification");
  assert.equal(session.channelMessages()[0]!.params!.meta!.topic, "deploys:org/second");
});

test("two channel servers with different names on one topic each get exactly one copy", async () => {
  const first = await Session.start("pair-one");
  const second = await Session.start("pair-two");
  await first.call("subscribe", { topic: "deploys:org/pair" });
  await second.call("subscribe", { topic: "deploys:org/pair" });
  await deliver("org/pair", 1201);
  await until(() => first.channelMessages().length === 1 && second.channelMessages().length === 1, "both copies");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(first.channelMessages().length, 1);
  assert.equal(second.channelMessages().length, 1);
  assert.equal(first.channelMessages()[0]!.params!.meta!.seq, second.channelMessages()[0]!.params!.meta!.seq);
});

test("a channel server stopped while three events arrive gets all three in order when started again", async () => {
  const first = await Session.start("away-one");
  await first.call("subscribe", { topic: "deploys:org/away" });
  await first.close();

  for (const id of [1301, 1302, 1303]) assert.equal(await deliver("org/away", id), 200);

  const second = await Session.start("away-one");
  await until(() => second.channelMessages().length === 3, "three notifications");
  assert.deepEqual(
    second.channelMessages().map((message) => message.params!.meta!.url),
    [1301, 1302, 1303].map((id) => `https://example.com/deploys/${id}`),
  );
  await until(async () => (await unreadFor("away-one")) === 0, "all three acknowledged");
});

test("list_subscriptions returns only this server's own topics and unread count", async () => {
  const mine = await Session.start("list-mine");
  const other = await Session.start("list-other");
  await mine.call("subscribe", { topic: "deploys:org/mine" });
  await other.call("subscribe", { topic: "deploys:org/theirs" });
  const listed = await mine.call("list_subscriptions");
  assert.equal(listed.isError, false);
  assert.deepEqual(JSON.parse(listed.text), { topics: ["deploys:org/mine"], unread: 0 });
  assert.ok(!listed.text.includes("theirs"));

  await mine.call("unsubscribe", { topic: "deploys:org/mine" });
  assert.deepEqual(JSON.parse((await mine.call("list_subscriptions")).text).topics, []);
});

test("list_subscriptions for a subscriber the broker does not know yet is an empty list", async () => {
  const session = await Session.start("list-fresh");
  const listed = await session.call("list_subscriptions");
  assert.equal(listed.isError, false);
  assert.deepEqual(JSON.parse(listed.text), { topics: [], unread: 0 });
});

test("an invalid topic is an error result and the server keeps answering", async () => {
  const session = await Session.start("invalid-topic");
  const bad = await session.call("subscribe", { topic: "nocolon" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid topic "nocolon"/);
  const missing = await session.call("subscribe", {});
  assert.equal(missing.isError, true);
  assert.match(missing.text, /topic is required/);
  const unknown = await session.call("no_such_tool");
  assert.equal(unknown.isError, true);
  assert.equal((await session.call("list_subscriptions")).isError, false);
});

test("without a subscriber name the server starts and every tool call says so", async () => {
  const session = await Session.start();
  const result = await session.call("subscribe", { topic: "deploys:org/anon" });
  assert.equal(result.isError, true);
  assert.match(result.text, /no subscriber name/);
  assert.match(session.log, /no subscriber name/);
});

test("with the broker stopped a tool call says so, and delivery resumes when it is started again", async () => {
  const session = await Session.start("reconnect-one");
  await session.call("subscribe", { topic: "deploys:org/reconnect" });
  await broker.stop();
  try {
    const result = await session.call("list_subscriptions");
    assert.equal(result.isError, true);
    assert.match(result.text, /the broker is not running/);
    await until(() => session.log.includes("the broker is not running"), "the log line");
  } finally {
    broker = await startBroker();
  }
  await deliver("org/reconnect", 1401);
  await until(() => session.channelMessages().length === 1, "delivery after the broker came back", 400);
  await until(() => session.log.includes("the broker is back"), "the recovery log line");
  assert.equal(session.log.match(/the broker is not running/g)?.length, 1);
});

test("the server exits with status 0 when stdin closes, even while a long-poll is open, and writes only protocol frames to stdout", async () => {
  await socketClient().subscribe("exit-one", "deploys:org/exit");
  const child = spawn(process.execPath, [cliPath, "channel"], {
    env: { ...environment, SESSIONHOOK_SUBSCRIBER: "exit-one" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const frame = (message: object) => `${JSON.stringify(message)}\n`;
  child.stdin.write(
    frame({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }),
  );
  await until(() => stdout.includes('"id":1'), "the initialize reply");
  child.stdin.write(frame({ jsonrpc: "2.0", method: "notifications/initialized" }));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const closed = once(child, "exit");
  child.stdin.end();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  const [code] = await closed;
  clearTimeout(timeout);
  assert.equal(code, 0);
  for (const line of stdout.split("\n").filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, "2.0");
});
