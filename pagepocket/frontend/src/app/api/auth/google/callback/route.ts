import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "@/lib/auth/cookies";
import { API_GATEWAY_URL, googleOAuthConfig } from "@/lib/env";
import { forwardedClientIpHeadersFrom } from "@/lib/api/client-ip";
import { validateRedirect } from "@/lib/auth/redirect";
import {
  GOOGLE_OAUTH_COOKIE,
  decodeGoogleOAuthState,
  googleOAuthCookieClearAttrs,
  googleOAuthRedirectUri,
} from "@/lib/auth/google-oauth";

/**
 * Google sign-in, step 2 (easier-auth D9). Validates state against the
 * /start cookie, exchanges the authorization code server-side at the
 * gateway (POST /auth/google — the client secret lives only there), and
 * establishes the BFF session via the same setAuthCookies path as password
 * login (/api/session). Never renders: every outcome is a redirect.
 */
export async function GET(request: NextRequest) {
  // Every response leaves with the state cookie cleared — read-once
  // semantics (a replayed callback finds no cookie and fails state check).
  function finish(target: string): NextResponse {
    const response = NextResponse.redirect(new URL(target, request.url), 302);
    response.cookies.set({
      name: GOOGLE_OAUTH_COOKIE,
      value: "",
      ...googleOAuthCookieClearAttrs(),
    });
    return response;
  }

  const params = request.nextUrl.searchParams;

  // Google-reported failure (user cancelled, provider hiccup, ...). The
  // cancelled case gets a friendlier message; everything else stays generic.
  const googleError = params.get("error");
  if (googleError) {
    return finish(
      googleError === "access_denied"
        ? "/login?error=google_cancelled"
        : "/login?error=google",
    );
  }

  const code = params.get("code");
  const state = params.get("state");
  const oauthState = decodeGoogleOAuthState(
    request.cookies.get(GOOGLE_OAUTH_COOKIE)?.value,
  );

  // Missing cookie (expired, third-party-blocked, or forged flow) and state
  // mismatch are deliberately indistinguishable to the caller.
  if (!code || !state || !oauthState || state !== oauthState.state) {
    return finish("/login?error=google");
  }

  const redirectUri = googleOAuthRedirectUri(
    new URL(request.url).origin,
    googleOAuthConfig()?.redirectUri,
  );

  let res: Response;
  try {
    res = await fetch(`${API_GATEWAY_URL}/auth/google`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...forwardedClientIpHeadersFrom(request.headers),
      },
      body: JSON.stringify({
        code,
        code_verifier: oauthState.verifier,
        redirect_uri: redirectUri,
      }),
    });
  } catch {
    return finish("/login?error=google");
  }

  if (!res.ok) {
    // Do not leak gateway detail (invalid code, unverified email, ...) —
    // the generic message keeps attackers blind.
    return finish("/login?error=google");
  }

  const data = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
  } | null;
  if (!data?.access_token) {
    return finish("/login?error=google");
  }

  const response = finish(validateRedirect(oauthState.redirect));
  setAuthCookies(response.cookies, {
    access: data.access_token,
    ...(data.refresh_token ? { refresh: data.refresh_token } : {}),
  });
  return response;
}
