import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adfToText,
  changelogMayHideWindow,
  commentsAreCut,
  commentCreatedEvent,
  commentUpdatedEvent,
  eventsInWindow,
  historyEvent,
  type JiraIssue,
} from "./jiraEvents.js";
import { fixture, site } from "./jiraFixtures.test.js";

const origin = { source: "jira", site, key: "PROJ-123" };
const windowStart = Date.parse("2026-10-12T09:30:00Z");
const issue = fixture("poll-search").issues[0] as JiraIssue;
const [oldComment, editedComment, newComment] = issue.fields.comment!.comments;

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (...content: object[]) => ({ type: "paragraph", content });

test("adf paragraphs and headings end a line and the result is trimmed", () => {
  const doc = { type: "doc", content: [{ type: "heading", content: [text("Title")] }, paragraph(text("one "), text("two"))] };
  assert.equal(adfToText(doc), "Title\none two");
});

test("adf list items start on their own line with a dash, nested lists included", () => {
  const item = (...content: object[]) => ({ type: "listItem", content });
  const list = (...items: object[]) => ({ type: "bulletList", content: items });
  const doc = {
    type: "doc",
    content: [paragraph(text("Steps")), list(item(paragraph(text("a")), list(item(paragraph(text("a1"))))), item(paragraph(text("b"))))],
  };
  assert.equal(adfToText(doc), "Steps\n- a\n- a1\n- b");
});

test("adf hard breaks, mentions, emoji, cards and code blocks become text", () => {
  const doc = {
    type: "doc",
    content: [
      paragraph(text("a"), { type: "hardBreak" }, text("b")),
      paragraph({ type: "mention", attrs: { id: "x", text: "@Ada Lovelace" } }, { type: "emoji", attrs: { shortName: ":tada:" } }),
      paragraph({ type: "emoji", attrs: { shortName: ":tada:", text: "🎉" } }, { type: "inlineCard", attrs: { url: "https://example.com/x" } }),
      { type: "codeBlock", content: [text("npm test")] },
      paragraph(text("after")),
    ],
  };
  assert.equal(adfToText(doc), "a\nb\n@Ada Lovelace:tada:\n🎉https://example.com/x\nnpm test\nafter");
});

test("adf nodes of unknown type contribute the text of their children", () => {
  const doc = { type: "doc", content: [{ type: "panel", content: [paragraph(text("inside"))] }, { type: "mediaSingle" }] };
  assert.equal(adfToText(doc), "inside");
});

test("a new comment becomes a comment_created event with a link to the comment", () => {
  assert.deepEqual(commentCreatedEvent(origin, newComment!), {
    id: "jira:comment:20001",
    topic: "jira:PROJ-123",
    type: "comment_created",
    actor: { id: "5b10a2844c20165700ede21g", name: "Ada Lovelace" },
    at: "2026-10-12T09:56:41.681Z",
    url: "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20001",
    summary: "Deploy check passed, safe to ignore.",
  });
});

test("an edited comment gets an id with the update time and the editor as actor", () => {
  assert.deepEqual(commentUpdatedEvent(origin, editedComment!), {
    id: "jira:comment:20002:updated:1791799090000",
    topic: "jira:PROJ-123",
    type: "comment_updated",
    actor: { id: "5b10a2844c20165700ede21g", name: "Ada Lovelace" },
    at: "2026-10-12T09:58:10.000Z",
    url: "https://example.atlassian.net/browse/PROJ-123?focusedCommentId=20002",
    summary: "Please look at @Ada Lovelace first.\n- rerun the build\n- check the logs",
  });
});

test("a long comment is cut to 2000 characters", () => {
  const event = commentCreatedEvent(origin, { ...newComment!, body: "x".repeat(2500) });
  assert.equal(event.summary.length, 2000);
});

test("a changelog entry lists each changed item and writes an empty side as none", () => {
  const event = historyEvent(origin, issue.changelog!.histories[0]!);
  assert.deepEqual(event, {
    id: "jira:changelog:30001",
    topic: "jira:PROJ-123",
    type: "issue_updated",
    actor: { id: "5b10a2844c20165700ede21g", name: "Ada Lovelace" },
    at: "2026-10-12T09:36:10.213Z",
    url: "https://example.atlassian.net/browse/PROJ-123",
    summary: "status: To Do -> In Progress\nresolution: none -> Done",
  });
});

test("only items at or after the window start become events, and an edit is not a creation", () => {
  const events = eventsInWindow(origin, issue.fields.comment!.comments, issue.changelog!.histories, windowStart);
  assert.deepEqual(events.map((event) => event.id).sort(), [
    "jira:changelog:30001",
    "jira:comment:20001",
    "jira:comment:20002:updated:1791799090000",
  ]);
});

test("the window start is inclusive", () => {
  const exactly = Date.parse(newComment!.created);
  assert.equal(eventsInWindow(origin, [newComment!], [], exactly).length, 1);
  assert.equal(eventsInWindow(origin, [newComment!], [], exactly + 1).length, 0);
});

test("a comment created and edited inside the window yields both events", () => {
  const comment = { ...newComment!, updated: "2026-10-12T14:10:00.000+0400" };
  const types = eventsInWindow(origin, [comment], [], windowStart).map((event) => event.type);
  assert.deepEqual(types, ["comment_created", "comment_updated"]);
});

test("a time that cannot be parsed is rejected", () => {
  assert.throws(() => commentCreatedEvent(origin, { ...newComment!, created: "yesterday" }), /not a time/);
});

test("cut comments are detected from the total, and complete ones are not", () => {
  assert.equal(commentsAreCut(issue), false);
  const cut = { ...issue, fields: { comment: { comments: [oldComment!], total: 21 } } };
  assert.equal(commentsAreCut(cut), true);
  assert.equal(commentsAreCut({ ...issue, fields: {} }), false);
});

test("a cut changelog needs the follow-up only when its oldest shown entry is inside the window", () => {
  const [newest, older] = issue.changelog!.histories;
  const cutInside = { ...issue, changelog: { histories: [newest!], total: 50 } };
  assert.equal(changelogMayHideWindow(cutInside, windowStart), true);
  const cutOutside = { ...issue, changelog: { histories: [newest!, older!], total: 50 } };
  assert.equal(changelogMayHideWindow(cutOutside, windowStart), false);
  assert.equal(changelogMayHideWindow(issue, windowStart), false);
  assert.equal(changelogMayHideWindow({ ...issue, changelog: undefined }, windowStart), false);
});
