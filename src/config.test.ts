import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "./config.js";

const validSource = {
  type: "webhook",
  signature: { header: "X-Hub-Signature-256", prefix: "sha256=", secret: "DEPLOYS_WEBHOOK_SECRET" },
  map: { key: "repository.full_name" },
};

test("an empty config gets the loopback listener and no sources", () => {
  assert.deepEqual(validateConfig({}), {
    listen: { host: "127.0.0.1", port: 8377 },
    sources: {},
  });
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
  assert.deepEqual(config.sources.deploys!.map, map);
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
    [{ sources: { deploys: { ...validSource, type: "jira" } } }, /^sources\.deploys\.type is "jira", only "webhook"/],
    [{ sources: { deploys: { ...validSource, signature: undefined } } }, /^sources\.deploys\.signature must be an object/],
    [{ sources: { deploys: { ...validSource, signature: { header: "h" } } } }, /^sources\.deploys\.signature\.secret must be a non-empty string/],
    [{ sources: { deploys: { ...validSource, map: {} } } }, /^sources\.deploys\.map\.key must be a non-empty string/],
    [{ sources: { deploys: { ...validSource, map: { key: "a", sumary: "b" } } } }, /^sources\.deploys\.map\.sumary is not a known setting/],
    [{ sources: { deploys: { ...validSource, allowActors: "ada" } } }, /^sources\.deploys\.allowActors must be a list/],
    [{ sources: { deploys: { ...validSource, ignoreActors: [""] } } }, /^sources\.deploys\.ignoreActors must be a list/],
    [{ sources: { deploys: { ...validSource, ignoreMarker: 3 } } }, /^sources\.deploys\.ignoreMarker must be a string/],
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
