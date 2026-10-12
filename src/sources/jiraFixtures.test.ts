// Shared by the Jira tests. The fixtures are modelled on recorded Jira Cloud responses
// with every name, id, address and text replaced, and live outside the published package.
import { readFileSync } from "node:fs";

export const site = "https://example.atlassian.net";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../test-fixtures/jira/${name}.json`, import.meta.url), "utf8")) as T;
}
