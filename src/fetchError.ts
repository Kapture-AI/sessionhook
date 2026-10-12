// The code or message of what went wrong underneath, since fetch itself only says "fetch failed".
export function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (error as Error).message;
}
