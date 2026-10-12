import { test } from "node:test";
import assert from "node:assert/strict";
import { checkJiraAccount } from "./jiraAccount.js";

function answering(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

test("a working token names the account", async () => {
  const result = await checkJiraAccount("https://example.atlassian.net", "ada@example.com", "t", answering(200, '{"displayName":"Ada Lovelace"}'));
  assert.deepEqual(result, { ok: true, displayName: "Ada Lovelace" });
});

test("401 and 403 are a wrong email or token, other statuses and bodies are unexpected", async () => {
  for (const status of [401, 403]) {
    const result = await checkJiraAccount("https://example.atlassian.net", "a@b.c", "t", answering(status, ""));
    assert.equal(result.ok === false && result.kind, "rejected");
  }
  const server = await checkJiraAccount("https://example.atlassian.net", "a@b.c", "t", answering(500, ""));
  assert.equal(server.ok === false && server.kind, "unexpected");
  const html = await checkJiraAccount("https://example.atlassian.net", "a@b.c", "t", answering(200, "<html>"));
  assert.equal(html.ok === false && html.kind, "unexpected");
});

test("a network error is unreachable and carries the cause but no credentials", async () => {
  const failing = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  const result = await checkJiraAccount("https://example.atlassian.net", "a@b.c", "secret-token", failing);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "unreachable" && result.message.includes("ECONNREFUSED"));
  assert.ok(!JSON.stringify(result).includes("secret-token"));
});
