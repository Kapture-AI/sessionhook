import { describeFetchError } from "./fetchError.js";

export type AccountCheck =
  | { ok: true; displayName: string }
  | { ok: false; kind: "rejected" | "unreachable" | "unexpected"; message: string };

const timeoutMs = 10_000;

// Asks Jira who the credentials belong to. The token goes into the request and nowhere else.
export async function checkJiraAccount(
  site: string,
  email: string,
  token: string,
  fetchJira: typeof fetch = fetch,
): Promise<AccountCheck> {
  let response: Response;
  try {
    response = await fetchJira(`${site}/rest/api/3/myself`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, kind: "unreachable", message: `Jira could not be reached at ${site} (${describeFetchError(error)})` };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: "rejected",
      message: `Jira answered ${response.status}, so the email or the API token is wrong`,
    };
  }
  if (!response.ok) {
    return { ok: false, kind: "unexpected", message: `Jira answered ${response.status} to the account check` };
  }
  try {
    const body = (await response.json()) as { displayName?: unknown };
    if (typeof body.displayName === "string" && body.displayName !== "") return { ok: true, displayName: body.displayName };
  } catch {
    // Handled below, the same as a JSON body without a name.
  }
  return { ok: false, kind: "unexpected", message: `${site} answered 200 but not like Jira, check the site address` };
}
