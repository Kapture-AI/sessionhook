import { parseArgs } from "node:util";
import { resolveSubscriberName } from "../subscriber.js";
import { brokerClient } from "./shared.js";

export async function replay(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { name: { type: "string" }, from: { type: "string" } },
  });
  const from = Number(values.from);
  if (!values.from || !Number.isInteger(from) || from < 1) {
    throw new Error("replay needs --from <seq>, the sequence number of the first event to send again");
  }
  const name = resolveSubscriberName(values.name, process.env);
  const unread = await brokerClient().rewind(name, from);
  process.stdout.write(`${unread} ${unread === 1 ? "event is" : "events are"} now unread for ${name}\n`);
}
