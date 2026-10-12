const namePattern = /^[A-Za-z0-9._:@-]{1,128}$/;

export function checkSubscriberName(name: string): string {
  if (!namePattern.test(name)) {
    throw new Error(
      `invalid subscriber name "${name}", use 1 to 128 letters, digits and the characters . _ : @ -`,
    );
  }
  return name;
}

export function resolveSubscriberName(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  const name = flag || env.SESSIONHOOK_SUBSCRIBER || env.CLAUDE_CODE_SESSION_ID;
  if (!name) {
    throw new Error(
      "no subscriber name, pass --name <name> or set SESSIONHOOK_SUBSCRIBER (inside Claude Code, CLAUDE_CODE_SESSION_ID is used when it is set)",
    );
  }
  return checkSubscriberName(name);
}
