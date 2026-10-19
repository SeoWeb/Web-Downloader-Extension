import { NextRequest } from "next/server";
import { setAuthCookies, clearAuthCookies } from "@/lib/auth/cookies";
import { API_GATEWAY_URL, assetTokenConfig } from "@/lib/env";
import { injectAssetToken, mintAssetToken } from "@/lib/asset-token";
import {
  contentTypeForPath,
  corsEchoHeaders,
  sandboxHeaders,
} from "@/lib/serving-headers";
import { forwardedClientIpHeadersFrom } from "@/lib/api/client-ip";
import { isSafeSegment } from "@/lib/proxy-path";

const API_BASE = API_GATEWAY_URL;

const refreshPromises = new Map<string, Promise<RefreshOutcome>>();

// Authenticated archived-file serving route
// (/api/pp/archive/pages/{page_id}/f/* — the gateway's
// /api/v1/archive/pages/{page_id}/f/{file_path} — plus the legacy
// single-segment /api/pp/archive/{page_id}/f/* shape). Archived content must
// never leave this proxy without the sandbox header set
// (archived-html-serving) — same semantics as the gateway's serving.py.
const ARCHIVE_FILE_ROUTE = /^\/archive\/(?:pages\/)?([^/]+)\/f\/(.+)$/;

// Route allow-list (archived-file-proxy / design D11): the COMPOSED upstream
// path (gateway base path + proxied route) must stay inside these route
// families after normalization — the gateway's remaining surface (/docs,
// openapi.json, …) is unreachable through this proxy. Bare family roots are
// admitted (`(\/|$)`): the gateway exposes `POST ""`/`GET ""` at the `/share`
// root. Traversal safety is orthogonal — isSafeSegment rejects dot-segments
// per segment before the composed path is tested here.
const ALLOWED_UPSTREAM =
  /^\/api\/v1\/(archive|library|search|share|auth)(\/|$)/;

const GATEWAY_BASE_PATH = new URL(API_BASE).pathname.replace(/\/+$/, "");

function archiveFilePath(route: string): string | null {
  const match = route.match(ARCHIVE_FILE_ROUTE);
  return match ? match[2]! : null;
}

/** The page id of an archive file route (page_id owns the requested files). */
function archivePageId(route: string): string | null {
  const match = route.match(ARCHIVE_FILE_ROUTE);
  return match ? match[1]! : null;
}

/**
 * Normalize the catch-all segments into the composed upstream path, or null
 * when the request must be rejected with 400 without proxying: any segment
 * failing the dot-segment/escape validation, or any composed path outside
 * the allowed route families, is rejected.
 */
function normalizeUpstreamRoute(segments: string[]): string | null {
  for (const segment of segments) {
    if (!isSafeSegment(segment)) return null;
  }
  const route = `/${segments.join("/")}`;
  const upstreamPath = `${GATEWAY_BASE_PATH}${route}`;
  return ALLOWED_UPSTREAM.test(upstreamPath) ? route : null;
}

/**
 * Force the response private for caching (archived-file-proxy "Private
 * Caching of Cookie-Authenticated Files"): these responses are
 * cookie-authenticated, so shared caches (Cloudflare) must never store or
 * reuse them across users. Preserve upstream max-age and other directives;
 * strip `public`/`immutable`.
 */
function privatizeCacheControl(headers: Headers): void {
  const directives = (headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim())
    .filter(
      (directive) =>
        directive.length > 0 && !/^(public|immutable)$/i.test(directive),
    );
  if (!directives.some((directive) => directive.toLowerCase() === "private")) {
    directives.unshift("private");
  }
  headers.set("cache-control", directives.join(", "));
}

async function proxyResponse(
  response: Response,
  filePath: string | null,
  requestOrigin: string | null,
  pageId: string | null,
  userId: string | null,
): Promise<Response> {
  if (!filePath) {
    // Non-file API responses gain no CORS headers — the Origin echo exists
    // only for the archived-file routes consumed by the sandboxed viewer
    // iframes (opaque origin `null`).
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  const headers = new Headers(response.headers);
  const sandbox = sandboxHeaders(
    response.headers.get("content-type") ?? contentTypeForPath(filePath),
  );
  const isHtml =
    (sandbox["Content-Type"] ?? "").split(";", 1)[0]!.trim().toLowerCase() ===
    "text/html";
  for (const [name, value] of Object.entries(sandbox)) {
    headers.set(name, value);
  }
  // Opaque-origin viewer CORS (archived-html-serving): echo the request
  // Origin verbatim (including the literal `null`) on file responses only.
  for (const [name, value] of Object.entries(corsEchoHeaders(requestOrigin))) {
    headers.set(name, value);
  }
  privatizeCacheControl(headers);

  // Signed asset tokens (archived-html-serving "Credential-less archived
  // asset access"): the sandboxed viewer's CORS-mode subresource loads cannot
  // send cookies, so served HTML gets `<base href="./at/{token}/">` injected
  // after <head> — the document URL is
  // /api/pp/archive/pages/{id}/f/index.html, so the stored HTML's RELATIVE
  // refs (./, ../, plain, inline CSS url()) resolve to /f/at/{token}/…,
  // which the gateway accepts instead of the cookie. ONLY text/html bodies
  // are touched (one element insert — asset URLs are never rewritten);
  // css/js/img bytes stream through untouched (they are fetched under the
  // tokenized URL the base element produced).
  const tokenConfig = assetTokenConfig();
  if (tokenConfig && isHtml && pageId && userId && response.status === 200) {
    let html: string | null = null;
    try {
      html = await response.text();
    } catch {
      html = null;
    }
    if (html !== null) {
      // The body is now buffered (and possibly decompressed) — a stale
      // Content-Encoding would corrupt it; drop it. Content-Length is
      // refreshed by undici when the body changes (rewritten return below).
      headers.delete("Content-Encoding");
      try {
        const token = await mintAssetToken({
          secret: tokenConfig.secret,
          pageId,
          userId,
          ttlSeconds: tokenConfig.ttlSeconds,
        });
        const rewritten = injectAssetToken(html, pageId, token);
        if (rewritten.modified) {
          // Fresh tokens every view: browsers must re-fetch the document
          // instead of reusing a cached copy whose token may be from an
          // older bucket (archived-html-serving fix E).
          headers.set("Cache-Control", "private, no-cache");
          headers.delete("Content-Length");
          return new Response(rewritten.html, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      } catch {
        // Mint/inject failure must never break document serving — fall
        // through and serve the unrewritten bytes (exactly today's behavior;
        // the feature degrades gracefully when OFF).
      }
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    // Body unreadable — fall through and stream whatever remains.
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
        const s =
          opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1);
        parts.push(`SameSite=${s}`);
      }
      if (opts.domain) parts.push(`Domain=${opts.domain}`);
      if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
      response.headers.append("Set-Cookie", parts.join("; "));
    },
  };
}

type RefreshOutcome =
  | { kind: "ok"; accessToken: string; refreshToken?: string }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };

/**
 * Single-flight refresh primitive (pagepocket-frontend-auth "Silent Token
 * Refresh"). Returns a definite outcome and NEVER throws, so single-flight
 * waiters are not poisoned by an unhandled rejection: network failures,
 * non-JSON bodies, and gateway 5xx map to `unavailable`; a 401 (or a missing
 * refresh cookie) maps to `unauthorized`.
 */
async function refreshTokens(request: NextRequest): Promise<RefreshOutcome> {
  const refreshToken = (await request.cookies).get("pp_refresh")?.value;
  if (!refreshToken) {
    return { kind: "unauthorized" };
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...forwardedClientIpHeadersFrom(request.headers),
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (response.status === 401) return { kind: "unauthorized" };
  if (!response.ok) return { kind: "unavailable" };

  try {
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
    };
    if (!tokens.access_token) return { kind: "unavailable" };
    return {
      kind: "ok",
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function setAuthCookiesOn(
  response: Response,
  outcome: Extract<RefreshOutcome, { kind: "ok" }>,
) {
  // An empty/absent rotated refresh token must never be written as an empty
  // pp_refresh cookie (the session keeps its existing refresh token).
  setAuthCookies(responseCookieSetter(response), {
    access: outcome.accessToken,
    ...(outcome.refreshToken ? { refresh: outcome.refreshToken } : {}),
  });
}

type UpstreamRequest = {
  body: BodyInit | undefined;
  /**
   * Replay copy for the post-refresh retry: `null` marks a streamed
   * (non-replayable) request body, an empty string marks "no body", and a
   * buffered JSON body is replayed verbatim.
   */
  replayBody: string | null;
};

async function prepareUpstreamRequest(
  request: NextRequest,
): Promise<UpstreamRequest> {
  if (request.method === "GET" || !request.body) {
    return { body: undefined, replayBody: "" };
  }
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType === "application/json") {
    const text = await request.text();
    return { body: text.length > 0 ? text : undefined, replayBody: text };
  }
  // Stream everything else (duplex half) instead of buffering it in memory.
  return { body: request.body, replayBody: null };
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
  const route = normalizeUpstreamRoute(path);
  if (!route) {
    return new Response(
      JSON.stringify({ error: "Proxied route not allowed" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  const filePath = archiveFilePath(route);
  const pageId = archivePageId(route);
  const url = new URL(request.url);
  const gatewayUrl = `${API_BASE}${route}?${url.searchParams.toString()}`;

  const cookieStore = await request.cookies;
  const accessToken = cookieStore.get("pp_access")?.value;
  // Asset-token owner (fix E): the sub claim of the session used for the
  // upstream Bearer header — tokens are minted bound to (page_id, user_id).
  const userId = accessToken ? decodeJwtSubject(accessToken) : null;

  // Forward the caller's Content-Type (never hardcode application/json), the
  // media/conditional headers (Range/Accept/If-*), and the inbound client
  // IP chain (forwarded verbatim — see client-ip.ts).
  const headers: Record<string, string> = {
    ...forwardedClientIpHeadersFrom(request.headers),
  };
  const callerContentType = request.headers.get("content-type");
  if (callerContentType) {
    headers["Content-Type"] = callerContentType;
  }
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }
  for (const name of [
    "Range",
    "Accept",
    "If-None-Match",
    "If-Modified-Since",
  ]) {
    const value = request.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }

  const upstream = await prepareUpstreamRequest(request);

  let response = await fetch(gatewayUrl, {
    method: request.method,
    headers,
    cache: "no-store",
    ...(upstream.body !== undefined ? { body: upstream.body } : {}),
    ...(upstream.body instanceof ReadableStream
      ? { duplex: "half" as const }
      : {}),
  });

  if (response.status === 401) {
    const userId = accessToken
      ? (decodeJwtSubject(accessToken) ?? "anonymous")
      : "anonymous";
    let refreshPromise = refreshPromises.get(userId);

    if (!refreshPromise) {
      refreshPromise = refreshTokens(request);
      refreshPromises.set(userId, refreshPromise);
    }

    // The single-flight promise resolves to a plain outcome object, so every
    // waiter gets a definite answer and no shared Response body is consumed
    // twice.
    let outcome: RefreshOutcome;
    try {
      outcome = await refreshPromise;
    } finally {
      refreshPromises.delete(userId);
    }

    if (outcome.kind === "ok") {
      headers["Authorization"] = `Bearer ${outcome.accessToken}`;
      if (upstream.replayBody !== null) {
        // Retry the original request exactly once with the rotated token.
        response = await fetch(gatewayUrl, {
          method: request.method,
          headers,
          cache: "no-store",
          ...(upstream.replayBody.length > 0
            ? { body: upstream.replayBody }
            : {}),
        });
        const finalResponse = await proxyResponse(
          response,
          filePath,
          request.headers.get("origin"),
          pageId,
          userId,
        );
        setAuthCookiesOn(finalResponse, outcome);
        return finalResponse;
      }

      // Streamed (non-replayable) request body: rotate the cookies and hand
      // the caller a definite 503 so it can replay with the fresh token.
      const replayResponse = new Response(
        JSON.stringify({
          error: "Access token refreshed — replay the request",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
      setAuthCookiesOn(replayResponse, outcome);
      return replayResponse;
    }

    if (outcome.kind === "unauthorized") {
      // Refresh definitively failed — sign out.
      const signOutResponse = new Response(
        JSON.stringify({ error: "Session expired" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
      clearAuthCookies(responseCookieSetter(signOutResponse));
      return signOutResponse;
    }

    // Transient refresh failure — keep the session, answer with 503.
    return new Response(
      JSON.stringify({ error: "Session refresh unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  return await proxyResponse(
    response,
    filePath,
    request.headers.get("origin"),
    pageId,
    userId,
  );
}
