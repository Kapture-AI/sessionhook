import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Paths = {
  configDir: string;
  stateDir: string;
  configFile: string;
  secretsFile: string;
  databaseFile: string;
  socketFile: string;
};

export function resolvePaths(env: NodeJS.ProcessEnv): Paths {
  const configDir = env.SESSIONHOOK_CONFIG_DIR || join(homedir(), ".config", "sessionhook");
  const stateDir = env.SESSIONHOOK_STATE_DIR || join(homedir(), ".local", "state", "sessionhook");
  return {
    configDir,
    stateDir,
    configFile: join(configDir, "config.json"),
    secretsFile: join(configDir, "secrets.json"),
    databaseFile: join(stateDir, "events.db"),
    socketFile: join(stateDir, "broker.sock"),
  };
}

// The socket is only protected by the mode of its directory, so a directory
// the broker creates is private. One that already exists is left as it is,
// because the user may have pointed the state directory at a shared location.
export function ensureStateDir(paths: Paths): void {
  mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
}
