import { parseArgs } from "node:util";
import { parseTopic } from "../event.js";
import { resolveSubscriberName } from "../subscriber.js";
import { brokerClient } from "./shared.js";

function parseTopicArgs(args: string[]): { topic: string; name: string } {
  const { values, positionals } = parseArgs({
    args,
    options: { name: { type: "string" } },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("expected exactly one topic, such as jira:PROJ-123");
  const topic = positionals[0]!;
  parseTopic(topic);
  return { topic, name: resolveSubscriberName(values.name, process.env) };
}

export async function subscribe(args: string[]): Promise<void> {
  const { topic, name } = parseTopicArgs(args);
  await brokerClient().subscribe(name, topic);
  process.stdout.write(`${name} is subscribed to ${topic}, events that arrive from now on are delivered\n`);
}

export async function unsubscribe(args: string[]): Promise<void> {
  const { topic, name } = parseTopicArgs(args);
  const removed = await brokerClient().unsubscribe(name, topic);
  process.stdout.write(removed ? `${name} is no longer subscribed to ${topic}\n` : `${name} was not subscribed to ${topic}\n`);
}
