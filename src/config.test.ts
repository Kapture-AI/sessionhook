import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig, type WebhookSourceConfig } from "./config.js";

const validSource = {
  type: "webhook",
  signature: { header: "X-Hub-Signature-256", prefix: "sha256=", secret: "DEPLOYS_WEBHOOK_SECRET" },
  map: { key: "repository.full_name" },
};

test("an empty config gets the loopback listener and no sources", () => {
  assert.deepEqual(validateConfig({}), {
    listen: { host: "127.0.0.1", port: 8377 },
    spawn: { claudeFlags: [] },
    sources: {},
  });
});

test("publicUrl and spawn settings are read", () => {
  const config = validateConfig({
    publicUrl: "https://hooks.example.com",
    spawn: { claudeFlags: ["--model", "some-model"], prompt: "Wait for events." },
  });
  assert.equal(config.publicUrl, "https://hooks.example.com");
  assert.deepEqual(config.spawn, { claudeFlags: ["--model", "some-model"], prompt: "Wait for events." });
});

test("a source gets its defaults and a lowercase header name", () => {
  const config = validateConfig({ sources: { deploys: validSource } });
  assert.deepEqual(config.sources.deploys, {
    type: "webhook",
    signature: { header: "x-hub-signature-256", prefix: "sha256=", secret: "DEPLOYS_WEBHOOK_SECRET" },
    map: { key: "repository.full_name" },
    allowActors: [],
    ignoreActors: [],
    ignoreMarker: "",
  });
});

test("a full source keeps every mapped field and filter", () => {
  const map = {
    key: "a", id: "b", type: "c", actorId: "d", actorName: "e", at: "f", url: "g", summary: "h",
  };
  const config = validateConfig({
    listen: { host: "10.0.0.5", port: 0 },
    sources: {
      deploys: { ...validSource, map, allowActors: ["ada"], ignoreActors: ["bot"], ignoreMarker: "[bot]" },
    },
  });
  assert.deepEqual(config.listen, { host: "10.0.0.5", port: 0 });
  assert.deepEqual((config.sources.deploys as WebhookSourceConfig).map, map);
  assert.deepEqual(config.sources.deploys!.allowActors, ["ada"]);
  assert.equal(config.sources.deploys!.ignoreMarker, "[bot]");
});

test("errors name the offending key", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /^config must be an object/],
    [{ listen: { port: "80" } }, /^listen\.port must be an integer/],
    [{ listen: { port: 70000 } }, /^listen\.port must be an integer/],
    [{ listen: { host: 5 } }, /^listen\.host must be a non-empty string/],
    [{ listen: { hots: "x" } }, /^listen\.hots is not a known setting/],
    [{ sources: { deploys: { ...validSource, type: "ftp" } } }, /^sources\.deploys\.type is "ftp", expected "webhook" or "jira"/],
    [{ sources: { deploys: { ...validSource, signature: undefined } } }, /^sources\.deploys\.signature must be an object/],
    [{ sources: { deploys: { ...validSource, signature: { header: "h" } } } }, /^sources\.deploys\.signature\.secret must be a non-empty string/],
    [{ sources: { deploys: { ...validSource, map: {} } } }, /^sources\.deploys\.map\.key must be a non-empty string/],
    [{ sources: { deploys: { ...validSource, map: { key: "a", sumary: "b" } } } }, /^sources\.deploys\.map\.sumary is not a known setting/],
    [{ sources: { deploys: { ...validSource, allowActors: "ada" } } }, /^sources\.deploys\.allowActors must be a list/],
    [{ sources: { deploys: { ...validSource, ignoreActors: [""] } } }, /^sources\.deploys\.ignoreActors must be a list/],
    [{ sources: { deploys: { ...validSource, ignoreMarker: 3 } } }, /^sources\.deploys\.ignoreMarker must be a string/],
    [{ publicUrl: "http://hooks.example.com" }, /^publicUrl must be an https origin with no path, such as https:\/\/hooks\.example\.com/],
    [{ publicUrl: "https://hooks.example.com/hooks" }, /^publicUrl must be an https origin with no path/],
    [{ publicUrl: "hooks" }, /^publicUrl must be an https address/],
    [{ publicUrl: "" }, /^publicUrl must be a non-empty string/],
    [{ spawn: { claudeFlags: "--model" } }, /^spawn\.claudeFlags must be a list of non-empty strings/],
    [{ spawn: { prompt: "" } }, /^spawn\.prompt must be a non-empty string/],
    [{ spawn: { flags: [] } }, /^spawn\.flags is not a known setting/],
    [{ sources: { Deploys: validSource } }, /^sources\.Deploys is not a valid source name/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => validateConfig(raw), { message }, JSON.stringify(raw));
  }
});

let directory: string;
before(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-config-"));
});
after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test("a missing config file means the defaults", () => {
  assert.deepEqual(loadConfig(join(directory, "absent.json")).sources, {});
});

test("loading reports the file with the offending key or the JSON error", () => {
  const bad = join(directory, "bad.json");
  writeFileSync(bad, JSON.stringify({ listen: { port: "x" } }));
  assert.throws(() => loadConfig(bad), { message: `${bad}: listen.port must be an integer from 0 to 65535` });
  writeFileSync(bad, "{");
  assert.throws(() => loadConfig(bad), new RegExp(`${bad}: `));
});

test("loading returns a valid file's config", () => {
  const good = join(directory, "good.json");
  writeFileSync(good, JSON.stringify({ sources: { deploys: validSource } }));
  assert.deepEqual(Object.keys(loadConfig(good).sources), ["deploys"]);
});

const jiraSource = {
  type: "jira",
  site: "https://example.atlassian.net",
  email: "ada@example.com",
  token: "JIRA_API_TOKEN",
  poll: {},
  webhookSecret: "JIRA_WEBHOOK_SECRET",
};

test("a jira source gets the default poll interval and empty filters", () => {
  assert.deepEqual(validateConfig({ sources: { jira: jiraSource } }).sources.jira, {
    type: "jira",
    site: "https://example.atlassian.net",
    email: "ada@example.com",
    token: "JIRA_API_TOKEN",
    poll: { intervalSeconds: 30 },
    webhookSecret: "JIRA_WEBHOOK_SECRET",
    ignoreFields: [],
    allowActors: [],
    ignoreActors: [],
    ignoreMarker: "",
  });
});

test("a jira source can poll only or take webhooks only", () => {
  const { webhookSecret: _, ...pollOnly } = jiraSource;
  const polling = validateConfig({ sources: { jira: { ...pollOnly, poll: { intervalSeconds: 5 } } } }).sources.jira;
  assert.deepEqual((polling as { poll: object }).poll, { intervalSeconds: 5 });
  assert.equal("webhookSecret" in polling!, false);

  const { poll: __, email: ___, token: ____, ...webhookOnly } = jiraSource;
  const hooked = validateConfig({ sources: { jira: webhookOnly } }).sources.jira!;
  assert.equal("poll" in hooked, false);
  assert.equal("email" in hooked, false);
});

test("a jira site is reduced to its origin and a trailing slash is accepted", () => {
  const config = validateConfig({ sources: { jira: { ...jiraSource, site: "https://example.atlassian.net/" } } });
  assert.equal((config.sources.jira as { site: string }).site, "https://example.atlassian.net");
});

test("jira source errors name the offending key", () => {
  const withJira = (changes: object) => ({ sources: { jira: { ...jiraSource, ...changes } } });
  const cases: Array<[unknown, RegExp]> = [
    [withJira({ site: undefined }), /^sources\.jira\.site must be a non-empty string/],
    [withJira({ site: "http://example.atlassian.net" }), /^sources\.jira\.site must be an https origin with no path/],
    [withJira({ site: "https://example.atlassian.net/jira" }), /^sources\.jira\.site must be an https origin with no path/],
    [withJira({ site: "https://user@example.atlassian.net" }), /^sources\.jira\.site must be an https origin/],
    [withJira({ site: "not a url" }), /^sources\.jira\.site must be an https address/],
    [withJira({ poll: { intervalSeconds: 4 } }), /^sources\.jira\.poll\.intervalSeconds must be an integer of at least 5/],
    [withJira({ poll: { intervalSeconds: "30" } }), /^sources\.jira\.poll\.intervalSeconds must be an integer/],
    [withJira({ poll: { interval: 30 } }), /^sources\.jira\.poll\.interval is not a known setting/],
    [withJira({ poll: 30 }), /^sources\.jira\.poll must be an object/],
    [withJira({ email: undefined }), /^sources\.jira\.email must be a non-empty string/],
    [withJira({ token: undefined }), /^sources\.jira\.token must be a non-empty string/],
    [withJira({ poll: undefined, webhookSecret: undefined }), /^sources\.jira\.poll or sources\.jira\.webhookSecret is needed/],
    [withJira({ webhookSecret: "" }), /^sources\.jira\.webhookSecret must be a non-empty string/],
    [withJira({ signature: {} }), /^sources\.jira\.signature is not a known setting/],
    [withJira({ ignoreFields: "Rank" }), /^sources\.jira\.ignoreFields must be a list/],
    [withJira({ ignoreFields: [""] }), /^sources\.jira\.ignoreFields must be a list/],
    [withJira({ allowActors: "ada" }), /^sources\.jira\.allowActors must be a list/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => validateConfig(raw), { message }, JSON.stringify(raw));
  }
});

test("ignoreFields is kept as written", () => {
  const config = validateConfig({ sources: { jira: { ...jiraSource, ignoreFields: ["Attachment", "Rank"] } } });
  assert.deepEqual((config.sources.jira as { ignoreFields: string[] }).ignoreFields, ["Attachment", "Rank"]);
});
