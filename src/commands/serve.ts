import { parseArgs } from "node:util";
import { resolvePaths } from "../paths.js";

// The broker is loaded here and not at the top of the CLI so that the other
// commands, which talk to it over the socket, never load node:sqlite and its
// experimental warning.
export async function serve(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const { startBrokerFromFiles } = await import("../broker.js");
  const paths = resolvePaths(process.env);
  const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

  const broker = await startBrokerFromFiles(paths, process.env, log);
  await new Promise<void>((resolve) => {
    const shutDown = () => {
      log("shutting down");
      broker.stop().then(resolve, (error: unknown) => {
        log(`shutdown failed: ${(error as Error).message}`);
        process.exitCode = 1;
        resolve();
      });
    };
    process.once("SIGINT", shutDown);
    process.once("SIGTERM", shutDown);
  });
}
