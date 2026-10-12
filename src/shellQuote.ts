const safe = /^[A-Za-z0-9_\/.:=@%+,-]+$/;

// Single quotes keep every character literal in a POSIX shell, except the single quote itself.
export function quoteArgument(argument: string): string {
  if (safe.test(argument)) return argument;
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function quoteCommand(parts: string[]): string {
  return parts.map(quoteArgument).join(" ");
}
