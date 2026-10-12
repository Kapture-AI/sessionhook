import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../cli.js", import.meta.url).pathname;
const secretValue = "fake-serve-secret-value";

let directory: string;
let environment: Record<string, string>;
const running: ChildProcess[] = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-serve-"));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  environment = { SESSIONHOOK_CONFIG_DIR: configDir, SESSIONHOOK_STATE_DIR: stateDir };
});

after(() => {
  for (const child of running) child.kill("SIGKILL");
  rmSync(directory, { recursive: true, force: true });
});

function writeConfig(config: object): void {
  const configDir = environment.SESSIONHOOK_CONFIG_DIR!;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config));
}

function serve(extra: Record<string, string> = {}) {
  const child = spawn(process.execPath, [cli, "serve"], {
    env: { ...environment, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return { child, stderr: () => stderr };
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(condition(), "timed out waiting");
}

test("serve logs its addresses and sources, never the secret, and stops cleanly on SIGTERM", async () => {
  writeConfig({
    listen: { port: 0 },
    sources: {
      deploys: {
        type: "webhook",
        signature: { header: "x-sig", secret: "SERVE_TEST_SECRET" },
        map: { key: "repo" },
      },
    },
  });
  const { child, stderr } = serve({ SERVE_TEST_SECRET: secretValue });
  await until(() => stderr().includes("local API on"));
  assert.match(stderr(), /webhook listener on http:\/\/127\.0\.0\.1:\d+, sources: deploys/);
  assert.ok(stderr().includes(join(environment.SESSIONHOOK_STATE_DIR!, "broker.sock")));
  assert.ok(existsSync(join(environment.SESSIONHOOK_STATE_DIR!, "broker.sock")));

  const second = spawnSync(process.execPath, [cli, "serve"], {
    env: { ...environment, SERVE_TEST_SECRET: secretValue },
    encoding: "utf8",
  });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /a broker is already running/);

  child.kill("SIGTERM");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.match(stderr(), /shutting down/);
  assert.ok(!stderr().includes(secretValue));
  assert.equal(existsSync(join(environment.SESSIONHOOK_STATE_DIR!, "broker.sock")), false);
});

test("serve exits with a message naming the secret when it cannot be found", () => {
  const result = spawnSync(process.execPath, [cli, "serve"], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs the secret "SERVE_TEST_SECRET"/);
});

test("serve exits with a message naming the offending config key", () => {
  writeConfig({ listen: { port: "eighty" } });
  const result = spawnSync(process.execPath, [cli, "serve"], { env: environment, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /listen\.port must be an integer/);
});
