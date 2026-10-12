import { parseArgs } from "node:util";
import type { SubscriberStatus } from "../store.js";
import { brokerClient } from "./shared.js";

function table(subscribers: SubscriberStatus[]): string {
  const rows = [
    ["SUBSCRIBER", "TOPICS", "UNREAD", "LAST SEEN"],
    ...subscribers.map((s) => [s.name, s.topics.join(", ") || "-", String(s.unread), s.lastSeen]),
  ];
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

export async function status(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" } } });
  const subscribers = await brokerClient().status();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(subscribers, null, 2)}\n`);
  } else if (subscribers.length === 0) {
    process.stdout.write("no subscribers yet, run `sessionhook subscribe <topic>` to add one\n");
  } else {
    process.stdout.write(`${table(subscribers)}\n`);
  }
}
