import { readFileSync, statSync } from "node:fs";

function readSecretsFile(file: string): Record<string, string> {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (mode & 0o077) {
    const shown = (mode & 0o777).toString(8);
    throw new Error(
      `refusing to read ${file}: its mode is ${shown} and other users can read it, run chmod 600 on it`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} must be a JSON object of secret names to values`);
  }
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`${file}: "${name}" must be a string`);
  }
  return parsed as Record<string, string>;
}

// The secrets file wins over the environment so that a value kept in the file
// is not silently replaced by a stale variable in the shell that started the broker.
export function lookupSecret(
  name: string,
  secretsFile: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromFile = readSecretsFile(secretsFile);
  const value = Object.hasOwn(fromFile, name) ? fromFile[name] : undefined;
  return value || env[name] || undefined;
}
