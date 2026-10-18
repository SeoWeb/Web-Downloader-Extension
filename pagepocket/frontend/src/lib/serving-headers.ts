/**
 * Shared response headers for routes serving archived content.
 *
 * Mirrors `pagepocket/services/api-gateway/serving.py` so the frontend proxy
 * routes (the `/api/sc/[token]/[...path]` share route and the authenticated
 * archive file proxy under `/api/pp/archive`) emit the exact
 * same sandboxing header set as the gateway file routes — even if the gateway
 * response is missing them (the proxy must never serve archived content
 * without the sandbox):
 *
 * - ``Content-Security-Policy: sandbox allow-popups allow-forms`` — deliberately
 *   WITHOUT ``allow-same-origin``, so archived documents get no origin
 *   privilege on pagepocket.app.
 * - ``X-Content-Type-Options: nosniff`` — prevents MIME confusion.
 * - A pinned ``Content-Type`` (HTML pinned to utf-8).
 * - ``Referrer-Policy: no-referrer`` on HTML responses.
 */

export const SANDBOX_CSP = "sandbox allow-popups allow-forms";

// Extension → content-type map for path-based pinning when the gateway does
// not provide a content type (same table as serving.py).
const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** Pin a content type from the archive-relative path's extension. */
export function contentTypeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** Normalize a stored/served content type; HTML is pinned to utf-8. */
export function pinContentType(contentType: string): string {
  const trimmed = (contentType || "").trim() || DEFAULT_CONTENT_TYPE;
  const mime = trimmed.split(";", 1)[0]!.trim().toLowerCase();
  if (mime === "text/html" && !trimmed.toLowerCase().includes("charset=")) {
    return "text/html; charset=utf-8";
  }
  return trimmed;
}

/**
 * Mandatory headers for any response serving archived HTML or assets.
 * The returned record includes the pinned Content-Type; spread it into the
 * response headers so the client never sees a sniffed type.
 */
export function sandboxHeaders(contentType: string): Record<string, string> {
  const pinned = pinContentType(contentType);
  const headers: Record<string, string> = {
    "Content-Security-Policy": SANDBOX_CSP,
    "X-Content-Type-Options": "nosniff",
    "Content-Type": pinned,
  };
  if (pinned.split(";", 1)[0]!.trim().toLowerCase() === "text/html") {
    headers["Referrer-Policy"] = "no-referrer";
  }
  return headers;
}

/**
 * CORS answer for the sandboxed viewer iframes (archived-html-serving): the
 * sandbox drops `allow-same-origin`, so archived documents run on an opaque
 * origin (the literal string `null`) and every subresource request they make
 * is CORS-mode. The proxies serving that iframe its archived bytes echo the
 * request `Origin` verbatim — including `null`, which the gateway's
 * allow-list can never contain — plus credentials (the `/api/pp` route
 * authenticates via cookies) and `Vary: Origin` (shared caches must never
 * reuse one origin's CORS answer for another).
 *
 * Applied to FILE responses of the two archived-file proxies ONLY; requests
 * without an `Origin` gain no ACAO headers at all (fail closed).
 */
export function corsEchoHeaders(origin: string | null): Record<string, string> {
  if (!origin) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
