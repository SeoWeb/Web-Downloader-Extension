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
  upgradeInsecureServerUrl,
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
    expect(() =>
      assertSecureBaseUrl("http://example.com", "Server URL"),
    ).toThrow(
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
  it.each(["https://server.pagepocket.app", "https://example.com"])(
    "allows HTTPS URL %s",
    (rawUrl) => {
      expect(() => assertSecureBaseUrl(rawUrl, "Server URL")).not.toThrow();
    },
  );

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

describe("upgradeInsecureServerUrl", () => {
  const SERVER_URL = "https://server.pagepocket.app";

  // -----------------------------------------------------------------------
  // Same-host http → https (the TLS-terminating-proxy self-heal)
  // -----------------------------------------------------------------------
  it("upgrades a same-host http URL to https", () => {
    expect(
      upgradeInsecureServerUrl(
        "http://server.pagepocket.app/api/v1/sessions/x/download",
        SERVER_URL,
      ),
    ).toBe("https://server.pagepocket.app/api/v1/sessions/x/download");
  });

  it("preserves path, query, and port when upgrading", () => {
    expect(
      upgradeInsecureServerUrl(
        "http://server.pagepocket.app:8443/dl?id=1",
        SERVER_URL,
      ),
    ).toBe("https://server.pagepocket.app:8443/dl?id=1");
  });

  // -----------------------------------------------------------------------
  // Different-host http stays http — the validator must still reject it
  // -----------------------------------------------------------------------
  it("leaves http on a different host unchanged and still rejected", () => {
    const raw = "http://evil.example.com/api/v1/sessions/x/download";
    expect(upgradeInsecureServerUrl(raw, SERVER_URL)).toBe(raw);
    expect(() => assertSecureBaseUrl(raw, "Download URL")).toThrow(
      ConfigurationError,
    );
  });

  // -----------------------------------------------------------------------
  // HTTPS passthrough
  // -----------------------------------------------------------------------
  it.each([
    "https://server.pagepocket.app/api/v1/sessions/x/download",
    "https://example.com/dl",
  ])("passes an https URL through unchanged: %s", (rawUrl) => {
    expect(upgradeInsecureServerUrl(rawUrl, SERVER_URL)).toBe(rawUrl);
  });

  // -----------------------------------------------------------------------
  // Loopback http untouched
  // -----------------------------------------------------------------------
  it("leaves loopback http untouched when the server URL is another host", () => {
    const raw = "http://localhost:8000/api/v1/sessions/x/download";
    expect(upgradeInsecureServerUrl(raw, SERVER_URL)).toBe(raw);
  });

  it("leaves same-host http untouched when the server URL itself is plain http (dev)", () => {
    // A plain-http serverUrl is loopback dev only — never upgrade a dev
    // download URL to https against a server that has no TLS.
    const raw = "http://localhost:8000/api/v1/sessions/x/download";
    expect(upgradeInsecureServerUrl(raw, "http://localhost:8000")).toBe(raw);
  });

  // -----------------------------------------------------------------------
  // Invalid input passes through (the validator reports it)
  // -----------------------------------------------------------------------
  it("returns an unparseable URL unchanged", () => {
    expect(upgradeInsecureServerUrl("not a url", SERVER_URL)).toBe("not a url");
  });

  it("returns the raw URL unchanged when the server URL is unconfigured", () => {
    const raw = "http://server.pagepocket.app/dl";
    expect(upgradeInsecureServerUrl(raw, "")).toBe(raw);
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
