import { parseArgs } from "node:util";

// The MCP SDK is loaded here and not at the top of the CLI so that the other
// commands never pay for it.
export async function channel(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const { runChannelServer } = await import("../channelServer.js");
  await runChannelServer();
}
