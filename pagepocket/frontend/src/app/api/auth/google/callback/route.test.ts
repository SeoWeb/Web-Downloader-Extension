import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { NextRequest } from "next/server";

// env.ts parses process.env at import time — seed before importing the route.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";
process.env.GOOGLE_CLIENT_ID ||=
  "test-google-client-id.apps.googleusercontent.com";

const { GET } = await import("./route");

const GATEWAY_URL = "http://localhost:8090/api/v1/auth/google";
const VERIFIER = "v".repeat(43);
const STATE = "state-123";

const fetchMock = vi.fn();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
});

function stateCookieValue(
  redirect = "/app",
  state = STATE,
  verifier = VERIFIER,
): string {
  return Buffer.from(
    JSON.stringify({ verifier, state, redirect }),
    "utf8",
  ).toString("base64url");
}

type RouteResult = Awaited<ReturnType<typeof GET>>;

function callGet(search: string, cookie?: string): Promise<RouteResult> {
  // `cookie` is the raw state-cookie VALUE; the name prefix goes here.
  return GET(
    new NextRequest(`http://localhost:3000/api/auth/google/callback${search}`, {
      ...(cookie ? { headers: { cookie: `pp_g_oauth=${cookie}` } } : {}),
    }),
  );
}

function gatewayOk(
  tokens: object = {
    access_token: "access.jwt.value",
    refresh_token: "refresh.jwt.value",
  },
): Response {
  return new Response(JSON.stringify(tokens), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function locationOf(res: Awaited<RouteResult>): URL {
  const location = res.headers.get("location");
  expect(location).toBeDefined();
  return new URL(location!);
}

describe("GET /api/auth/google/callback — Google-reported errors (D9)", () => {
  it("redirects access_denied to /login?error=google_cancelled, gateway untouched", async () => {
    const res = await callGet(`?error=access_denied&state=${STATE}`);
    expect(res.status).toBe(302);
    expect(locationOf(res).pathname).toBe("/login");
    expect(locationOf(res).searchParams.get("error")).toBe("google_cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects other Google errors to /login?error=google", async () => {
    const res = await callGet("?error=server_error");
    expect(locationOf(res).searchParams.get("error")).toBe("google");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/google/callback — state validation (D9)", () => {
  it("redirects a missing state cookie to /login?error=google", async () => {
    const res = await callGet(`?code=abc&state=${STATE}`);
    expect(locationOf(res).searchParams.get("error")).toBe("google");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects a state mismatch to /login?error=google", async () => {
    const res = await callGet("?code=abc&state=tampered", stateCookieValue());
    expect(locationOf(res).searchParams.get("error")).toBe("google");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/auth/google/callback — code exchange + session (D9)", () => {
  it("exchanges the code at the gateway and establishes the BFF session", async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk());
    const res = await callGet(
      `?code=test-code&state=${STATE}`,
      stateCookieValue("/app/settings"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GATEWAY_URL);
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
    expect(JSON.parse(init.body)).toEqual({
      code: "test-code",
      code_verifier: VERIFIER,
      redirect_uri: "http://localhost:3000/api/auth/google/callback",
    });

    expect(res.status).toBe(302);
    expect(locationOf(res).pathname).toBe("/app/settings");

    const setCookies = res.headers.getSetCookie().join("\n");
    expect(setCookies).toContain("pp_access=access.jwt.value");
    expect(setCookies).toContain("pp_refresh=refresh.jwt.value");
    // State cookie is cleared even on success — read-once semantics.
    expect(setCookies).toContain("pp_g_oauth=;");
    expect(setCookies).toContain("Max-Age=0");
  });

  it("forwards the inbound client-IP chain verbatim to the gateway", async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk());
    await GET(
      new NextRequest(
        `http://localhost:3000/api/auth/google/callback?code=c&state=${STATE}`,
        {
          headers: {
            cookie: `pp_g_oauth=${stateCookieValue()}`,
            "x-forwarded-for": "203.0.113.7, 70.41.3.18",
          },
        },
      ),
    );
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({
      "X-Forwarded-For": "203.0.113.7, 70.41.3.18",
    });
  });

  it("adds no X-Forwarded-For when the inbound request has none", async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk());
    await callGet(`?code=c&state=${STATE}`, stateCookieValue());
    expect(fetchMock.mock.calls[0]![1].headers).not.toHaveProperty(
      "X-Forwarded-For",
    );
  });

  it("redirects a gateway rejection to /login?error=google without leaking detail", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "invalid google code" }), {
        status: 401,
      }),
    );
    const res = await callGet(`?code=bad&state=${STATE}`, stateCookieValue());
    const location = locationOf(res);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("google");

    const setCookies = res.headers.getSetCookie().join("\n");
    expect(setCookies).not.toContain("pp_access=");
    expect(setCookies).not.toContain("pp_refresh=");
  });

  it("redirects a malformed gateway success (no access_token) to /login?error=google", async () => {
    fetchMock.mockResolvedValueOnce(gatewayOk({ access_token: "" }));
    const res = await callGet(`?code=c&state=${STATE}`, stateCookieValue());
    expect(locationOf(res).searchParams.get("error")).toBe("google");
  });

  it("honors GOOGLE_OAUTH_REDIRECT_URI in the exchange body", async () => {
    const original = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.GOOGLE_OAUTH_REDIRECT_URI =
      "https://app.pagepocket.app/api/auth/google/callback";
    fetchMock.mockResolvedValueOnce(gatewayOk());
    try {
      await callGet(`?code=c&state=${STATE}`, stateCookieValue());
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).redirect_uri).toBe(
        "https://app.pagepocket.app/api/auth/google/callback",
      );
    } finally {
      if (original === undefined) delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
      else process.env.GOOGLE_OAUTH_REDIRECT_URI = original;
    }
  });
});
