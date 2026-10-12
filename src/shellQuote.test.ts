import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { quoteArgument, quoteCommand } from "./shellQuote.js";

test("plain words are left alone and everything else is single quoted", () => {
  assert.equal(quoteArgument("server:sessionhook"), "server:sessionhook");
  assert.equal(quoteArgument("/usr/bin/node"), "/usr/bin/node");
  assert.equal(quoteArgument("two words"), "'two words'");
  assert.equal(quoteArgument(""), "''");
  assert.equal(quoteArgument("it's"), `'it'\\''s'`);
});

test("a shell reads back exactly the arguments that were quoted", () => {
  const hostile = [
    "plain",
    "two  words",
    "it's a 'quoted' word",
    "$(touch /should/not/run) `id` $HOME ${HOME}",
    'double "quotes" and \\ backslash',
    "semi; colon && pipe | redirect > file",
    "line one\nline two",
    "*.ts ~ ! #",
    "",
  ];
  const printArguments = `printf '%s\\0' ${quoteCommand(hostile)}`;
  const result = spawnSync("/bin/sh", ["-c", printArguments], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), hostile);
});
