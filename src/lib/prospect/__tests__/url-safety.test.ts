import { describe, expect, it } from "vitest";
import {
  assertFetchableUrl,
  isFetchableUrl,
  isPublicIpAddress,
  isPublicIpv4,
  isPublicIpv6,
  UnsafeUrlError,
} from "../url-safety";

describe("SSRF url-safety", () => {
  it("accepts ordinary public https/http URLs", () => {
    expect(isFetchableUrl("https://exampleplumbing.com.au")).toBe(true);
    expect(isFetchableUrl("http://exampleplumbing.com.au/services")).toBe(true);
    expect(isFetchableUrl("https://sub.domain.com.au:443/path")).toBe(true);
  });

  it("rejects non-http(s) protocols", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://host/x",
      "gopher://h",
      "data:text/html,x",
      "javascript:alert(1)",
    ]) {
      expect(isFetchableUrl(url)).toBe(false);
    }
  });

  it("rejects embedded credentials", () => {
    expect(() => assertFetchableUrl("https://user:pass@example.com")).toThrow(UnsafeUrlError);
  });

  it("rejects non-80/443 ports", () => {
    expect(isFetchableUrl("http://example.com:8080")).toBe(false);
    expect(isFetchableUrl("http://example.com:22")).toBe(false);
  });

  it("rejects localhost and private-use hostnames", () => {
    for (const host of [
      "http://localhost",
      "http://localhost.localdomain",
      "http://foo.local",
      "http://service.internal",
      "http://box.lan",
      "http://metadata.google.internal",
    ]) {
      expect(isFetchableUrl(host)).toBe(false);
    }
  });

  it("rejects private, loopback, link-local and reserved IPv4 literals", () => {
    for (const ip of [
      "http://127.0.0.1",
      "http://10.0.0.5",
      "http://172.16.0.1",
      "http://192.168.1.1",
      "http://169.254.169.254", // cloud metadata
      "http://0.0.0.0",
      "http://100.64.0.1", // CGNAT
      "http://198.18.0.1",
      "http://255.255.255.255",
      "http://224.0.0.1",
    ]) {
      expect(isFetchableUrl(ip)).toBe(false);
    }
  });

  it("accepts a genuinely public IPv4 literal", () => {
    expect(isPublicIpv4("8.8.8.8")).toBe(true);
    expect(isPublicIpv4("203.0.113.5")).toBe(false); // TEST-NET-3 reserved
    expect(isFetchableUrl("http://8.8.8.8")).toBe(true);
  });

  it("rejects loopback/link-local/ULA IPv6 and accepts global unicast", () => {
    expect(isPublicIpv6("::1")).toBe(false);
    expect(isPublicIpv6("fe80::1")).toBe(false);
    expect(isPublicIpv6("fc00::1")).toBe(false);
    expect(isPublicIpv6("fd12::1")).toBe(false);
    expect(isPublicIpv6("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpv6("2404:6800:4006::64")).toBe(true);
    expect(isFetchableUrl("http://[::1]")).toBe(false);
    expect(isFetchableUrl("http://[fe80::1]")).toBe(false);
  });

  it("rejects IPv6 transition addresses that embed a private IPv4 (6to4 / Teredo)", () => {
    // 2002:a9fe:a9fe:: is 6to4 for 169.254.169.254 (the cloud metadata address);
    // 2002:7f00:1:: is 6to4 for 127.0.0.1. Both fall inside 2000::/3 but must be rejected.
    expect(isPublicIpv6("2002:a9fe:a9fe::")).toBe(false);
    expect(isPublicIpv6("2002:7f00:1::")).toBe(false);
    expect(isFetchableUrl("http://[2002:a9fe:a9fe::]")).toBe(false);
    expect(isFetchableUrl("http://[2002:7f00:1::]")).toBe(false);
    // Teredo 2001:0000::/32 also embeds an IPv4 client/server address.
    expect(isPublicIpv6("2001::1")).toBe(false);
    expect(isPublicIpv6("2001:0:0:0:0:0:0:1")).toBe(false);
    expect(isFetchableUrl("http://[2001:0:0:0:0:0:0:1]")).toBe(false);
    // A genuine global-unicast 2001: address (e.g. Google 2001:4860::) stays allowed.
    expect(isPublicIpv6("2001:4860:4860::8888")).toBe(true);
  });

  it("isPublicIpAddress dispatches on family", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("10.0.0.1")).toBe(false);
    expect(isPublicIpAddress("2404:6800:4006::64")).toBe(true);
    expect(isPublicIpAddress("not-an-ip")).toBe(false);
  });

  it("rejects bare hostnames without a dot", () => {
    expect(isFetchableUrl("http://intranet")).toBe(false);
  });

  it("surfaces a typed rejection reason", () => {
    try {
      assertFetchableUrl("http://10.0.0.1");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeUrlError);
      expect((error as UnsafeUrlError).reason).toBe("private_address");
    }
  });
});
