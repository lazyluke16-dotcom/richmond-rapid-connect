import { createHmac, timingSafeEqual } from "node:crypto";

// Exact parity with Twilio's official signing algorithm (twilio-node
// getExpectedTwilioSignature / toFormUrlEncodedParam):
//   data = url, then for each parameter name in NATIVE case-sensitive order,
//   append name + value; for a name with multiple values, dedupe (Set) and sort
//   the values, then append name + value for each. HMAC-SHA1 over the UTF-8
//   bytes, base64. Using localeCompare here (case-folding) reorders identifiers
//   like CallSid vs Called and produces a different payload, which fails
//   Twilio's real X-Twilio-Signature even when the Auth Token is correct.
function expectedTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
): string {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of params.entries()) {
    const existing = grouped.get(key);
    if (existing) existing.push(value);
    else grouped.set(key, [value]);
  }

  let data = url;
  for (const key of [...grouped.keys()].sort()) {
    for (const value of [...new Set(grouped.get(key))].sort()) {
      data += `${key}${value}`;
    }
  }

  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
  suppliedSignature: string,
): boolean {
  if (!authToken || !suppliedSignature) return false;

  const expected = expectedTwilioSignature(authToken, url, params);
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(suppliedSignature);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
