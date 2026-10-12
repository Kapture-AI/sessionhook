import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function refuseOpenFile(file: string, mode: number): void {
  if (!(mode & 0o077)) return;
  const shown = (mode & 0o777).toString(8);
  throw new Error(
    `refusing to read ${file}: its mode is ${shown} and other users can read it, run chmod 600 on it`,
  );
}

export function readSecretsFile(file: string): Record<string, string> {
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  refuseOpenFile(file, mode);
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

// The Docker convention: NAME_FILE holds the path of a file whose content is the secret,
// so a machine that already keeps a token in a file can point at it without a copy.
function readSecretFromNamedFile(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const file = env[`${name}_FILE`];
  if (!file) return undefined;
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch (error) {
    throw new Error(`${name}_FILE points at ${file}, which cannot be read: ${(error as Error).message}`);
  }
  refuseOpenFile(file, mode);
  return readFileSync(file, "utf8").trim() || undefined;
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
  return value || env[name] || readSecretFromNamedFile(name, env);
}

// The file is created with mode 600 at open time, so there is no moment when it can be read by others,
// and it replaces the old one in a single rename so a failed write never truncates existing secrets.
export function writeSecretsFile(file: string, secrets: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
