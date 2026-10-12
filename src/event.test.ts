import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTopic } from "./event.js";

test("parses a source and key", () => {
  assert.deepEqual(parseTopic("jira:PROJ-123"), { source: "jira", key: "PROJ-123" });
});

test("keeps colons and slashes in the key", () => {
  assert.deepEqual(parseTopic("webhook:org/repo"), { source: "webhook", key: "org/repo" });
  assert.deepEqual(parseTopic("webhook:a:b:c"), { source: "webhook", key: "a:b:c" });
});

test("accepts digits and hyphens in the source", () => {
  assert.deepEqual(parseTopic("my-source2:key"), { source: "my-source2", key: "key" });
});

test("rejects a missing separator", () => {
  assert.throws(() => parseTopic("jira"), /invalid topic "jira"/);
});

test("rejects an empty source or key", () => {
  assert.throws(() => parseTopic(":key"), /invalid topic/);
  assert.throws(() => parseTopic("jira:"), /invalid topic/);
  assert.throws(() => parseTopic(""), /invalid topic/);
});

test("rejects a source with uppercase letters or other characters", () => {
  assert.throws(() => parseTopic("Jira:PROJ-123"), /invalid topic/);
  assert.throws(() => parseTopic("ji_ra:PROJ-123"), /invalid topic/);
  assert.throws(() => parseTopic("ji ra:PROJ-123"), /invalid topic/);
});

test("rejects a key that spans lines", () => {
  assert.throws(() => parseTopic("jira:PROJ-1\nPROJ-2"), /invalid topic/);
});
