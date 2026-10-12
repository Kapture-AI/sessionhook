import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// An absolute path, so a program started later by tmux does not depend on the PATH tmux was started with.
export function findOnPath(program: string, pathVariable: string | undefined): string | undefined {
  for (const directory of (pathVariable ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, program);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here or not runnable, so the next directory is tried.
    }
  }
  return undefined;
}
