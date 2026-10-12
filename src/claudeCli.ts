import type { Runner } from "./exec.js";

// Channels arrived in this Claude Code release.
const minimumVersion = [2, 1, 80];

export const channelServerName = "sessionhook";

export function channelServerArguments(nodePath: string, cliPath: string): string[] {
  return ["mcp", "add", "--scope", "user", channelServerName, "--", nodePath, cliPath, "channel"];
}

export function supportsChannels(version: string): boolean {
  const parts = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!parts) return false;
  for (let index = 0; index < minimumVersion.length; index++) {
    if (parts[index]! !== minimumVersion[index]!) return parts[index]! > minimumVersion[index]!;
  }
  return true;
}

// Every method rejects with CommandNotFoundError when claude is not installed.
export class ClaudeCli {
  constructor(private readonly run: Runner) {}

  async version(): Promise<string> {
    const result = await this.run("claude", ["--version"]);
    if (result.code !== 0) throw new Error(`claude --version failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    return result.stdout.trim();
  }

  // The command exits non-zero when no server has that name.
  async hasServer(): Promise<boolean> {
    return (await this.run("claude", ["mcp", "get", channelServerName])).code === 0;
  }

  async addServer(nodePath: string, cliPath: string): Promise<void> {
    const result = await this.run("claude", channelServerArguments(nodePath, cliPath));
    if (result.code !== 0) {
      throw new Error(`claude mcp add failed: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`}`);
    }
  }
}
