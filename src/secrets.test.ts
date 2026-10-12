import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupSecret } from "./secrets.js";

let directory: string;
let counter = 0;

before(() => {
  directory = mkdtempSync(join(tmpdir(), "sessionhook-secrets-"));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function secretsFile(content: string, mode: number): string {
  const file = join(directory, `secrets-${counter++}.json`);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

test("a secret is read from the secrets file", () => {
  const file = secretsFile('{"HOOK_SECRET":"fake-from-file"}', 0o600);
  assert.equal(lookupSecret("HOOK_SECRET", file, {}), "fake-from-file");
});

test("a secret missing from the file falls back to the environment", () => {
  const file = secretsFile('{"OTHER":"x"}', 0o600);
  assert.equal(lookupSecret("HOOK_SECRET", file, { HOOK_SECRET: "fake-from-env" }), "fake-from-env");
});

test("the file wins over the environment", () => {
  const file = secretsFile('{"HOOK_SECRET":"fake-from-file"}', 0o600);
  assert.equal(lookupSecret("HOOK_SECRET", file, { HOOK_SECRET: "fake-from-env" }), "fake-from-file");
});

test("a missing secrets file is not an error and the environment still works", () => {
  const missing = join(directory, "absent.json");
  assert.equal(lookupSecret("HOOK_SECRET", missing, { HOOK_SECRET: "fake-from-env" }), "fake-from-env");
  assert.equal(lookupSecret("HOOK_SECRET", missing, {}), undefined);
});

test("a name found nowhere is undefined", () => {
  assert.equal(lookupSecret("HOOK_SECRET", secretsFile("{}", 0o600), {}), undefined);
});

test("a secrets file readable by the group is refused with the reason", () => {
  const file = secretsFile('{"HOOK_SECRET":"fake"}', 0o640);
  assert.throws(() => lookupSecret("HOOK_SECRET", file, {}), /refusing to read .*mode is 640.*chmod 600/);
});

test("a secrets file readable by everyone is refused even when the environment has the value", () => {
  const file = secretsFile('{"HOOK_SECRET":"fake"}', 0o644);
  assert.throws(() => lookupSecret("HOOK_SECRET", file, { HOOK_SECRET: "fake" }), /refusing to read/);
});

test("a secrets file that is not a flat object of strings is rejected", () => {
  assert.throws(() => lookupSecret("A", secretsFile("[]", 0o600), {}), /must be a JSON object/);
  assert.throws(() => lookupSecret("A", secretsFile('{"A":1}', 0o600), {}), /"A" must be a string/);
  assert.throws(() => lookupSecret("A", secretsFile("{", 0o600), {}), /not valid JSON/);
});

test("a secret is read from the file that NAME_FILE names, trimmed", () => {
  const holder = secretsFile("fake-from-named-file\n", 0o600);
  const none = secretsFile("{}", 0o600);
  assert.equal(lookupSecret("HOOK_SECRET", none, { HOOK_SECRET_FILE: holder }), "fake-from-named-file");
});

test("the secrets file and the plain variable both win over NAME_FILE", () => {
  const holder = secretsFile("fake-from-named-file", 0o600);
  const withValue = secretsFile('{"HOOK_SECRET":"fake-from-file"}', 0o600);
  const none = secretsFile("{}", 0o600);
  assert.equal(lookupSecret("HOOK_SECRET", withValue, { HOOK_SECRET_FILE: holder }), "fake-from-file");
  assert.equal(
    lookupSecret("HOOK_SECRET", none, { HOOK_SECRET: "fake-from-env", HOOK_SECRET_FILE: holder }),
    "fake-from-env",
  );
});

test("a NAME_FILE readable by the group is refused with the reason", () => {
  const holder = secretsFile("fake-from-named-file", 0o640);
  const none = secretsFile("{}", 0o600);
  assert.throws(
    () => lookupSecret("HOOK_SECRET", none, { HOOK_SECRET_FILE: holder }),
    /refusing to read .*mode is 640.*chmod 600/,
  );
});

test("a NAME_FILE that cannot be read names the variable, and an empty one gives no secret", () => {
  const none = secretsFile("{}", 0o600);
  assert.throws(
    () => lookupSecret("HOOK_SECRET", none, { HOOK_SECRET_FILE: join(directory, "absent") }),
    /HOOK_SECRET_FILE points at .*absent, which cannot be read/,
  );
  assert.equal(lookupSecret("HOOK_SECRET", none, { HOOK_SECRET_FILE: secretsFile("\n", 0o600) }), undefined);
});
