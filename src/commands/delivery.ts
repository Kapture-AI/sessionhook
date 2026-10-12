import { parseArgs } from "node:util";
import type { BrokerClient } from "../client.js";
import type { EventRecord } from "../event.js";
import { resolveSubscriberName } from "../subscriber.js";
import { brokerClient } from "./shared.js";

const pollSeconds = 25;

// The text a session reads, so each event is a short block with the summary last.
export function formatEvent(event: EventRecord): string {
  const byline = [event.actor.name && `by ${event.actor.name}`, event.at].filter(Boolean).join(" at ");
  return [`#${event.seq} ${event.topic} ${event.type}`, byline, event.url, event.summary]
    .filter((line) => line !== "")
    .join("\n");
}

function parseDeliveryArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { name: { type: "string" }, json: { type: "boolean" } },
  });
  return {
    client: brokerClient(),
    name: resolveSubscriberName(values.name, process.env),
    json: values.json === true,
  };
}

function write(text: string): Promise<void> {
  return new Promise((resolve) => process.stdout.write(text, () => resolve()));
}

// Delivery is at-least-once, so the cursor moves only after the text is written.
async function printThenAck(
  client: BrokerClient,
  name: string,
  events: EventRecord[],
  json: boolean,
): Promise<void> {
  const text = json
    ? events.map((event) => `${JSON.stringify(event)}\n`).join("")
    : `${events.map(formatEvent).join("\n\n")}\n`;
  await write(text);
  await client.ack(name, events[events.length - 1]!.seq);
}

export async function wait(args: string[]): Promise<void> {
  const { client, name, json } = parseDeliveryArgs(args);
  let events: EventRecord[] = [];
  while (events.length === 0) events = await client.events(name, pollSeconds);
  while (events.length > 0) {
    await printThenAck(client, name, events, json);
    events = await client.events(name, 0);
  }
}

export async function tail(args: string[]): Promise<void> {
  const { client, name, json } = parseDeliveryArgs(args);
  for (;;) {
    const events = await client.events(name, pollSeconds);
    if (events.length > 0) await printThenAck(client, name, events, json);
  }
}
