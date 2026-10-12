import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { runCommand } from "../exec.js";
import { findOnPath } from "../findOnPath.js";
import { resolvePaths } from "../paths.js";
import { Spawner } from "../spawn.js";
import { brokerClient } from "./shared.js";

export async function spawn(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      "no-confirm": { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (positionals.length !== 1) throw new Error("expected exactly one topic, such as jira:PROJ-123");
  const spawner = new Spawner({
    config: loadConfig(resolvePaths(process.env).configFile).spawn,
    env: process.env,
    client: brokerClient(),
    run: runCommand,
    locate: (program) => findOnPath(program, process.env.PATH),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    out: (line) => process.stdout.write(`${line}\n`),
  });
  await spawner.start({
    topic: positionals[0]!,
    cwd: values.cwd ?? process.cwd(),
    name: values.name,
    prompt: values.prompt,
    confirmDialog: values["no-confirm"] !== true,
  });
}
