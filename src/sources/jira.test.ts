import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { JiraSourceConfig } from "../config.js";
import { BadPayloadError } from "../source.js";
import { JiraSource } from "./jira.js";
import { fixture, site } from "./jiraFixtures.test.js";

const secret = "fake-jira-webhook-secret";

const config: JiraSourceConfig = {
  type: "jira",
  site,
  webhookSecret: "JIRA_WEBHOOK_SECRET",
  ignoreFields: [],
  allowActors: [],
  ignoreActors: [],
  ignoreMarker: "",
};

const source = new JiraSource("jira", config, secret);

function request(payload: unknown, signWith: string | null = secret) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const headers = signWith === null
    ? {}
    : { "x-hub-signature": `sha256=${createHmac("sha256", signWith).update(rawBody).digest("hex")}` };
  return { headers, rawBody };
}

test("a body signed with the webhook secret authenticates", () => {
  assert.equal(source.authenticate(request(fixture("webhook-comment-created"))), true);
});

test("a wrong secret, a missing header and the generic header name are rejected", () => {
  const payload = fixture("webhook-comment-created");
  assert.equal(source.authenticate(request(payload, "another-secret")), false);
  assert.equal(source.authenticate(request(payload, null)), false);
  const signed = request(payload);
  const renamed = { ...signed, headers: { "x-hub-signature-256": signed.headers["x-hub-signature"]! } };
  assert.equal(source.authenticate(renamed), false);
});

test("a source without a webhook secret authenticates nothing", () => {
  const pollOnly = new JiraSource("jira", { ...config, webhookSecret: undefined }, undefined);
  assert.equal(pollOnly.authenticate(request(fixture("webhook-comment-created"))), false);
});

test("comment_created becomes a comment_created event", () => {
  assert.deepEqual(source.parse(request(fixture("webhook-comment-created"))), [
    {
      id: "jira:comment:20001",
      topic: "jira:PROJ-123",
      type: "comment_created",
      actor: { id: "5b10a2844c20165700ede21g", name: "Ada Lovelace" },
      at: "2026-10-12T09:56:41.681Z",
      url: "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001",
      summary: "Deploy check passed, safe to ignore.",
    },
  ]);
});

test("comment_updated becomes a comment_updated event with the update time in its id", () => {
  const payload = fixture("webhook-comment-created");
  payload.webhookEvent = "comment_updated";
  payload.comment.body = "  Deploy check passed after a rerun.  ";
  payload.comment.updated = "2026-10-12T14:05:00.000+0400";
  payload.comment.updateAuthor = { accountId: "5b10ac8d82e05b22cc7d4ef5", displayName: "Grace Hopper" };
  assert.deepEqual(source.parse(request(payload)), [
    {
      id: "jira:comment:20001:updated:1791799500000",
      topic: "jira:PROJ-123",
      type: "comment_updated",
      actor: { id: "5b10ac8d82e05b22cc7d4ef5", name: "Grace Hopper" },
      at: "2026-10-12T10:05:00.000Z",
      url: "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001",
      summary: "Deploy check passed after a rerun.",
    },
  ]);
});

test("jira:issue_updated becomes an issue_updated event named by the changelog id", () => {
  assert.deepEqual(source.parse(request(fixture("webhook-issue-updated"))), [
    {
      id: "jira:changelog:30001",
      topic: "jira:PROJ-123",
      type: "issue_updated",
      actor: { id: "5b10a2844c20165700ede21g", name: "Ada Lovelace" },
      at: "2026-10-12T09:36:10.213Z",
      url: "https://example.atlassian.net/browse/PROJ-123",
      summary: "status: To Do -> In Progress\nresolution: none -> Done",
    },
  ]);
});

test("an issue update without changelog items produces no events", () => {
  const payload = fixture("webhook-issue-updated");
  delete payload.changelog;
  assert.deepEqual(source.parse(request(payload)), []);
  payload.changelog = { id: "1", items: [] };
  assert.deepEqual(source.parse(request(payload)), []);
});

test("event kinds the source does not translate produce no events", () => {
  for (const webhookEvent of ["jira:issue_created", "comment_deleted", "sprint_started", undefined]) {
    assert.deepEqual(source.parse(request({ webhookEvent, issue: { key: "not a key" } })), [], String(webhookEvent));
  }
});

test("payloads that cannot become an event are bad payloads", () => {
  assert.throws(() => source.parse({ headers: {}, rawBody: Buffer.from("not json") }), BadPayloadError);
  const withoutIssue = fixture("webhook-comment-created");
  delete withoutIssue.issue;
  assert.throws(() => source.parse(request(withoutIssue)), BadPayloadError);
  const badKey = fixture("webhook-comment-created");
  badKey.issue.key = "proj-1; DROP";
  assert.throws(() => source.parse(request(badKey)), BadPayloadError);
  const withoutComment = fixture("webhook-comment-created");
  delete withoutComment.comment;
  assert.throws(() => source.parse(request(withoutComment)), BadPayloadError);
  const withoutTime = fixture("webhook-comment-created");
  delete withoutTime.comment.created;
  assert.throws(() => source.parse(request(withoutTime)), BadPayloadError);
  const withoutTimestamp = fixture("webhook-issue-updated");
  delete withoutTimestamp.timestamp;
  assert.throws(() => source.parse(request(withoutTimestamp)), BadPayloadError);
});

test("ignoreFields leaves listed fields out of an issue_updated summary", () => {
  const hiding = new JiraSource("jira", { ...config, ignoreFields: ["resolution"] }, secret);
  assert.equal(hiding.parse(request(fixture("webhook-issue-updated")))[0]!.summary, "status: To Do -> In Progress");
});

test("an issue_updated whose items are all in ignoreFields produces no event", () => {
  const hiding = new JiraSource("jira", { ...config, ignoreFields: ["status", "resolution"] }, secret);
  assert.deepEqual(hiding.parse(request(fixture("webhook-issue-updated"))), []);
});

test("an issue_updated with no listed field is unchanged by ignoreFields", () => {
  const hiding = new JiraSource("jira", { ...config, ignoreFields: ["Rank"] }, secret);
  assert.equal(hiding.parse(request(fixture("webhook-issue-updated")))[0]!.summary.split("\n").length, 2);
});
