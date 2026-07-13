import { NextRequest } from "next/server";
import { setAuthCookies, clearAuthCookies } from "@/lib/auth/cookies";
import { API_GATEWAY_URL } from "@/lib/env";

const API_BASE = API_GATEWAY_URL;

const refreshPromises = new Map<string, Promise<Response>>();

function decodeJwtSubject(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(decoded) as { sub?: string };
    return parsed.sub ?? null;
  } catch {
    return null;
  }
}

function responseCookieSetter(response: Response) {
  return {
    set: (
      name: string,
      value: string,
      opts: {
        httpOnly?: boolean;
        secure?: boolean;
        sameSite?: "lax" | "strict" | "none";
        path?: string;
        domain?: string;
        expires?: Date;
        maxAge?: number;
      },
    ) => {
      const parts = [`${name}=${value}`];
      if (opts.path) parts.push(`Path=${opts.path}`);
      if (opts.httpOnly) parts.push("HttpOnly");
      if (opts.secure) parts.push("Secure");
      if (opts.sameSite) {
        const s = opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1);
        parts.push(`SameSite=${s}`);
      }
      if (opts.domain) parts.push(`Domain=${opts.domain}`);
      if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
      response.headers.append("Set-Cookie", parts.join("; "));
    },
  };
}

async function refreshTokens(request: NextRequest): Promise<Response> {
  const refreshToken = (await request.cookies).get("pp_refresh")?.value;
  if (!refreshToken) {
    return new Response(JSON.stringify({ error: "No refresh token" }), {
      status: 401,
    });
  }

  return fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, params);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, params);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, params);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, params);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxyRequest(request, params);
}

async function proxyRequest(
  request: NextRequest,
  params: Promise<{ path: string[] }>,
) {
  const { path } = await params;
  const route = `/${path.join("/")}`;
  const url = new URL(request.url);
  const gatewayUrl = `${API_BASE}${route}?${url.searchParams.toString()}`;

  const cookieStore = await request.cookies;
  const accessToken = cookieStore.get("pp_access")?.value;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const hasBody = request.method !== "GET" && request.method !== "DELETE";
  const body = hasBody ? await request.text() : null;

  let response = await fetch(gatewayUrl, {
    method: request.method,
    headers,
    cache: "no-store",
    ...(hasBody ? { body: body! } : {}),
  });

  if (response.status === 401) {
    const userId = accessToken
      ? decodeJwtSubject(accessToken) ?? "anonymous"
      : "anonymous";
    let refreshPromise = refreshPromises.get(userId);

    if (!refreshPromise) {
      refreshPromise = refreshTokens(request);
      refreshPromises.set(userId, refreshPromise);
    }

    try {
      const refreshRes = await refreshPromise;
      if (refreshRes.ok) {
        const tokens = (await refreshRes.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_at?: number;
        };
        const newAccess = tokens.access_token;

        response = await fetch(gatewayUrl, {
          method: request.method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${newAccess}`,
          },
          cache: "no-store",
          ...(hasBody ? { body: body! } : {}),
        });

        const finalResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });

        setAuthCookies(responseCookieSetter(finalResponse), {
          access: newAccess,
          refresh: tokens.refresh_token ?? "",
          expiresAt: tokens.expires_at ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        });

        return finalResponse;
      }
    } finally {
      refreshPromises.delete(userId);
    }

    // Refresh failed — sign out
    const signOutResponse = new Response(
      JSON.stringify({ error: "Session expired" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
    clearAuthCookies(responseCookieSetter(signOutResponse));
    return signOutResponse;
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
