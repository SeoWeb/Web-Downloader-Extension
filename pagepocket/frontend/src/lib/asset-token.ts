/**
 * Signed asset tokens — credential-less archived asset access (fix E,
 * archived-html-serving "Credential-less archived asset access").
 *
 * The sandboxed viewer iframe (opaque origin `null`) makes its CORS-mode
 * subresource loads (webfonts always; `crossorigin`-tagged css/js/img) without
 * cookies, so the authenticated BFF file route answered 401 and the browser
 * masked it as a CORS error. Fix E: this BFF mints an HMAC token bound to
 * (page_id, user_id, exp-bucket) and injects it into the served HTML's asset
 * URLs as a PATH segment — `/f/X` becomes `/f/at/{token}/X` — which the
 * gateway's archive file route accepts as an alternative to the session
 * cookie (validated identically on both sides; see services/api-gateway).
 *
 * Wire contract (do not deviate — the gateway validates the same format):
 * - token string: `payload_b64url + "." + mac_b64url`
 * - payload: compact JSON `{"p": page_id, "u": user_id, "e": exp_epoch}`
 * - encoding: base64url, no padding
 * - mac: HMAC-SHA256(key = ASSET_TOKEN_SECRET, message = payload_b64url)
 * - expiry bucketing: `e = (floor(now/TTL) + 2) * TTL` — deterministic within
 *   the current TTL bucket (browser-cached asset URLs keep working for the
 *   rest of the bucket AND the next one, so image caches stay warm).
 *
 * The token is a PATH segment (not a query param) because relative url() refs
 * inside CSS resolve against the rewritten URL and inherit the token
 * automatically; only text/html bodies are rewritten — asset bytes are never
 * modified.
 *
 * Pure and injectable (`nowMs`) so the mint is deterministic and unit-testable
 * without timers; the route resolves the secret/TTL per request via
 * `assetTokenConfig()` (src/lib/env.ts).
 */

export interface MintAssetTokenInput {
  secret: string;
  pageId: string;
  userId: string;
  /** Token lifetime bucket in seconds (ASSET_TOKEN_TTL_SECONDS). */
  ttlSeconds: number;
  /**
   * Injectable clock (epoch milliseconds). Defaults to Date.now(); tests pass
   * a fixed value so bucketing is deterministic.
   */
  nowMs?: number;
}

/**
 * End-of-next-bucket expiry: a token minted anywhere inside the current
 * bucket carries the SAME `e`, so URLs are stable for browser caches, and
 * stay valid through the end of the NEXT bucket.
 */
export function assetTokenExpiryEpoch(
  ttlSeconds: number,
  nowMs: number,
): number {
  return (Math.floor(nowMs / 1000 / ttlSeconds) + 2) * ttlSeconds;
}

/** base64url (RFC 4648 §5) without padding. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint `payload_b64url.mac_b64url` per the wire contract above. */
export async function mintAssetToken({
  secret,
  pageId,
  userId,
  ttlSeconds,
  nowMs = Date.now(),
}: MintAssetTokenInput): Promise<string> {
  const payload = JSON.stringify({
    p: pageId,
    u: userId,
    e: assetTokenExpiryEpoch(ttlSeconds, nowMs),
  });
  const payloadB64Url = base64UrlEncode(new TextEncoder().encode(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64Url),
  );
  return `${payloadB64Url}.${base64UrlEncode(new Uint8Array(mac))}`;
}

/**
 * The archived asset URL prefix as it appears in stored HTML — both absolute
 * (`https://app.pagepocket.app/api/pp/archive/pages/{id}/f/…`) and
 * root-relative forms contain this exact path prefix, so matching on the path
 * (never the host) covers both.
 */
export function assetFileUrlPrefix(pageId: string): string {
  return `/api/pp/archive/pages/${pageId}/f/`;
}

/** Escape a literal string for embedded use in a RegExp. */
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

export interface InjectAssetTokenResult {
  html: string;
  /** Number of URLs rewritten (0 → html is byte-identical to the input). */
  replaced: number;
}

/**
 * Rewrite THIS page's archived-file URLs to carry the token as a path
 * segment: `…/pages/{page_id}/f/X` → `…/pages/{page_id}/f/at/{token}/X`.
 *
 * - Host-agnostic: matches the path prefix, so absolute app URLs and
 *   root-relative URLs are both rewritten.
 * - Idempotent: URLs that already contain `/f/at/` are skipped (the negative
 *   lookahead) — never `/f/at/at/`.
 * - Scoped: only THIS page's `f`-URLs match (the page id is part of the
 *   prefix); other pages' links and `/api/sc/…` share URLs never match.
 */
export function injectAssetToken(
  html: string,
  pageId: string,
  token: string,
): InjectAssetTokenResult {
  const prefix = assetFileUrlPrefix(pageId);
  const pattern = new RegExp(
    `${prefix.replace(REGEX_ESCAPE, "\\$&")}(?!at/)`,
    "g",
  );
  let replaced = 0;
  const rewritten = html.replace(pattern, () => {
    replaced += 1;
    return `${prefix}at/${token}/`;
  });
  return { html: rewritten, replaced };
}
