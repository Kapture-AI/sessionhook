import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { channelMessage, ChannelDelivery, type ChannelMessage, type RetryDelays } from "./channelDelivery.js";
import { BrokerNotRunningError, BrokerRequestError, type BrokerClient } from "./client.js";
import type { EventRecord } from "./event.js";

function event(seq: number, overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    seq,
    id: `deploys:${seq}`,
    topic: "deploys:acme/web",
    type: "deployed",
    actor: { id: "7", name: "Ada Lovelace" },
    at: "2026-10-12T10:00:00.000Z",
    url: "https://example.com/deploys/1",
    summary: "Release 1.2 is live",
    ...overrides,
  };
}

type Script = Array<EventRecord[] | Error>;

// Replays the script one reply per events() call, then waits for the abort like a long-poll would.
function fakeClient(script: Script) {
  const acked: number[] = [];
  let polls = 0;
  const client = {
    async events(_name: string, _wait: number, signal: AbortSignal) {
      polls++;
      const next = script.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new DOMException("aborted", "AbortError");
    },
    async ack(_name: string, seq: number) {
      acked.push(seq);
    },
  } as unknown as BrokerClient;
  return { client, acked, polls: () => polls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) await flush();
  assert.ok(condition(), "timed out waiting");
}

const delays: RetryDelays = { notSubscribedMs: 5000, failureInitialMs: 1000, failureMaxMs: 4000 };

function delivery(client: BrokerClient, send: (message: ChannelMessage) => Promise<void>, log: string[] = []) {
  return new ChannelDelivery({ client, name: "s", send, log: (line) => log.push(line), delays });
}

test("the meta carries the event fields as strings and leaves out empty ones", () => {
  const message = channelMessage(event(12));
  assert.deepEqual(message.meta, {
    topic: "deploys:acme/web",
    event_type: "deployed",
    seq: "12",
    actor: "Ada Lovelace",
    at: "2026-10-12T10:00:00.000Z",
    url: "https://example.com/deploys/1",
  });
  assert.match(message.content, /^#12 deploys:acme\/web deployed\nby Ada Lovelace at /);

  const bare = channelMessage(event(13, { actor: { id: "", name: "" }, url: "" }));
  assert.deepEqual(Object.keys(bare.meta), ["topic", "event_type", "seq", "at"]);
  assert.equal(channelMessage(event(14, { actor: { id: "7", name: "" } })).meta.actor, "7");
});

test("each event is sent before its sequence number is acknowledged", async () => {
  const { client, acked } = fakeClient([[event(1), event(2)]]);
  const sent: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const stop = new AbortController();
  const running = delivery(client, async (message) => {
    sent.push(Number(message.meta.seq));
    await gate;
  }).run(stop.signal);

  await until(() => sent.length === 1);
  assert.deepEqual(acked, [], "no ack while the notification is still being written");
  release();
  await until(() => acked.length === 2);
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(acked, [1, 2]);
  stop.abort();
  await running;
});

test("a send that fails leaves the event unacknowledged and it is sent again", async () => {
  const { client, acked } = fakeClient([[event(1)], [event(1)]]);
  const log: string[] = [];
  let attempts = 0;
  const stop = new AbortController();
  const running = new ChannelDelivery({
    client,
    name: "s",
    log: (line) => log.push(line),
    delays: { notSubscribedMs: 1, failureInitialMs: 1, failureMaxMs: 1 },
    send: async () => {
      if (++attempts === 1) throw new Error("pipe closed");
    },
  }).run(stop.signal);

  await until(() => acked.length === 1);
  assert.equal(attempts, 2);
  assert.match(log.join("\n"), /delivery failed, will retry: pipe closed/);
  stop.abort();
  await running;
});

test("an unknown subscriber is asked again after the delay, or at once on retryNow", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client, polls } = fakeClient([
      new BrokerRequestError(404, "unknown subscriber"),
      new BrokerRequestError(404, "unknown subscriber"),
      new BrokerRequestError(404, "unknown subscriber"),
    ]);
    const log: string[] = [];
    const stop = new AbortController();
    const subject = delivery(client, async () => {}, log);
    const running = subject.run(stop.signal);

    await flush();
    assert.equal(polls(), 1);
    mock.timers.tick(4999);
    await flush();
    assert.equal(polls(), 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(polls(), 2);

    subject.retryNow();
    await flush();
    assert.equal(polls(), 3);
    assert.deepEqual(log, [], "not being subscribed yet is the normal state and is not logged");
    stop.abort();
    await running;
  } finally {
    mock.timers.reset();
  }
});

test("while the broker is down the delay doubles up to the maximum and only two lines are logged", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const down = () => new BrokerNotRunningError();
    const { client, acked, polls } = fakeClient([down(), down(), down(), down(), down(), [event(9)]]);
    const log: string[] = [];
    const stop = new AbortController();
    const running = delivery(client, async () => {}, log).run(stop.signal);

    await flush();
    assert.equal(polls(), 1);
    // The last step delivers the event and polls again at once, which is poll 7.
    for (const [wait, expectedPolls] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
      [4000, 5],
      [4000, 7],
    ] as const) {
      mock.timers.tick(wait - 1);
      await flush();
      assert.equal(polls(), Math.min(expectedPolls, 6) - 1, `no attempt before ${wait} ms`);
      mock.timers.tick(1);
      await flush();
      assert.equal(polls(), expectedPolls);
    }
    assert.deepEqual(acked, [9]);
    assert.equal(log.length, 2);
    assert.match(log[0]!, /the broker is not running/);
    assert.match(log[1]!, /the broker is back/);
    stop.abort();
    await running;
  } finally {
    mock.timers.reset();
  }
});

test("a failure other than the broker being down is logged and retried", async () => {
  const { client, polls } = fakeClient([new BrokerRequestError(500, "internal error")]);
  const log: string[] = [];
  const stop = new AbortController();
  const running = new ChannelDelivery({
    client,
    name: "s",
    send: async () => {},
    log: (line) => log.push(line),
    delays: { notSubscribedMs: 1, failureInitialMs: 1, failureMaxMs: 1 },
  }).run(stop.signal);
  await until(() => polls() === 2);
  assert.deepEqual(log, ["delivery failed, will retry: internal error"]);
  stop.abort();
  await running;
});

test("aborting ends the loop while it waits for the broker", async () => {
  const { client } = fakeClient([new BrokerNotRunningError()]);
  const stop = new AbortController();
  const running = new ChannelDelivery({
    client,
    name: "s",
    send: async () => {},
    log: () => {},
    delays: { notSubscribedMs: 60000, failureInitialMs: 60000, failureMaxMs: 60000 },
  }).run(stop.signal);
  await flush();
  stop.abort();
  await running;
});
