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
 */
export async function GET(request: NextRequest) {
  const oauth = googleOAuthConfig();
  if (!oauth) {
    // Feature OFF: behave as if the route does not exist (do not leak
    // configuration to probes).
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
