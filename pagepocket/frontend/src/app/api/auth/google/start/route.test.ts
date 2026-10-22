import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

// env.ts parses process.env at import time — seed before importing the route.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";
// Google sign-in config is resolved PER REQUEST (googleOAuthConfig in
// env.ts) — ON for this suite; the 404 case flips process.env per test
// without a module reload.
process.env.GOOGLE_CLIENT_ID ||=
  "test-google-client-id.apps.googleusercontent.com";

const { GET } = await import("./route");

type RouteResult = Awaited<ReturnType<typeof GET>>;

function callGet(search = ""): Promise<RouteResult> {
  return GET(
    new NextRequest(`http://localhost:3000/api/auth/google/start${search}`),
  );
}

function stateSetCookie(res: Awaited<RouteResult>): string {
  const setCookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("pp_g_oauth="));
  expect(setCookie).toBeDefined();
  return setCookie!;
}

function decodeStateCookie(res: Awaited<RouteResult>): {
  verifier: string;
  state: string;
  redirect: string;
} {
  const pair = stateSetCookie(res).split(";")[0]!;
  return JSON.parse(
    Buffer.from(pair.slice("pp_g_oauth=".length), "base64url").toString("utf8"),
  );
}

describe("GET /api/auth/google/start — PKCE + state bootstrap (D9)", () => {
  it("302s to Google's authorization endpoint with all required params", async () => {
    const res = await callGet();
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.pathname).toBe("/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe(
      "test-google-client-id.apps.googleusercontent.com",
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/google/callback",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("sets code_challenge to base64url(sha256(verifier)) — S256 relation", async () => {
    const res = await callGet();
    const state = decodeStateCookie(res);
    // 32 random bytes → exactly 43 base64url chars (RFC 7636 minimum).
    expect(state.verifier).toHaveLength(43);

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(state.verifier).digest("base64url"),
    );
    // The state param matches the cookie — the callback pairs them back.
    expect(location.searchParams.get("state")).toBe(state.state);
  });

  it("stores the state in an httpOnly, path-scoped, 10-minute host-only cookie", async () => {
    const res = await callGet();
    const setCookie = stateSetCookie(res);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/api/auth/google");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("SameSite=lax");
    // Host-only on purpose: the state is deployment-scoped, not domain-shared.
    expect(setCookie).not.toContain("Domain=");
  });

  it("threads a valid ?redirect= target into the state cookie", async () => {
    const res = await callGet("?redirect=/app/settings");
    expect(decodeStateCookie(res).redirect).toBe("/app/settings");
  });

  it("sanitizes open-redirect attempts in ?redirect= at the door", async () => {
    for (const evil of ["https://evil.com", "//evil.com", "/\\evil.com"]) {
      const res = await callGet(`?redirect=${encodeURIComponent(evil)}`);
      expect(decodeStateCookie(res).redirect).toBe("/app");
    }
  });

  it("honors GOOGLE_OAUTH_REDIRECT_URI for the redirect_uri passthrough", async () => {
    const original = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.GOOGLE_OAUTH_REDIRECT_URI =
      "https://app.pagepocket.app/api/auth/google/callback";
    try {
      const res = await callGet();
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("redirect_uri")).toBe(
        "https://app.pagepocket.app/api/auth/google/callback",
      );
    } finally {
      if (original === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
      else process.env.GOOGLE_OAUTH_REDIRECT_URI = original;
    }
  });

  it("returns 404 when GOOGLE_CLIENT_ID is unset (feature OFF)", async () => {
    const original = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const res = await callGet();
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
    } finally {
      process.env.GOOGLE_CLIENT_ID = original;
    }
  });
});
