import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { BrokerClient } from "../client.js";
import { runCommand } from "../exec.js";
import { resolvePaths } from "../paths.js";
import { ServiceInstaller, serviceEnvironment, type ServiceSpec } from "../service.js";

export function brokerClient(): BrokerClient {
  return new BrokerClient(resolvePaths(process.env).socketFile);
}

// Absolute and with symlinks resolved, so a path that is written into another program's
// settings still works when PATH or the npm bin directory is different.
export function installedCliPath(): string {
  return realpathSync(fileURLToPath(new URL("../cli.js", import.meta.url)));
}

export function serviceInstaller(): ServiceInstaller {
  return new ServiceInstaller({
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    run: runCommand,
  });
}

export function serviceSpec(): ServiceSpec {
  return {
    nodePath: process.execPath,
    cliPath: installedCliPath(),
    environment: serviceEnvironment(process.env),
  };
}
