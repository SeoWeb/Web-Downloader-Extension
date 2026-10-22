import "server-only";

/**
 * Shared plumbing for the server-side Google authorization-code + PKCE flow
 * (easier-auth D9). Both /api/auth/google route handlers use these so the
 * state-cookie name/attributes and the redirect_uri resolution can never
 * drift between /start and /callback.
 *
 * The browser never sees tokens or any secret: the OAuth client secret lives
 * only in the API gateway, which exchanges the code on our behalf.
 */

export const GOOGLE_OAUTH_COOKIE = "pp_g_oauth";

/** 10 minutes — enough to complete the Google round-trip, nothing more. */
export const GOOGLE_OAUTH_COOKIE_MAX_AGE_SECONDS = 600;

// Host-only cookie (no domain): the state is deployment-scoped by design.
// Path is scoped to the two route handlers so it never rides app requests.
const GOOGLE_OAUTH_COOKIE_BASE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth/google",
} as const;

/** Attributes for SETTING the oauth state cookie. */
export function googleOAuthCookieSetAttrs() {
  return {
    ...GOOGLE_OAUTH_COOKIE_BASE,
    maxAge: GOOGLE_OAUTH_COOKIE_MAX_AGE_SECONDS,
  };
}

/** Attributes for CLEARING the oauth state cookie (same path scope). */
export function googleOAuthCookieClearAttrs() {
  return { ...GOOGLE_OAUTH_COOKIE_BASE, maxAge: 0 };
}

export type GoogleOAuthState = {
  verifier: string;
  state: string;
  /** Post-login target, already sanitized by validateRedirect at /start. */
  redirect: string;
};

/**
 * base64url(JSON state) — base64url because cookie values must not carry
 * raw JSON punctuation (`, {} "` are all problematic in Set-Cookie).
 */
export function encodeGoogleOAuthState(state: GoogleOAuthState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/** Inverse of encodeGoogleOAuthState; null on any tampering/corruption. */
export function decodeGoogleOAuthState(
  raw: string | undefined,
): GoogleOAuthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<GoogleOAuthState> | null;
    if (
      !parsed ||
      typeof parsed.verifier !== "string" ||
      typeof parsed.state !== "string"
    ) {
      return null;
    }
    return {
      verifier: parsed.verifier,
      state: parsed.state,
      redirect: typeof parsed.redirect === "string" ? parsed.redirect : "/app",
    };
  } catch {
    return null;
  }
}

/**
 * redirect_uri is a passthrough at the gateway (easier-auth D4/D9) but must
 * EXACTLY match a URI registered in Google Cloud Console. Defaults to this
 * deployment's own callback; GOOGLE_OAUTH_REDIRECT_URI overrides (e.g. when
 * a proxy rewrites Host so the request URL no longer shows the public origin).
 */
export function googleOAuthRedirectUri(origin: string, override?: string) {
  return override || `${origin}/api/auth/google/callback`;
}
