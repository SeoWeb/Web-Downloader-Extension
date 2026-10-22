/**
 * Tests for the Google sign-in flow helpers (easier-auth D4, task 3.3).
 *
 * Covers the pure logic: PKCE S256 derivation (RFC 7636), redirect
 * validation against the pinned chromiumapp.org origin, constant-time-ish
 * state matching, and the TTL guard for the pending flow persisted in
 * chrome.storage.session (a killed service worker mid-flow must not
 * strand a stale verifier).
 */

import * as nodeCrypto from "node:crypto";
import {
  GOOGLE_AUTH_FLOW_KEY,
  GOOGLE_AUTH_FLOW_TTL_MS,
  GoogleSignInError,
  deriveCodeChallenge,
  extractCodeFromRedirect,
  generateCodeVerifier,
  generateState,
  loadPendingFlow,
  savePendingFlow,
  statesMatch,
} from "../../src/background/google-auth";

// ---------------------------------------------------------------------------
// chrome mocks (setup.cjs provides storage.local; tests need .session +
// chrome.runtime.id, which the redirect URI derives from the pinned key)
// ---------------------------------------------------------------------------

const sessionStore: Record<string, unknown> = {};

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).session = {
    _store: sessionStore,
    get: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const k of keyArr) {
        if (sessionStore[k] !== undefined) {
          result[k] = sessionStore[k];
        }
      }
      return result;
    },
    set: async (items: Record<string, unknown>) => {
      Object.assign(sessionStore, items);
    },
    remove: async (keys: string | string[]) => {
      const keyArr = Array.isArray(keys) ? keys : [keys];
      for (const k of keyArr) {
        delete sessionStore[k];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXTENSION_ID = "aeojmgngnebhbjpncamiplkimkbnmpmk";
const REDIRECT_ORIGIN = `https://${EXTENSION_ID}.chromiumapp.org`;

/** Independent base64url(sha256) implementation for cross-checking. */
function referenceS256Challenge(verifier: string): string {
  return nodeCrypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function redirectWith(params: Record<string, string>): string {
  const url = new URL(REDIRECT_ORIGIN + "/");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof GoogleSignInError) return err.code;
    throw err;
  }
  throw new Error("expected the call to throw a GoogleSignInError");
}

// ---------------------------------------------------------------------------
// PKCE derivation
// ---------------------------------------------------------------------------

describe("PKCE derivation (RFC 7636)", () => {
  it("generates URL-safe code verifiers in the 43–128 char range", () => {
    for (let i = 0; i < 20; i++) {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("generates 86-char verifiers from 64 random octets", () => {
    expect(generateCodeVerifier()).toHaveLength(86);
  });

  it("derives the S256 challenge as base64url(sha256(verifier))", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe(referenceS256Challenge(verifier));
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, unpadded
    expect(challenge).not.toContain("=");
  });

  it("derives a stable challenge for the RFC 7636 appendix-B vector", async () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // → code_challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const challenge = await deriveCodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates random, unguessable state tokens", () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Redirect validation
// ---------------------------------------------------------------------------

describe("redirect validation", () => {
  const state = generateState();

  it("extracts the code from a valid redirect", () => {
    const code = extractCodeFromRedirect(
      redirectWith({ code: "abc123", state, scope: "openid email profile" }),
      REDIRECT_ORIGIN,
      state,
    );
    expect(code).toBe("abc123");
  });

  it("maps a missing redirect URL (popup closed) to cancelled", () => {
    expect(
      errorCodeOf(() =>
        extractCodeFromRedirect(undefined, REDIRECT_ORIGIN, state),
      ),
    ).toBe("cancelled");
    expect(
      errorCodeOf(() => extractCodeFromRedirect("", REDIRECT_ORIGIN, state)),
    ).toBe("cancelled");
  });

  it("maps error=access_denied to cancelled", () => {
    expect(
      errorCodeOf(() =>
        extractCodeFromRedirect(
          redirectWith({ error: "access_denied", state }),
          REDIRECT_ORIGIN,
          state,
        ),
      ),
    ).toBe("cancelled");
  });

  it("maps other provider errors to a generic failure", () => {
    expect(
      errorCodeOf(() =>
        extractCodeFromRedirect(
          redirectWith({ error: "server_error", state }),
          REDIRECT_ORIGIN,
          state,
        ),
      ),
    ).toBe("failed");
  });

  it("rejects redirects from a foreign origin", () => {
    const evil = "https://evil.example.com/?code=abc&state=" + state;
    expect(
      errorCodeOf(() => extractCodeFromRedirect(evil, REDIRECT_ORIGIN, state)),
    ).toBe("failed");
    // Right host, wrong scheme
    const http = redirectWith({ code: "abc", state }).replace(
      "https://",
      "http://",
    );
    expect(
      errorCodeOf(() => extractCodeFromRedirect(http, REDIRECT_ORIGIN, state)),
    ).toBe("failed");
  });

  it("rejects a redirect without any code", () => {
    expect(
      errorCodeOf(() =>
        extractCodeFromRedirect(
          redirectWith({ state }),
          REDIRECT_ORIGIN,
          state,
        ),
      ),
    ).toBe("no_code");
  });

  it("rejects unparseable redirect URLs", () => {
    expect(
      errorCodeOf(() =>
        extractCodeFromRedirect("::::", REDIRECT_ORIGIN, state),
      ),
    ).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// State comparison
// ---------------------------------------------------------------------------

describe("state comparison", () => {
  it("accepts identical states", () => {
    const state = generateState();
    expect(statesMatch(state, state)).toBe(true);
  });

  it("rejects mismatched states (wrong value)", () => {
    expect(statesMatch(generateState(), generateState())).toBe(false);
  });

  it("rejects mismatched states (different lengths)", () => {
    expect(statesMatch("short", "a-much-longer-state-value")).toBe(false);
    expect(statesMatch("abc", "abd")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pending-flow TTL
// ---------------------------------------------------------------------------

describe("pending flow TTL", () => {
  beforeEach(() => {
    Object.keys(sessionStore).forEach((k) => delete sessionStore[k]);
  });

  it("returns a fresh pending flow intact", async () => {
    await savePendingFlow({
      verifier: "v".repeat(86),
      state: "s".repeat(43),
      redirectUri: `https://${EXTENSION_ID}.chromiumapp.org/`,
      createdAt: Date.now(),
    });

    const flow = await loadPendingFlow();
    expect(flow).not.toBeNull();
    expect(flow?.state).toBe("s".repeat(43));
    expect(sessionStore[GOOGLE_AUTH_FLOW_KEY]).toBeDefined();
  });

  it("rejects and clears a flow past the TTL", async () => {
    await savePendingFlow({
      verifier: "stale-verifier",
      state: "stale-state",
      redirectUri: `https://${EXTENSION_ID}.chromiumapp.org/`,
      createdAt: Date.now() - GOOGLE_AUTH_FLOW_TTL_MS - 1_000,
    });

    const flow = await loadPendingFlow();
    expect(flow).toBeNull();
    expect(sessionStore[GOOGLE_AUTH_FLOW_KEY]).toBeUndefined();
  });

  it("rejects a flow with a malformed createdAt", async () => {
    sessionStore[GOOGLE_AUTH_FLOW_KEY] = {
      verifier: "v",
      state: "s",
      redirectUri: `https://${EXTENSION_ID}.chromiumapp.org/`,
    };
    expect(await loadPendingFlow()).toBeNull();
    expect(sessionStore[GOOGLE_AUTH_FLOW_KEY]).toBeUndefined();
  });

  it("returns null when no flow is stored", async () => {
    expect(await loadPendingFlow()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Availability guard
// ---------------------------------------------------------------------------

describe("availability guard", () => {
  it("launchGoogleSignIn is unavailable without a build-time client ID", async () => {
    const { launchGoogleSignIn } =
      await import("../../src/background/google-auth");
    // tests run without VITE_GOOGLE_CLIENT_ID (vitest.config only defines
    // VITE_SERVER_URL), so the guard must fire before any chrome call.
    await expect(launchGoogleSignIn()).rejects.toMatchObject({
      name: "GoogleSignInError",
      code: "unavailable",
    });
  });
});
