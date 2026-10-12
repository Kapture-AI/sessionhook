import { parseArgs } from "node:util";
import { ClaudeCli } from "../claudeCli.js";
import { runCommand } from "../exec.js";
import { runInit } from "../init.js";
import { resolvePaths } from "../paths.js";
import { TerminalPrompter } from "../prompter.js";
import { serviceInstaller, serviceSpec } from "./shared.js";

function onOrOff(values: Record<string, unknown>, name: string): boolean | undefined {
  if (values[name] && values[`no-${name}`]) throw new Error(`--${name} and --no-${name} cannot be used together`);
  if (values[name]) return true;
  if (values[`no-${name}`]) return false;
  return undefined;
}

export async function init(args: string[]): Promise<void> {
  // A token given as an option would show in ps and in shell history.
  if (args.some((arg) => arg === "--token" || arg.startsWith("--token="))) {
    throw new Error("the token is not accepted as an option, pass --token-file <path> or type it when asked");
  }
  const { values } = parseArgs({
    args,
    options: {
      site: { type: "string" },
      email: { type: "string" },
      mode: { type: "string" },
      "token-file": { type: "string" },
      "public-url": { type: "string" },
      "allow-actor": { type: "string", multiple: true },
      "ignore-marker": { type: "string" },
      service: { type: "boolean" },
      "no-service": { type: "boolean" },
      register: { type: "boolean" },
      "no-register": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const yes = values.yes === true;
  const prompter = yes ? undefined : new TerminalPrompter(process.stdin, process.stdout, Boolean(process.stdin.isTTY));
  try {
    const problems = await runInit(
      {
        site: values.site,
        email: values.email,
        mode: values.mode,
        tokenFile: values["token-file"],
        publicUrl: values["public-url"],
        allowActors: values["allow-actor"] ?? [],
        ignoreMarker: values["ignore-marker"],
        service: onOrOff(values, "service"),
        register: onOrOff(values, "register"),
        yes,
      },
      {
        paths: resolvePaths(process.env),
        env: process.env,
        prompter,
        fetch,
        claude: new ClaudeCli(runCommand),
        services: serviceInstaller(),
        serviceSpec: serviceSpec(),
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
      },
    );
    if (problems.length > 0) process.exitCode = 1;
  } finally {
    prompter?.close();
  }
}
