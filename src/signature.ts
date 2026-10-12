import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const sha256Hex = /^[0-9a-f]{64}$/i;

// The header holds the hex HMAC-SHA256 of the raw body after the prefix. A header the
// sender repeated arrives as an array and is refused, because only one value can be the signature.
export function hasValidSignature(
  header: IncomingHttpHeaders[string],
  prefix: string,
  secret: string,
  rawBody: Buffer,
): boolean {
  if (typeof header !== "string" || !header.startsWith(prefix)) return false;
  const received = header.slice(prefix.length);
  if (!sha256Hex.test(received)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
