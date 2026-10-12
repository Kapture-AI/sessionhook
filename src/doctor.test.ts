import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBrokerFromFiles } from "./broker.js";
import { ClaudeCli } from "./claudeCli.js";
import { BrokerClient, BrokerNotRunningError } from "./client.js";
import { runDoctor, formatReport, type CheckResult, type DoctorDeps } from "./doctor.js";
import { CommandNotFoundError, type RunResult, type Runner } from "./exec.js";
import { resolvePaths } from "./paths.js";

const root = mkdtempSync(join(tmpdir(), "sessionhook-doctor-"));
after(() => rmSync(root, { recursive: true, force: true }));

const site = "https://example.atlassian.net";
const secrets = { JIRA_API_TOKEN: "fake-doctor-token", JIRA_WEBHOOK_SECRET: "fake-doctor-webhook-secret" };
let counter = 0;

function claudeRunner(answers: Record<string, Partial<RunResult> | "missing"> = {}): Runner {
  return async (file, args) => {
    const line = [file, ...args].join(" ");
    const answer = answers[line] ?? answers[file];
    if (answer === "missing") throw new CommandNotFoundError(file);
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
}

const healthyClaude = {
  "claude --version": { stdout: "2.1.296 (Claude Code)\n" },
  "claude mcp get sessionhook": { code: 0 },
};

function jiraAnswering(status: number) {
  return async () => new Response(JSON.stringify({ displayName: "Ada Lovelace" }), { status });
}

type Setup = {
  config?: object;
  secrets?: Record<string, string>;
  client?: DoctorDeps["client"];
  fetch?: typeof fetch;
  claude?: Record<string, Partial<RunResult> | "missing">;
};

function deps(setup: Setup): DoctorDeps {
  const directory = join(root, `case-${counter++}`);
  mkdirSync(join(directory, "config"), { recursive: true });
  if (setup.config) writeFileSync(join(directory, "config", "config.json"), JSON.stringify(setup.config));
  writeFileSync(join(directory, "config", "secrets.json"), JSON.stringify(setup.secrets ?? secrets));
  chmodSync(join(directory, "config", "secrets.json"), 0o600);
  const paths = resolvePaths({ SESSIONHOOK_CONFIG_DIR: join(directory, "config"), SESSIONHOOK_STATE_DIR: join(directory, "state") });
  return {
    paths,
    env: {},
    client: setup.client ?? { status: async () => [] },
    fetch: setup.fetch ?? (jiraAnswering(200) as unknown as typeof fetch),
    claude: new ClaudeCli(claudeRunner(setup.claude ?? healthyClaude)),
    registerCommand: "claude mcp add --scope user sessionhook -- /node /cli.js channel",
  };
}

const pollConfig = {
  sources: { jira: { type: "jira", site, email: "ada@example.com", token: "JIRA_API_TOKEN", poll: {} } },
};
const webhookConfig = {
  publicUrl: "https://hooks.example.com",
  sources: { jira: { type: "jira", site, webhookSecret: "JIRA_WEBHOOK_SECRET" } },
};

function byName(results: CheckResult[], name: string): CheckResult {
  const found = results.find((result) => result.name === name);
  assert.ok(found, `no check named ${name} in ${results.map((r) => r.name).join(", ")}`);
  return found;
}

test("everything healthy in poll mode gives ok for every check", async () => {
  const results = await runDoctor(deps({ config: pollConfig }));
  assert.deepEqual(results.map((r) => [r.name, r.status]), [
    ["config", "ok"],
    ["broker", "ok"],
    ["jira token (jira)", "ok"],
    ["claude code", "ok"],
  ]);
  assert.match(byName(results, "jira token (jira)").detail, /authenticated as Ada Lovelace/);
  assert.match(byName(results, "claude code").detail, /2\.1\.296.*registered/);
});

test("a broker that is down fails the broker check by name", async () => {
  const results = await runDoctor(deps({ config: pollConfig, client: { status: async () => { throw new BrokerNotRunningError(); } } }));
  assert.equal(byName(results, "broker").status, "FAIL");
  assert.match(byName(results, "broker").detail, /start it with `sessionhook serve`/);
  assert.deepEqual(results.filter((r) => r.status === "FAIL").map((r) => r.name), ["broker"]);
});

test("a wrong Jira token fails the token check and says the email or token is wrong", async () => {
  for (const status of [401, 403]) {
    const results = await runDoctor(deps({ config: pollConfig, fetch: jiraAnswering(status) as unknown as typeof fetch }));
    assert.equal(byName(results, "jira token (jira)").status, "FAIL");
    assert.match(byName(results, "jira token (jira)").detail, /the email or the API token is wrong/);
  }
});

test("a Jira that cannot be reached fails the token check and says so", async () => {
  const failing = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } }); }) as unknown as typeof fetch;
  const results = await runDoctor(deps({ config: pollConfig, fetch: failing }));
  assert.match(byName(results, "jira token (jira)").detail, /Jira could not be reached.*ETIMEDOUT/);
});

test("a config that does not load, or a secret that is missing, fails the config check", async () => {
  const noConfig = await runDoctor(deps({ config: { sources: { jira: { type: "jira", site: "http://x" } } } }));
  assert.equal(byName(noConfig, "config").status, "FAIL");
  assert.deepEqual(noConfig.map((r) => r.name), ["config", "broker", "claude code"]);

  const noSecret = await runDoctor(deps({ config: pollConfig, secrets: {} }));
  assert.match(byName(noSecret, "config").detail, /the secret JIRA_API_TOKEN was found in neither/);
  assert.equal(byName(noSecret, "jira token (jira)").status, "skip");
});

test("without publicUrl the webhook check is skipped with the reason", async () => {
  const { publicUrl: _unused, ...withoutUrl } = webhookConfig;
  const results = await runDoctor(deps({ config: withoutUrl }));
  assert.equal(byName(results, "public URL (jira)").status, "skip");
  assert.match(byName(results, "public URL (jira)").detail, /publicUrl is not set/);
});

test("the public URL check tells apart a wrong secret, a wrong address and no connection", async () => {
  const answering = (status: number, body = "{}") => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const unauthorized = await runDoctor(deps({ config: webhookConfig, fetch: answering(401) }));
  assert.match(byName(unauthorized, "public URL (jira)").detail, /rejected the signature.*different broker or the webhook secret differs/);
  const notFound = await runDoctor(deps({ config: webhookConfig, fetch: answering(404) }));
  assert.match(byName(notFound, "public URL (jira)").detail, /answered 404, which is not this broker's listener.*127\.0\.0\.1:8377/);
  const somethingElse = await runDoctor(deps({ config: webhookConfig, fetch: answering(200, "<html>") }));
  assert.match(byName(somethingElse, "public URL (jira)").detail, /answered 200 but not like the listener/);
  const unreachable = await runDoctor(
    deps({ config: webhookConfig, fetch: (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }) as unknown as typeof fetch }),
  );
  assert.match(byName(unreachable, "public URL (jira)").detail, /could not be reached \(ENOTFOUND\)/);
  for (const results of [unauthorized, notFound, somethingElse, unreachable]) assert.equal(byName(results, "public URL (jira)").status, "FAIL");
});

test("the probe is signed with the webhook secret and a real listener answers it with ok", async () => {
  const setup = deps({ config: { ...webhookConfig, listen: { port: 0 } } });
  const broker = await startBrokerFromFiles(setup.paths, secrets, () => {});
  try {
    const requests: Array<{ url: string; body: string }> = [];
    setup.client = new BrokerClient(setup.paths.socketFile);
    setup.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: String(init.body) });
      return fetch(`http://127.0.0.1:${broker.webhookPort}${new URL(url).pathname}${new URL(url).search}`, init);
    }) as unknown as typeof fetch;
    const results = await runDoctor(setup);
    assert.equal(byName(results, "public URL (jira)").status, "ok", byName(results, "public URL (jira)").detail);
    assert.equal(byName(results, "broker").status, "ok");
    assert.equal(requests[0]!.url, "https://hooks.example.com/hooks/jira?probe=doctor");
    assert.equal(JSON.parse(requests[0]!.body).webhookEvent, "sessionhook:doctor");
    assert.deepEqual(broker.store.status(), []);

    const wrongSecret = deps({ config: { ...webhookConfig, listen: { port: 0 } }, secrets: { ...secrets, JIRA_WEBHOOK_SECRET: "another-secret" } });
    wrongSecret.fetch = setup.fetch;
    assert.match(byName(await runDoctor(wrongSecret), "public URL (jira)").detail, /rejected the signature/);
  } finally {
    await broker.stop();
  }
});

test("claude states: missing is skipped, too old and unregistered fail", async () => {
  const missing = await runDoctor(deps({ config: pollConfig, claude: { claude: "missing" } }));
  assert.equal(byName(missing, "claude code").status, "skip");
  assert.match(byName(missing, "claude code").detail, /`sessionhook wait` needs nothing from Claude Code/);

  const oldRegistered = await runDoctor(deps({ config: pollConfig, claude: { ...healthyClaude, "claude --version": { stdout: "2.1.79 (Claude Code)" } } }));
  assert.equal(byName(oldRegistered, "claude code").status, "FAIL");
  assert.match(byName(oldRegistered, "claude code").detail, /too old for channels, 2\.1\.80 or later/);

  const oldUnregistered = await runDoctor(
    deps({ config: pollConfig, claude: { "claude --version": { stdout: "2.1.79 (Claude Code)" }, "claude mcp get sessionhook": { code: 1 } } }),
  );
  assert.equal(byName(oldUnregistered, "claude code").status, "skip");
  assert.match(byName(oldUnregistered, "claude code").detail, /2\.1\.79 \(Claude Code\) is older than 2\.1\.80 and the sessionhook channel server is not registered, so channel delivery is not set up\. `sessionhook wait` works without it\. For channel delivery, use Claude Code 2\.1\.80 or later and run: claude mcp add/);

  const unregistered = await runDoctor(deps({ config: pollConfig, claude: { ...healthyClaude, "claude mcp get sessionhook": { code: 1 } } }));
  assert.equal(byName(unregistered, "claude code").status, "skip");
  assert.match(
    byName(unregistered, "claude code").detail,
    /^2\.1\.296 \(Claude Code\), but the sessionhook channel server is not registered, so channel delivery is not set up\. `sessionhook wait` works without it\. For channel delivery run: claude mcp add --scope user/,
  );
  assert.deepEqual(unregistered.filter((r) => r.status === "FAIL"), []);
});

test("the report has one aligned line per check", () => {
  assert.deepEqual(
    formatReport([
      { name: "broker", status: "ok", detail: "fine" },
      { name: "public URL (jira)", status: "FAIL", detail: "bad" },
      { name: "claude code", status: "skip", detail: "none" },
    ]),
    [
      "ok    broker             fine",
      "FAIL  public URL (jira)  bad",
      "skip  claude code        none",
    ],
  );
});

test("the doctor command exits non-zero and names each failing check", () => {
  const home = join(root, "command");
  mkdirSync(join(home, "config"), { recursive: true });
  // Webhook mode without a public address makes no network request.
  const { publicUrl: _unused, ...offline } = webhookConfig;
  writeFileSync(join(home, "config", "config.json"), JSON.stringify(offline));
  writeFileSync(join(home, "config", "secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  const cli = new URL("./cli.js", import.meta.url).pathname;
  const env = { SESSIONHOOK_CONFIG_DIR: join(home, "config"), SESSIONHOOK_STATE_DIR: join(home, "state"), PATH: "/nonexistent" };
  const result = spawnSync(process.execPath, [cli, "doctor"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^FAIL {2}broker/m);
  assert.match(result.stdout, /^skip {2}claude code/m);
  assert.match(result.stdout, /Claude Team or Enterprise have channels off/);
  assert.match(result.stdout, /^skip {2}public URL \(jira\)/m);
  assert.match(result.stderr, /sessionhook: 1 check failed: broker/);
  assert.ok(!(result.stdout + result.stderr).includes(secrets.JIRA_WEBHOOK_SECRET));
});
