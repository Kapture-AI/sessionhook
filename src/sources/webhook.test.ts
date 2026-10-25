import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import type { WebhookSourceConfig } from "../config.js";
import { BadPayloadError } from "../source.js";
import { WebhookSource } from "./webhook.js";

const secret = "fake-test-secret";

const config: WebhookSourceConfig = {
  type: "webhook",
  signature: { header: "x-hub-signature-256", prefix: "sha256=", secret: "DEPLOYS_WEBHOOK_SECRET" },
  map: {
    key: "repository.full_name",
    id: "delivery.id",
    type: "action",
    actorId: "sender.id",
    actorName: "sender.login",
    at: "created_at",
    url: "html_url",
    summary: "message",
  },
  allowActors: [],
  ignoreActors: [],
  ignoreMarker: "",
};

const source = new WebhookSource("deploys", config, secret);

function sign(body: Buffer, key = secret): string {
  return `sha256=${createHmac("sha256", key).update(body).digest("hex")}`;
}

function request(payload: unknown, signature?: string) {
  const rawBody = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const headers = signature === undefined ? {} : { "x-hub-signature-256": signature };
  return { headers, rawBody };
}

const payload = {
  repository: { full_name: "org/web" },
  delivery: { id: 42 },
  action: "deployed",
  sender: { id: 7, login: "ada" },
  created_at: "2026-10-12T10:00:00+02:00",
  html_url: "https://example.com/d/42",
  message: "Shipped",
};

test("a correct signature authenticates", () => {
  const raw = request(payload);
  assert.equal(source.authenticate({ ...raw, headers: { "x-hub-signature-256": sign(raw.rawBody) } }), true);
});

test("a signature made with another secret is rejected", () => {
  const raw = request(payload);
  const headers = { "x-hub-signature-256": sign(raw.rawBody, "another-secret") };
  assert.equal(source.authenticate({ ...raw, headers }), false);
});

test("a signature over a different body is rejected", () => {
  const raw = request(payload);
  const headers = { "x-hub-signature-256": sign(Buffer.from("{}")) };
  assert.equal(source.authenticate({ ...raw, headers }), false);
});

test("a missing signature header is rejected", () => {
  assert.equal(source.authenticate(request(payload)), false);
});

test("a header without the prefix, with bad hex or with the wrong length is rejected", () => {
  const raw = request(payload);
  const digest = createHmac("sha256", secret).update(raw.rawBody).digest("hex");
  for (const value of [digest, "sha256=", "sha256=zz", `sha256=${digest}00`, `sha256=${digest.slice(2)}`, `sha256=${digest}zz`]) {
    assert.equal(source.authenticate({ ...raw, headers: { "x-hub-signature-256": value } }), false, value);
  }
});

test("a header repeated by the sender is rejected", () => {
  const raw = request(payload);
  const headers = { "x-hub-signature-256": [sign(raw.rawBody)] } as unknown as Record<string, string>;
  assert.equal(source.authenticate({ ...raw, headers }), false);
});

test("an uppercase hex digest is accepted", () => {
  const raw = request(payload);
  const digest = createHmac("sha256", secret).update(raw.rawBody).digest("hex").toUpperCase();
  assert.equal(source.authenticate({ ...raw, headers: { "x-hub-signature-256": `sha256=${digest}` } }), true);
});

test("a source without a prefix compares the whole header", () => {
  const bare = new WebhookSource("deploys", { ...config, signature: { ...config.signature, prefix: "" } }, secret);
  const raw = request(payload);
  const digest = createHmac("sha256", secret).update(raw.rawBody).digest("hex");
  assert.equal(bare.authenticate({ ...raw, headers: { "x-hub-signature-256": digest } }), true);
});

test("every mapped field is read by its dotted path", () => {
  const [event] = source.parse(request(payload));
  assert.deepEqual(event, {
    id: "deploys:42",
    topic: "deploys:org/web",
    type: "deployed",
    actor: { id: "7", name: "ada" },
    at: "2026-10-12T08:00:00.000Z",
    url: "https://example.com/d/42",
    summary: "Shipped",
  });
});

test("only the key is required and the other fields take their defaults", () => {
  const minimal = new WebhookSource("deploys", { ...config, map: { key: "repo" } }, secret);
  const before = Date.now();
  const events = minimal.parse(request({ repo: "org/web" }));
  const after = Date.now();
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.topic, "deploys:org/web");
  assert.equal(event.type, "event");
  assert.deepEqual(event.actor, { id: "", name: "" });
  assert.equal(event.url, "");
  assert.equal(event.summary, "");
  assert.match(event.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(event.at) >= before && Date.parse(event.at) <= after);
});

test("mapped paths that are missing in the body take the defaults too", () => {
  const [event] = source.parse(request({ repository: { full_name: "org/web" }, sender: "not an object" }));
  assert.equal(event!.type, "event");
  assert.deepEqual(event!.actor, { id: "", name: "" });
});

test("an unparseable time falls back to the receive time", () => {
  const [event] = source.parse(request({ ...payload, created_at: "yesterday-ish" }));
  assert.ok(Math.abs(Date.now() - Date.parse(event!.at)) < 5000);
});

test("without a mapped id the id is the hash of the raw body, so a repeat gets the same id", () => {
  const minimal = new WebhookSource("deploys", { ...config, map: { key: "repo" } }, secret);
  const raw = request({ repo: "org/web" });
  const expected = `deploys:${createHash("sha256").update(raw.rawBody).digest("hex")}`;
  assert.equal(minimal.parse(raw)[0]!.id, expected);
  assert.equal(minimal.parse(request({ repo: "org/web" }))[0]!.id, expected);
});

test("a mapped id that is absent from the body falls back to the body hash", () => {
  const raw = request({ repository: { full_name: "org/web" } });
  const expected = `deploys:${createHash("sha256").update(raw.rawBody).digest("hex")}`;
  assert.equal(source.parse(raw)[0]!.id, expected);
});

test("the summary is cut to 2000 characters", () => {
  const [event] = source.parse(request({ ...payload, message: "x".repeat(2500) }));
  assert.equal(event!.summary.length, 2000);
});

test("a body that is not JSON is a bad payload", () => {
  assert.throws(() => source.parse(request("not json")), BadPayloadError);
});

test("a body without a value at the key path is a bad payload", () => {
  assert.throws(() => source.parse(request({ repository: {} })), BadPayloadError);
  assert.throws(() => source.parse(request({ repository: { full_name: { nested: 1 } } })), BadPayloadError);
  assert.throws(() => source.parse(request({ repository: { full_name: "" } })), BadPayloadError);
});

test("a key that cannot form a topic is a bad payload", () => {
  assert.throws(() => source.parse(request({ repository: { full_name: "a\nb" } })), BadPayloadError);
});

const jiraPayload = (items: unknown) => ({
  webhookEvent: "jira:issue_updated",
  timestamp: 1761390994240,
  issue: { key: "KAN-1", fields: { project: { key: "KAN" } } },
  ...(items === undefined ? {} : { changelog: { id: "1", items } }),
});
const watcher = new WebhookSource(
  "watcher",
  { ...config, map: { key: "issue.fields.project.key", type: "webhookEvent" }, ignoreFields: ["Attachment"] },
  secret,
);

test("ignoreFields drops an update whose changelog items are all listed fields", () => {
  assert.deepEqual(watcher.parse(request(jiraPayload([{ field: "Attachment" }, { field: "Attachment" }]))), []);
});

test("ignoreFields keeps an update that changes a listed field alongside another", () => {
  const events = watcher.parse(request(jiraPayload([{ field: "Attachment" }, { field: "status" }])));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.topic, "watcher:KAN");
});

test("ignoreFields keeps a body with no changelog, an empty one or items without a field", () => {
  for (const items of [undefined, [], [{}], [{ field: 3 }], "Attachment"]) {
    assert.equal(watcher.parse(request(jiraPayload(items))).length, 1, JSON.stringify(items));
  }
});

test("ignoreFields keeps a comment event", () => {
  const comment = { webhookEvent: "comment_created", issue: { key: "KAN-1", fields: { project: { key: "KAN" } } }, comment: { body: "Attachment" } };
  assert.equal(watcher.parse(request(comment)).length, 1);
});

test("without ignoreFields an attachment-only update is still an event", () => {
  const plain = new WebhookSource("watcher", { ...config, map: { key: "issue.fields.project.key" } }, secret);
  assert.equal(plain.parse(request(jiraPayload([{ field: "Attachment" }]))).length, 1);
});
