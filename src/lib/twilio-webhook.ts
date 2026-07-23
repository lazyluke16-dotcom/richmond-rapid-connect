import { createHmac, timingSafeEqual } from "node:crypto";

export function validateTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
  suppliedSignature: string,
): boolean {
  if (!authToken || !suppliedSignature) return false;

  const payload =
    url +
    [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}${value}`)
      .join("");
  const expected = createHmac("sha1", authToken).update(payload).digest("base64");
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(suppliedSignature);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
