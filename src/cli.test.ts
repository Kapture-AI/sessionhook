import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { commands } from "./commands/index.js";

const cli = new URL("./cli.js", import.meta.url).pathname;
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function run(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

test("--version prints the package version", () => {
  const output = execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(output, `${packageVersion}\n`);
});

test("--help and no arguments list every command", () => {
  for (const args of [["--help"], ["-h"], []]) {
    const result = run(...args);
    assert.equal(result.status, 0);
    for (const name of Object.keys(commands)) {
      assert.match(result.stdout, new RegExp(`^  ${name}\\b`, "m"));
    }
  }
});

test("an unknown command exits non-zero and names the command", () => {
  const result = run("frobnicate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command "frobnicate"/);
  assert.equal(result.stdout, "");
});

test("an unknown option exits non-zero", () => {
  const result = run("--frobnicate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /frobnicate/);
});
