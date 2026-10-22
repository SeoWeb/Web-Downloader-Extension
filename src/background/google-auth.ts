/**
 * Google sign-in flow for PagePocket (easier-auth D4/D6/D7).
 *
 * OAuth 2.0 authorization-code flow with PKCE (S256) against Google's
 * authorization endpoint, opened via chrome.identity.launchWebAuthFlow so
 * the user can pick any Google account. The extension never sees client
 * credentials: it hands `{code, code_verifier, redirect_uri}` to
 * POST /api/v1/auth/google and the BACKEND exchanges the code with its
 * GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (design D4).
 *
 * - Redirect URI is `https://<extension-id>.chromiumapp.org/`; the
 *   extension ID is pinned by the manifest `key`, and chrome.runtime.id IS
 *   that pinned ID — no need to re-derive it from the key at runtime.
 * - The pending flow (verifier + state) is persisted in
 *   chrome.storage.session with a 10-minute TTL: if the service worker is
 *   killed while the Google window is open, the redirect is still
 *   validated against the stored state/verifier instead of stranding the
 *   user (design D4).
 * - Provider errors and popup closes are mapped to typed, user-safe
 *   GoogleSignInError codes — no raw Google error strings reach the UI.
 */

import {
  GOOGLE_CLIENT_ID,
  IS_GOOGLE_SIGN_IN_AVAILABLE,
} from "../common/pagepocket-mode";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Typed, user-safe failure codes. The UI maps these to i18n strings;
 * raw provider error payloads are never surfaced.
 */
export type GoogleSignInErrorCode =
  | "unavailable" // no client ID at build time / no chrome.identity
  | "cancelled" // user closed the window or denied consent
  | "state_mismatch" // redirect state != stored state (CSRF guard)
  | "stale_flow" // pending flow expired or missing (TTL)
  | "no_code" // redirect carried no authorization code
  | "failed"; // anything else

export class GoogleSignInError extends Error {
  public readonly code: GoogleSignInErrorCode;

  constructor(code: GoogleSignInErrorCode) {
    super(GOOGLE_ERROR_MESSAGES[code]);
    this.name = "GoogleSignInError";
    this.code = code;
  }
}

const GOOGLE_ERROR_MESSAGES: Record<GoogleSignInErrorCode, string> = {
  unavailable: "Google sign-in is not available",
  cancelled: "Google sign-in was cancelled",
  state_mismatch: "Google sign-in failed (state mismatch)",
  stale_flow: "Google sign-in expired, please try again",
  no_code: "Google sign-in failed (no authorization code)",
  failed: "Google sign-in failed",
};

/** Data handed to PagePocketClient.googleLogin() after a successful flow. */
export interface GoogleAuthCode {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Pending flow persisted in chrome.storage.session for the TTL window. */
export interface PendingGoogleFlow {
  verifier: string;
  state: string;
  redirectUri: string;
  /** Epoch ms — TTL reference for stranded flows. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_AUTH_SCOPE = "openid email profile";

/** chrome.storage.session key for the pending PKCE flow (design D4). */
export const GOOGLE_AUTH_FLOW_KEY = "pagepocket_google_auth_flow";

/** A pending flow older than this is rejected and cleared. */
export const GOOGLE_AUTH_FLOW_TTL_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// PKCE + validation helpers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

/** base64url (RFC 4648 §5, unpadded) of a byte array. */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Random URL-safe state token (43 chars, 256 bit). */
export function generateState(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * PKCE code_verifier per RFC 7636 §4.1: 43–128 chars from the unreserved
 * URL-safe alphabet. 64 random octets → 86 chars.
 */
export function generateCodeVerifier(): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(64)));
}

/** PKCE S256 challenge (RFC 7636 §4.2): BASE64URL(SHA256(verifier)). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Constant-time-ish state comparison: always scans the full longer input
 * and folds every character difference into one accumulator, so timing
 * leaks nothing beyond length (which the OAuth state param exposes anyway).
 */
export function statesMatch(expected: string, actual: string): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") {
    return false;
  }
  let diff = expected.length === actual.length ? 0 : 1;
  const maxLen = Math.max(expected.length, actual.length);
  for (let i = 0; i < maxLen; i++) {
    // charCodeAt past the end yields NaN, and bitwise ops coerce NaN to 0 —
    // the length flag above already covered that case.
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate the launchWebAuthFlow redirect against the expected origin and
 * state, and extract the authorization code. Throws typed errors only —
 * the caller never sees raw provider error strings.
 */
export function extractCodeFromRedirect(
  redirectUrl: string | undefined,
  expectedOrigin: string,
  expectedState: string,
): string {
  if (!redirectUrl) {
    // No redirect at all — the user closed the window.
    throw new GoogleSignInError("cancelled");
  }

  let url: URL;
  try {
    url = new URL(redirectUrl);
  } catch {
    throw new GoogleSignInError("failed");
  }

  // Exact-origin guard: anything not coming back to
  // https://<extension-id>.chromiumapp.org is a hard failure.
  if (url.origin !== expectedOrigin) {
    throw new GoogleSignInError("failed");
  }

  const error = url.searchParams.get("error");
  if (error) {
    // User denied consent (access_denied) → same UX as closing the popup;
    // any other provider error stays generic.
    throw new GoogleSignInError(
      error === "access_denied" ? "cancelled" : "failed",
    );
  }

  const state = url.searchParams.get("state");
  if (!state || !statesMatch(expectedState, state)) {
    throw new GoogleSignInError("state_mismatch");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new GoogleSignInError("no_code");
  }
  return code;
}

// ---------------------------------------------------------------------------
// Pending-flow persistence (chrome.storage.session, TTL-guarded)
// ---------------------------------------------------------------------------

/** Persist the pending PKCE flow (exported for tests + reuse). */
export async function savePendingFlow(flow: PendingGoogleFlow): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.set({ [GOOGLE_AUTH_FLOW_KEY]: flow });
  } catch {
    // Non-critical — the flow continues from the in-flight closure
  }
}

/**
 * Read the pending flow, rejecting (and clearing) entries older than the
 * TTL so a killed service worker mid-flow can't strand a stale verifier.
 */
export async function loadPendingFlow(): Promise<PendingGoogleFlow | null> {
  try {
    if (!chrome?.storage?.session) return null;
    const result = await chrome.storage.session.get(GOOGLE_AUTH_FLOW_KEY);
    const flow = result[GOOGLE_AUTH_FLOW_KEY] as PendingGoogleFlow | undefined;
    if (
      !flow ||
      typeof flow.createdAt !== "number" ||
      Date.now() - flow.createdAt > GOOGLE_AUTH_FLOW_TTL_MS
    ) {
      await clearPendingFlow();
      return null;
    }
    return flow;
  } catch {
    return null;
  }
}

export async function clearPendingFlow(): Promise<void> {
  try {
    if (!chrome?.storage?.session) return;
    await chrome.storage.session.remove(GOOGLE_AUTH_FLOW_KEY);
  } catch {
    // Non-critical — the TTL covers anything left behind
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the Google authorization flow: build the PKCE authorization URL,
 * open it via chrome.identity.launchWebAuthFlow, validate the redirect
 * against the persisted pending flow, and return the authorization code
 * plus the matching verifier and redirect URI for the backend exchange.
 */
export async function launchGoogleSignIn(): Promise<GoogleAuthCode> {
  if (!IS_GOOGLE_SIGN_IN_AVAILABLE || !GOOGLE_CLIENT_ID) {
    throw new GoogleSignInError("unavailable");
  }
  const extensionId = chrome?.runtime?.id;
  if (
    !extensionId ||
    typeof chrome?.identity?.launchWebAuthFlow !== "function"
  ) {
    throw new GoogleSignInError("unavailable");
  }

  const redirectUri = `https://${extensionId}.chromiumapp.org/`;
  const verifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(verifier);
  const state = generateState();

  // Persist BEFORE opening the window — the service worker may be killed
  // while the Google window is open, and the redirect must validate
  // against the stored state/verifier (design D4).
  await savePendingFlow({
    verifier,
    state,
    redirectUri,
    createdAt: Date.now(),
  });

  const authUrl = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_AUTH_SCOPE);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");

  try {
    const redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });

    // Validate against the STORED flow (not the local closure) so a
    // service worker restart mid-flow still works; a TTL-expired or
    // missing entry surfaces as stale_flow instead of a stranded window.
    const flow = await loadPendingFlow();
    if (!flow) {
      throw new GoogleSignInError("stale_flow");
    }

    const code = extractCodeFromRedirect(
      redirectUrl,
      new URL(flow.redirectUri).origin,
      flow.state,
    );

    await clearPendingFlow();
    return { code, codeVerifier: flow.verifier, redirectUri: flow.redirectUri };
  } catch (err) {
    await clearPendingFlow();
    if (err instanceof GoogleSignInError) {
      throw err;
    }
    // launchWebAuthFlow rejects with its lastError when the user closes
    // the window (or the page fails to load) — map to a user-safe code.
    throw new GoogleSignInError("cancelled");
  }
}
