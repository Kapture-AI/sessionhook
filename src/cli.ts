#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { commands } from "./commands/index.js";

function readVersion(): string {
  const packageJson = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(packageJson, "utf8")).version;
}

function usage(): string {
  const names = Object.keys(commands);
  const width = Math.max(...names.map((name) => name.length));
  const lines = names.map((name) => {
    const { summary, run } = commands[name]!;
    const note = run ? "" : " (not yet implemented)";
    return `  ${name.padEnd(width)}  ${summary}${note}`;
  });
  return [
    "Usage: sessionhook <command> [options]",
    "",
    "Commands:",
    ...lines,
    "",
    "Options:",
    "  -h, --help     Show this help",
    "  -v, --version  Show the version",
    "",
  ].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    process.stdout.write(usage());
    return;
  }

  if (first.startsWith("-")) {
    const { values } = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
    process.stdout.write(values.version ? `${readVersion()}\n` : usage());
    return;
  }

  const command = Object.hasOwn(commands, first) ? commands[first] : undefined;
  if (!command) {
    throw new Error(`unknown command "${first}", run "sessionhook --help" for the list`);
  }
  if (!command.run) {
    throw new Error(`"${first}" is not implemented yet`);
  }
  await command.run(rest);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sessionhook: ${message}\n`);
  process.exitCode = 1;
});
