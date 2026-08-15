import { describe, expect, it, vi } from "vitest";
import { safeFetch, SafeFetchError } from "../safe-fetch";
import { UnsafeUrlError } from "../url-safety";

const html = (body: string) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const noDns = async () => [] as string[];

describe("safeFetch", () => {
  it("rejects an unsafe initial URL before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(
      safeFetch("http://169.254.169.254/latest", {
        fetchImpl: fetchImpl as never,
        dnsLookup: noDns,
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns HTML for an allowed content type", async () => {
    const fetchImpl = vi.fn(async () => html("<h1>ok</h1>"));
    const result = await safeFetch("https://example.com", {
      fetchImpl: fetchImpl as never,
      dnsLookup: noDns,
    });
    expect(new TextDecoder().decode(result.bytes)).toContain("ok");
    expect(result.status).toBe(200);
  });

  it("rejects a disallowed content type", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(
      safeFetch("https://example.com", { fetchImpl: fetchImpl as never, dnsLookup: noDns }),
    ).rejects.toMatchObject({
      code: "content_type_not_allowed",
    });
  });

  it("re-validates redirect targets and blocks a redirect to an internal address", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        });
      }
      return html("should not reach");
    });
    await expect(
      safeFetch("https://example.com/", { fetchImpl: fetchImpl as never, dnsLookup: noDns }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("enforces the redirect hop limit", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 301, headers: { location: "https://example.com/next" } }),
    );
    await expect(
      safeFetch("https://example.com/", {
        fetchImpl: fetchImpl as never,
        dnsLookup: noDns,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("truncates a body that exceeds the byte cap", async () => {
    const big = "x".repeat(10_000);
    const fetchImpl = vi.fn(async () => html(big));
    const result = await safeFetch("https://example.com", {
      fetchImpl: fetchImpl as never,
      dnsLookup: noDns,
      maxBytes: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(1000);
  });

  it("rejects when content-length declares an oversized body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("x", {
          status: 200,
          headers: { "content-type": "text/html", "content-length": "9999999" },
        }),
    );
    await expect(
      safeFetch("https://example.com", {
        fetchImpl: fetchImpl as never,
        dnsLookup: noDns,
        maxBytes: 1000,
      }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("blocks a host that resolves to a private address (DNS rebinding guard)", async () => {
    const fetchImpl = vi.fn(async () => html("<h1>ok</h1>"));
    const dnsLookup = async () => ["10.0.0.5"];
    await expect(
      safeFetch("https://rebind.example.com", { fetchImpl: fetchImpl as never, dnsLookup }),
    ).rejects.toMatchObject({
      code: "private_address",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("wraps upstream network failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      safeFetch("https://example.com", { fetchImpl: fetchImpl as never, dnsLookup: noDns }),
    ).rejects.toBeInstanceOf(SafeFetchError);
  });
});
