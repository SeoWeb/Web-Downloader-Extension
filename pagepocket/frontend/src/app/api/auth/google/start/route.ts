import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { googleOAuthConfig } from "@/lib/env";
import { validateRedirect } from "@/lib/auth/redirect";
import {
  GOOGLE_OAUTH_COOKIE,
  encodeGoogleOAuthState,
  googleOAuthCookieSetAttrs,
  googleOAuthRedirectUri,
} from "@/lib/auth/google-oauth";

/**
 * Google sign-in, step 1 (easier-auth D9): mint a PKCE S256 pair + state,
 * park them in a short-lived httpOnly cookie scoped to /api/auth/google,
 * and 302 the browser to Google's authorization endpoint. Step 2 (the
 * callback) validates state and exchanges the code server-side at the
 * gateway — the browser never sees tokens or any secret.
 *
 * Cross-host prod fix (2026-11-12): two public hosts serve this Next app —
 * the marketing site and the app host — but the state cookie below is
 * host-only (no Domain, deliberate) while GOOGLE_OAUTH_REDIRECT_URI pins
 * the callback to ONE host. A dance started on the other host would leave
 * its state cookie there, yet Google returns to the redirect_uri's host,
 * where the cookie does not exist — the callback then fails its state
 * check before the gateway is ever called. So the dance must happen
 * entirely on the callback's host: when the request's public host differs
 * from the canonical origin derived from the redirect_uri override, /start
 * first bounces the browser to the canonical /start (no cookie, ?redirect=
 * preserved) and only the canonical hop mints state and redirects to
 * Google.
 */

/**
 * The PUBLIC origin the browser actually used. nginx passes `Host $host` +
 * `X-Forwarded-Proto $scheme`, and behind it request.url shows the proxy's
 * INTERNAL origin — exactly why relativeRedirect() exists — so the Host
 * header is the reliable source; fall back to request.url when the header
 * is absent (direct/dev access, and the Host-less requests Next can hand a
 * route handler).
 */
function publicRequestOrigin(request: NextRequest): string {
  const host = request.headers.get("host");
  if (!host) return new URL(request.url).origin;
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  // Production is https; only an explicit http override downgrades.
  const proto = forwardedProto === "http" ? "http" : "https";
  return `${proto}://${host}`;
}

/**
 * Canonical OAuth origin — the origin of the ABSOLUTE redirect_uri
 * override (the URI registered in Google Cloud Console, so the host Google
 * will actually return to). Null when no absolute override is configured
 * (local dev): the request origin is then canonical by definition and the
 * flow behaves exactly as before.
 */
function canonicalOAuthOrigin(redirectUri: string | undefined): string | null {
  if (!redirectUri) return null;
  try {
    return new URL(redirectUri).origin;
  } catch {
    return null; // relative override — no canonical host to hop to
  }
}

export async function GET(request: NextRequest) {
  const oauth = googleOAuthConfig();
  if (!oauth) {
    // Feature OFF: behave as if the route does not exist (do not leak
    // configuration to probes).
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Canonical-start redirect (see the doc comment above): hosts are
  // compared WITHOUT scheme, so an http/https difference never triggers a
  // hop. The guard below means we never redirect to a URL whose host
  // equals the incoming public host — on the canonical host the two are
  // equal and the flow falls through unchanged; a misconfiguration that
  // somehow made them equal would therefore fall through to the normal
  // flow rather than loop.
  const canonicalOrigin = canonicalOAuthOrigin(oauth.redirectUri);
  const publicOrigin = publicRequestOrigin(request);
  if (
    canonicalOrigin !== null &&
    new URL(canonicalOrigin).host !== new URL(publicOrigin).host
  ) {
    // ABSOLUTE target on purpose: it is a real public URL on another host,
    // so the internal-origin concern behind relativeRedirect() does not
    // apply (that helper is for same-host, proxy-hidden targets).
    const target = new URL("/api/auth/google/start", canonicalOrigin);
    const redirect = request.nextUrl.searchParams.get("redirect");
    if (redirect !== null) target.searchParams.set("redirect", redirect);
    return NextResponse.redirect(target, 302);
  }

  // RFC 7636: verifier is base64url randomness (32 bytes → exactly 43
  // chars), challenge is base64url(SHA256(verifier)), method S256.
  const verifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const state = randomBytes(32).toString("base64url");

  // Post-login target, sanitized at the door AND re-validated in the
  // callback (defense in depth against a tampered cookie).
  const redirect = validateRedirect(
    request.nextUrl.searchParams.get("redirect"),
  );
  const redirectUri = googleOAuthRedirectUri(
    new URL(request.url).origin,
    oauth.redirectUri,
  );

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", oauth.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  // Always offer the account picker — shared machines and multi-account
  // users must be able to switch Google identities explicitly.
  authorizeUrl.searchParams.set("prompt", "select_account");

  const response = NextResponse.redirect(authorizeUrl.toString(), 302);
  response.cookies.set({
    name: GOOGLE_OAUTH_COOKIE,
    value: encodeGoogleOAuthState({ verifier, state, redirect }),
    ...googleOAuthCookieSetAttrs(),
  });
  return response;
}
