import { readFileSync } from "node:fs";

export function readVersion(): string {
  const packageJson = new URL("../package.json", import.meta.url);
  return JSON.parse(readFileSync(packageJson, "utf8")).version;
}
