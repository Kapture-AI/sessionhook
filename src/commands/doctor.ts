import { parseArgs } from "node:util";
import { ClaudeCli, channelServerArguments } from "../claudeCli.js";
import { channelsNote, formatReport, runDoctor } from "../doctor.js";
import { runCommand } from "../exec.js";
import { resolvePaths } from "../paths.js";
import { quoteCommand } from "../shellQuote.js";
import { brokerClient, installedCliPath } from "./shared.js";

export async function doctor(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const results = await runDoctor({
    paths: resolvePaths(process.env),
    env: process.env,
    client: brokerClient(),
    fetch,
    claude: new ClaudeCli(runCommand),
    registerCommand: quoteCommand(["claude", ...channelServerArguments(process.execPath, installedCliPath())]),
  });
  process.stdout.write(`${formatReport(results).join("\n")}\n\n${channelsNote}\n`);
  const failed = results.filter((result) => result.status === "FAIL");
  if (failed.length > 0) {
    throw new Error(`${failed.length} ${failed.length === 1 ? "check" : "checks"} failed: ${failed.map((result) => result.name).join(", ")}`);
  }
}
