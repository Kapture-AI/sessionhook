import { parseArgs } from "node:util";
import { TerminalPrompter } from "../prompter.js";
import { serviceInstaller, serviceSpec } from "./shared.js";

const usage = "usage: sessionhook service install|uninstall|status [--yes]";

export async function service(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { yes: { type: "boolean" } },
    allowPositionals: true,
  });
  const action = positionals[0];
  if (positionals.length !== 1 || !["install", "uninstall", "status"].includes(action!)) throw new Error(usage);

  const installer = serviceInstaller();
  const prompter = values.yes ? undefined : new TerminalPrompter(process.stdin, process.stdout, Boolean(process.stdin.isTTY));
  const confirm = async (question: string): Promise<boolean> => (prompter ? prompter.confirm(question, false) : true);
  try {
    let lines: string[];
    if (action === "install") {
      lines = await installer.install(serviceSpec(), async (file) => {
        process.stdout.write(`${file} already exists.\n`);
        return confirm("Replace it?");
      });
    } else if (action === "uninstall") {
      lines = installer.isInstalled() && !(await confirm(`Stop the service and remove ${installer.file}?`))
        ? [`left ${installer.file} as it is`]
        : await installer.uninstall();
    } else {
      lines = await installer.status();
    }
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    prompter?.close();
  }
}
