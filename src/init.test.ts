import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCli } from "./claudeCli.js";
import { CommandNotFoundError, type RunResult, type Runner } from "./exec.js";
import { runInit, type InitDeps, type InitOptions } from "./init.js";
import { resolvePaths } from "./paths.js";
import type { Prompter } from "./prompter.js";
import { ServiceInstaller } from "./service.js";

const token = "fake-jira-token-4f2a9c";
const site = "https://example.atlassian.net";
const spec = { nodePath: "/usr/bin/node", cliPath: "/opt/sessionhook/dist/cli.js", environment: {} };

let directory: string;
let counter = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-init-"));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

class ScriptedPrompter implements Prompter {
  readonly questions: string[] = [];
  constructor(private readonly answers: string[]) {}
  private next(question: string): string {
    this.questions.push(question);
    const answer = this.answers.shift();
    assert.notEqual(answer, undefined, `no scripted answer for: ${question}`);
    return answer!;
  }
  async ask(question: string, fallback?: string) {
    return this.next(question) || fallback || "";
  }
  async confirm(question: string, fallback: boolean) {
    const answer = this.next(question);
    return answer === "" ? fallback : answer === "y";
  }
  async secret(question: string) {
    return this.next(question);
  }
  close() {}
}

function recordingRunner(answers: Record<string, Partial<RunResult> | "missing"> = {}) {
  const calls: string[] = [];
  const run: Runner = async (file, args) => {
    const line = [file, ...args].join(" ");
    calls.push(line);
    const answer = answers[line] ?? answers[file];
    if (answer === "missing") throw new CommandNotFoundError(file);
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

function jiraAnswering(status: number, body: object = { displayName: "Ada Lovelace" }) {
  const requests: Array<{ url: string; authorization: string }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, authorization: (init.headers as Record<string, string>).Authorization! });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fakeFetch, requests };
}

function setUp(
  options: { jira?: ReturnType<typeof jiraAnswering>; claude?: Record<string, Partial<RunResult> | "missing">; prompter?: Prompter } = {},
) {
  const root = join(directory, `run-${counter++}`);
  mkdirSync(root);
  const paths = resolvePaths({ SESSIONHOOK_CONFIG_DIR: join(root, "config"), SESSIONHOOK_STATE_DIR: join(root, "state") });
  const claudeRunner = recordingRunner({ "claude mcp get sessionhook": { code: 1 }, ...options.claude });
  const serviceRunner = recordingRunner();
  const jira = options.jira ?? jiraAnswering(200);
  const output: string[] = [];
  const errors: string[] = [];
  const deps: InitDeps = {
    paths,
    env: {},
    prompter: options.prompter,
    fetch: jira.fakeFetch,
    claude: new ClaudeCli(claudeRunner.run),
    services: new ServiceInstaller({ platform: "linux", home: join(root, "home"), uid: 1000, run: serviceRunner.run }),
    serviceSpec: spec,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  };
  const everything = () => [...output, ...errors].join("\n");
  return { root, paths, deps, output, errors, everything, claudeCalls: claudeRunner.calls, serviceCalls: serviceRunner.calls, jira };
}

function tokenFile(root: string, content = token, name = "token"): string {
  const file = join(root, name);
  writeFileSync(file, `${content}\n`, { mode: 0o600 });
  return file;
}

function pollOptions(root: string, extra: Partial<InitOptions> = {}): InitOptions {
  return {
    site,
    email: "ada@example.com",
    mode: "poll",
    tokenFile: tokenFile(root),
    allowActors: [],
    yes: true,
    register: false,
    service: false,
    ...extra,
  };
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("poll init verifies the token, writes a private secrets file and leaves every secret out of the config and the output", async () => {
  const { root, paths, deps, everything, jira } = setUp();
  const problems = await runInit(pollOptions(root, { allowActors: ["Ada Lovelace"], ignoreMarker: "[agent]" }), deps);
  assert.deepEqual(problems, []);

  assert.equal(jira.requests.length, 1);
  assert.equal(jira.requests[0]!.url, `${site}/rest/api/3/myself`);
  assert.equal(jira.requests[0]!.authorization, `Basic ${Buffer.from(`ada@example.com:${token}`).toString("base64")}`);
  assert.match(everything(), /Authenticated to https:\/\/example\.atlassian\.net as Ada Lovelace\./);

  assert.equal(statSync(paths.secretsFile).mode & 0o777, 0o600);
  assert.equal(statSync(paths.configDir).mode & 0o777, 0o700);
  assert.deepEqual(readJson(paths.secretsFile), { JIRA_API_TOKEN: token });
  assert.deepEqual(readJson(paths.configFile).sources.jira, {
    type: "jira",
    site,
    email: "ada@example.com",
    token: "JIRA_API_TOKEN",
    poll: {},
    allowActors: ["Ada Lovelace"],
    ignoreMarker: "[agent]",
  });

  const encodedToken = Buffer.from(`ada@example.com:${token}`).toString("base64");
  for (const text of [everything(), readFileSync(paths.configFile, "utf8")]) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(encodedToken));
  }
});

test("webhook and both modes generate a webhook secret, print the Jira settings, and never print the secret", async () => {
  const { root, paths, deps, everything, output } = setUp();
  await runInit(pollOptions(root, { mode: "both", publicUrl: "https://hooks.example.com", allowActors: ["Ada Lovelace"] }), deps);

  const secrets = readJson(paths.secretsFile);
  assert.match(secrets.JIRA_WEBHOOK_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(secrets.JIRA_API_TOKEN, token);
  const config = readJson(paths.configFile);
  assert.equal(config.publicUrl, "https://hooks.example.com");
  assert.equal(config.sources.jira.webhookSecret, "JIRA_WEBHOOK_SECRET");
  assert.equal(config.sources.jira.poll !== undefined, true);

  assert.ok(output.includes("  URL:     https://hooks.example.com/hooks/jira"));
  assert.match(everything(), /Events: {2}Issue: updated, Comment: created, Comment: updated/);
  assert.match(everything(), /node -p 'require\("[^']*secrets\.json"\)\.JIRA_WEBHOOK_SECRET'/);
  for (const text of [everything(), readFileSync(paths.configFile, "utf8")]) {
    assert.ok(!text.includes(token));
    assert.ok(!text.includes(secrets.JIRA_WEBHOOK_SECRET));
  }

  const webhookOnly = setUp();
  await runInit(
    { ...pollOptions(webhookOnly.root, { mode: "webhook", publicUrl: "https://hooks.example.com", tokenFile: undefined }) },
    webhookOnly.deps,
  );
  assert.equal(webhookOnly.jira.requests.length, 0);
  assert.deepEqual(Object.keys(readJson(webhookOnly.paths.secretsFile)), ["JIRA_WEBHOOK_SECRET"]);
  assert.equal(readJson(webhookOnly.paths.configFile).sources.jira.poll, undefined);
});

test("a token Jira refuses stops init before anything is written", async () => {
  for (const status of [401, 403]) {
    const { root, paths, deps } = setUp({ jira: jiraAnswering(status, {}) });
    await assert.rejects(
      runInit(pollOptions(root), deps),
      new RegExp(`Jira answered ${status}, so the email or the API token is wrong, nothing was written`),
    );
    assert.equal(existsSync(paths.configDir), false);
  }
});

test("a site that cannot be reached or does not look like Jira stops init before anything is written", async () => {
  const unreachable = setUp();
  unreachable.deps.fetch = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  }) as unknown as typeof fetch;
  await assert.rejects(runInit(pollOptions(unreachable.root), unreachable.deps), /Jira could not be reached at .* \(ENOTFOUND\), nothing was written/);
  assert.equal(existsSync(unreachable.paths.configDir), false);

  const wrongSite = setUp({ jira: jiraAnswering(200, { html: true }) });
  await assert.rejects(runInit(pollOptions(wrongSite.root), wrongSite.deps), /answered 200 but not like Jira/);
  assert.equal(existsSync(wrongSite.paths.configDir), false);
});

test("running init again keeps the secrets and the other sources, and does not register twice", async () => {
  const first = setUp();
  await runInit(pollOptions(first.root, { mode: "both", publicUrl: "https://hooks.example.com", register: true }), first.deps);
  assert.deepEqual(
    first.claudeCalls,
    ["claude mcp get sessionhook", "claude mcp add --scope user sessionhook -- /usr/bin/node /opt/sessionhook/dist/cli.js channel"],
  );
  const { paths } = first;
  const webhookSecret = readJson(paths.secretsFile).JIRA_WEBHOOK_SECRET;

  writeFileSync(paths.secretsFile, JSON.stringify({ ...readJson(paths.secretsFile), OTHER_SECRET: "fake-other" }), { mode: 0o600 });
  const config = readJson(paths.configFile);
  config.sources.deploys = { type: "webhook", signature: { header: "x-sig", secret: "OTHER_SECRET" }, map: { key: "repo" } };
  config.sources.jira.poll = { intervalSeconds: 45 };
  writeFileSync(paths.configFile, JSON.stringify(config));

  const second = setUp({ claude: { "claude mcp get sessionhook": { code: 0 } } });
  second.deps.paths = paths;
  await runInit(
    { site, mode: "both", yes: true, allowActors: [], register: true, service: false },
    { ...second.deps, paths },
  );
  assert.deepEqual(second.claudeCalls, ["claude mcp get sessionhook"]);
  assert.match(second.everything(), /already registered with Claude Code, left as it is/);
  assert.match(second.everything(), /already exists:/);
  assert.deepEqual(readJson(paths.secretsFile), { JIRA_API_TOKEN: token, JIRA_WEBHOOK_SECRET: webhookSecret, OTHER_SECRET: "fake-other" });
  const after = readJson(paths.configFile);
  assert.deepEqual(Object.keys(after.sources).sort(), ["deploys", "jira"]);
  assert.deepEqual(after.sources.jira.poll, { intervalSeconds: 45 });
  assert.equal(after.publicUrl, "https://hooks.example.com");
  assert.equal(second.jira.requests.length, 1);
  assert.equal(second.jira.requests[0]!.authorization, `Basic ${Buffer.from(`ada@example.com:${token}`).toString("base64")}`);
});

test("a different token replaces the stored one with --yes, and only after a yes when asking", async () => {
  const first = setUp();
  await runInit(pollOptions(first.root), first.deps);
  const { paths } = first;
  const replacement = tokenFile(first.root, "fake-replacement-token", "new-token");

  const declined = setUp({ prompter: new ScriptedPrompter(["y", "n", "", ""]) });
  await runInit(
    { site, email: "ada@example.com", mode: "poll", tokenFile: replacement, allowActors: [], yes: false, register: false, service: false },
    { ...declined.deps, paths },
  );
  assert.equal(readJson(paths.secretsFile).JIRA_API_TOKEN, token);
  assert.ok(declined.deps.prompter instanceof ScriptedPrompter);
  assert.ok(declined.deps.prompter.questions.some((question) => question.startsWith("Replace the stored JIRA_API_TOKEN")));

  const accepted = setUp();
  await runInit(pollOptions(first.root, { tokenFile: replacement }), { ...accepted.deps, paths });
  assert.equal(readJson(paths.secretsFile).JIRA_API_TOKEN, "fake-replacement-token");
});

test("a config the user does not agree to update is left alone", async () => {
  const first = setUp();
  await runInit(pollOptions(first.root), first.deps);
  const before = readFileSync(first.paths.configFile, "utf8");
  const declined = setUp({ prompter: new ScriptedPrompter(["n"]) });
  await runInit({ allowActors: [], yes: false }, { ...declined.deps, paths: first.paths });
  assert.equal(readFileSync(first.paths.configFile, "utf8"), before);
  assert.match(declined.everything(), /left the config as it was, nothing was written/);
});

test("questions fill in what the options leave out, and the typed token is stored", async () => {
  const prompter = new ScriptedPrompter([
    site, // Jira site
    "", // mode, default poll
    "ada@example.com", // email
    token, // token, typed at the hidden prompt
    "Ada Lovelace, Grace Hopper", // allowlist
    "[agent]", // ignore marker
    "n", // register
    "n", // service
  ]);
  const { paths, deps, everything } = setUp({ prompter });
  await runInit({ allowActors: [], yes: false }, deps);
  assert.equal(readJson(paths.secretsFile).JIRA_API_TOKEN, token);
  const source = readJson(paths.configFile).sources.jira;
  assert.deepEqual(source.allowActors, ["Ada Lovelace", "Grace Hopper"]);
  assert.equal(source.ignoreMarker, "[agent]");
  assert.ok(!everything().includes(token));
});

test("with --yes a missing answer is an error that names the option", async () => {
  const noSite = setUp();
  await assert.rejects(runInit({ allowActors: [], yes: true }, noSite.deps), /--site is needed when init runs with --yes/);
  const noToken = setUp();
  await assert.rejects(runInit(pollOptions(noToken.root, { tokenFile: undefined }), noToken.deps), /--token-file is needed when init runs with --yes/);
  const noUrl = setUp();
  await assert.rejects(
    runInit(pollOptions(noUrl.root, { mode: "webhook", tokenFile: undefined }), noUrl.deps),
    /--public-url is needed when init runs with --yes/,
  );
  const badMode = setUp();
  await assert.rejects(runInit(pollOptions(badMode.root, { mode: "sometimes" }), badMode.deps), /expected poll, webhook or both/);
  const unreadable = setUp();
  await assert.rejects(runInit(pollOptions(unreadable.root, { tokenFile: join(unreadable.root, "absent") }), unreadable.deps), /cannot read the token file/);
});

test("when claude is missing init prints the command to run later and carries on", async () => {
  const { root, paths, deps, output } = setUp({ claude: { claude: "missing" } });
  const problems = await runInit(pollOptions(root, { register: true }), deps);
  assert.deepEqual(problems, []);
  assert.ok(existsSync(paths.configFile));
  assert.ok(
    output.some((line) => line.includes("claude mcp add --scope user sessionhook -- /usr/bin/node /opt/sessionhook/dist/cli.js channel")),
  );
});

test("a failing claude mcp add is reported as a problem with the command to run by hand", async () => {
  const { root, deps, errors } = setUp({ claude: { "claude mcp add --scope user sessionhook -- /usr/bin/node /opt/sessionhook/dist/cli.js channel": { code: 1, stderr: "denied" } } });
  const problems = await runInit(pollOptions(root, { register: true }), deps);
  assert.deepEqual(problems, ["could not register the channel server"]);
  assert.match(errors.join("\n"), /denied[\s\S]*claude mcp add --scope user sessionhook/);
});

test("--no-register never starts claude, and the service is installed only when asked", async () => {
  const skipped = setUp();
  await runInit(pollOptions(skipped.root), skipped.deps);
  assert.deepEqual(skipped.claudeCalls, []);
  assert.deepEqual(skipped.serviceCalls, []);

  const installed = setUp();
  const problems = await runInit(pollOptions(installed.root, { service: true }), installed.deps);
  assert.deepEqual(problems, []);
  assert.deepEqual(installed.serviceCalls.slice(0, 2), ["systemctl --user daemon-reload", "systemctl --user enable --now sessionhook.service"]);
  assert.ok(!installed.output.some((line) => line.includes("sessionhook serve ")));
});

test("a service that cannot be installed is reported with the fallback and does not undo the setup", async () => {
  const { root, paths, deps, errors, output } = setUp();
  deps.services = new ServiceInstaller({
    platform: "linux",
    home: join(root, "home"),
    uid: 1,
    run: recordingRunner({ systemctl: { code: 1, stderr: "no bus" } }).run,
  });
  const problems = await runInit(pollOptions(root, { service: true }), deps);
  assert.deepEqual(problems, ["could not install the service"]);
  assert.match(errors.join("\n"), /no bus[\s\S]*sessionhook serve/);
  assert.ok(existsSync(paths.configFile));
  assert.ok(output.some((line) => line.includes("sessionhook serve ")));
});

const cli = new URL("./cli.js", import.meta.url).pathname;

test("the init command refuses a token given as an option", () => {
  for (const flag of ["--token=abc", "--token"]) {
    const result = spawnSync(process.execPath, [cli, "init", flag, "abc"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the token is not accepted as an option, pass --token-file/);
  }
});

test("the init command in webhook mode writes a private secrets file and prints no secret", () => {
  const root = join(directory, "command");
  const env = { SESSIONHOOK_CONFIG_DIR: join(root, "config"), SESSIONHOOK_STATE_DIR: join(root, "state"), HOME: root, PATH: process.env.PATH! };
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", "--site", site, "--mode", "webhook", "--public-url", "https://hooks.example.com", "--no-register", "--no-service"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const secretsFile = join(root, "config", "secrets.json");
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  const secret = readJson(secretsFile).JIRA_WEBHOOK_SECRET;
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.ok(!(result.stdout + result.stderr + readFileSync(join(root, "config", "config.json"), "utf8")).includes(secret));
  assert.match(result.stdout, /URL: {5}https:\/\/hooks\.example\.com\/hooks\/jira/);
});
