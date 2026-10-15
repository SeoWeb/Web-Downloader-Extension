/**
 * Tests for transport security enforcement (D11 / task 7.4).
 *
 * Base URLs that use plain http:// on a non-loopback host must fail fast at
 * client construction (ConfigurationError) instead of only warning. Loopback
 * hosts (localhost / 127.0.0.1 / [::1]) stay allowed for local development.
 *
 * The vitest config pins VITE_SERVER_URL to an https:// URL (see
 * vitest.config.ts `define`), so ServerClient/PagePocketClient construction
 * in every other test file doubles as the "https is allowed" scenario.
 */

import {
  ServerClient,
  ConfigurationError,
  assertSecureBaseUrl,
  isLoopbackHost,
} from "../../src/background/server-client";

describe("isLoopbackHost", () => {
  it.each(["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"])(
    "treats %s as loopback",
    (hostname) => {
      expect(isLoopbackHost(hostname)).toBe(true);
    },
  );

  it.each(["example.com", "192.168.1.10", "10.0.0.5", "localhost.evil.com"])(
    "treats %s as non-loopback",
    (hostname) => {
      expect(isLoopbackHost(hostname)).toBe(false);
    },
  );
});

describe("assertSecureBaseUrl", () => {
  // -----------------------------------------------------------------------
  // Plain HTTP on a non-loopback host → throws
  // -----------------------------------------------------------------------
  it.each([
    "http://example.com",
    "http://example.com:8000",
    "http://192.168.1.10:8000",
    "http://server.pagepocket.app",
  ])("throws ConfigurationError for insecure URL %s", (rawUrl) => {
    expect(() => assertSecureBaseUrl(rawUrl, "Server URL")).toThrow(
      ConfigurationError,
    );
  });

  it("explains the problem and the allowed loopback exception", () => {
    expect(() => assertSecureBaseUrl("http://example.com", "Server URL")).toThrow(
      /plain HTTP is not allowed.*example\.com.*localhost \/ 127\.0\.0\.1 \/ \[::1\]/s,
    );
  });

  // -----------------------------------------------------------------------
  // Loopback HTTP → allowed (local development)
  // -----------------------------------------------------------------------
  it.each([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8090",
    "http://localhost",
  ])("allows loopback HTTP URL %s", (rawUrl) => {
    expect(() => assertSecureBaseUrl(rawUrl, "Server URL")).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // HTTPS → allowed
  // -----------------------------------------------------------------------
  it.each([
    "https://server.pagepocket.app",
    "https://example.com",
  ])("allows HTTPS URL %s", (rawUrl) => {
    expect(() => assertSecureBaseUrl(rawUrl, "Server URL")).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  it("allows an empty URL (unconfigured — callers guard that separately)", () => {
    expect(() => assertSecureBaseUrl("", "Server URL")).not.toThrow();
  });

  it("throws for an unparseable URL instead of silently continuing", () => {
    expect(() => assertSecureBaseUrl("not a url", "Server URL")).toThrow(
      ConfigurationError,
    );
  });

  it("throws for URLs that only look like localhost", () => {
    expect(() =>
      assertSecureBaseUrl("http://localhost.evil.com", "Server URL"),
    ).toThrow(ConfigurationError);
  });
});

describe("ServerClient construction (VITE_SERVER_URL is https in tests)", () => {
  it("constructs without throwing when the configured URL is HTTPS", () => {
    expect(new ServerClient()).toBeDefined();
  });

  it("exports a ConfigurationError distinguishable from other client errors", () => {
    const err = new ConfigurationError("test");
    expect(err.name).toBe("ConfigurationError");
    expect(err).toBeInstanceOf(Error);
  });
});
