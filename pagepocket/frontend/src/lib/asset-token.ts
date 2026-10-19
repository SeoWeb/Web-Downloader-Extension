/**
 * Signed asset tokens — credential-less archived asset access (fix E,
 * archived-html-serving "Credential-less archived asset access").
 *
 * The sandboxed viewer iframe (opaque origin `null`) makes its CORS-mode
 * subresource loads (webfonts always; `crossorigin`-tagged css/js/img) without
 * cookies, so the authenticated BFF file route answered 401 and the browser
 * masked it as a CORS error. Fix E: this BFF mints an HMAC token bound to
 * (page_id, user_id, exp-bucket) and injects it into the served HTML via a
 * `<base>` element — `<base href="./at/{token}/">` right after `<head>` —
 * which the gateway's archive file route accepts as an alternative to the
 * session cookie (validated identically on both sides; see
 * services/api-gateway).
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
 * Stored archived HTML references its assets RELATIVELY (`./styles/x.css`,
 * `./images/x.svg`, inline `<style>url("./images/x.svg")</style>`) and has no
 * `<base>` tag, so the browser resolves every ref against the iframe document
 * URL `/api/pp/archive/pages/{id}/f/index.html`. Injecting
 * `<base href="./at/{token}/">` makes ALL of them — `./`, `../`, plain, and
 * inline CSS `url()` — resolve to `/f/at/{token}/…` in one single-element
 * insert; the gateway strips the `at/{token}` segment and serves the file.
 *
 * The token is a PATH segment (not a query param) because relative url() refs
 * inside CSS resolve against the document's base URL and inherit the token
 * automatically; only text/html documents get the base element — asset bytes
 * are never modified.
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
 * The archived asset f-route path prefix for THIS page. Stored HTML no longer
 * carries absolute asset URLs (refs are relative and covered by the injected
 * `<base>`), so the prefix is used only to recognize an EXISTING `<base
 * href>` that points at this page's f-route — the fail-safe rewrite path.
 * Host-agnostic: absolute (`https://app.pagepocket.app/api/pp/…`) and
 * root-relative (`/api/pp/…`) hrefs both contain this exact path prefix.
 */
export function assetFileUrlPrefix(pageId: string): string {
  return `/api/pp/archive/pages/${pageId}/f/`;
}

export interface InjectAssetTokenResult {
  html: string;
  /**
   * Whether the document was changed (a `<base>` was injected or an existing
   * f-route base href was retokenized). When false, `html` is byte-identical
   * to the input.
   */
  modified: boolean;
}

/** The first `<base>` tag, if any (case-insensitive, attribute-tolerant). */
const BASE_TAG_PATTERN = /<base\b[^>]*>/i;

/** The href attribute of a base tag: `href="…"`, `href='…'`, or `href=…`. */
const BASE_HREF_PATTERN = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Opening `<head>` / `<html>` tags (case-insensitive, attribute-tolerant). */
const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const HTML_OPEN_PATTERN = /<html\b[^>]*>/i;

/**
 * Inject this view's asset token into an archived HTML document:
 *
 * - No `<base>` tag (the stored-HTML reality): insert
 *   `<base href="./at/{token}/">` immediately after the opening `<head>`
 *   (case-insensitive), else right after `<html…>`, else prepend to the
 *   string. `./at/{token}/` resolves against the document URL
 *   `/api/pp/archive/pages/{id}/f/index.html` → `/f/at/{token}/`, so every
 *   relative ref (`./`, `../`, plain, inline CSS `url()`) inherits the token
 *   segment — no asset URL is rewritten.
 * - A `<base href>` that already exists: insert `at/{token}/` after its
 *   `/f/` boundary — but ONLY when the href points at THIS page's f-route
 *   (same host-agnostic path-prefix rule as the previous body-rewrite
 *   implementation). Anything else is left untouched, byte-identical — the
 *   feature fails safe and degrades to serving the document as-is.
 *
 * Idempotent: an href already carrying the token segment (or a bare
 * `./at/…` base from a previous injection) is never double-inserted — no
 * `at/at/`.
 */
export function injectAssetToken(
  html: string,
  pageId: string,
  token: string,
): InjectAssetTokenResult {
  const baseTag = BASE_TAG_PATTERN.exec(html);
  if (!baseTag) {
    return injectBaseTag(html, token);
  }
  return retokenExistingBaseHref(
    html,
    baseTag[0],
    baseTag.index,
    pageId,
    token,
  );
}

/** The base-element insert for documents without one. */
function injectBaseTag(html: string, token: string): InjectAssetTokenResult {
  const baseTag = `<base href="./at/${token}/">`;
  const anchor = HEAD_OPEN_PATTERN.exec(html) ?? HTML_OPEN_PATTERN.exec(html);
  if (anchor) {
    const insertAt = anchor.index + anchor[0].length;
    return {
      html: `${html.slice(0, insertAt)}${baseTag}${html.slice(insertAt)}`,
      modified: true,
    };
  }
  // Neither <head> nor <html> — prepend; the base URL applies document-wide.
  return { html: `${baseTag}${html}`, modified: true };
}

/** Retokenize an EXISTING base href when it points at this page's f-route. */
function retokenExistingBaseHref(
  html: string,
  baseTag: string,
  baseTagStart: number,
  pageId: string,
  token: string,
): InjectAssetTokenResult {
  const href = BASE_HREF_PATTERN.exec(baseTag);
  // A <base> without href establishes no base URL — nothing to rewrite.
  if (!href) {
    return { html, modified: false };
  }
  const value = href[1] ?? href[2] ?? href[3] ?? "";
  const prefix = assetFileUrlPrefix(pageId);
  const boundary = value.indexOf(prefix);
  if (boundary === -1) {
    // Not this page's f-route — leave the document untouched (fail-safe).
    return { html, modified: false };
  }
  const bodyStart = boundary + prefix.length;
  if (value.slice(bodyStart).startsWith("at/")) {
    // Already tokenized — never `at/at/`.
    return { html, modified: false };
  }
  const tokenized = `${value.slice(0, bodyStart)}at/${token}/${value.slice(bodyStart)}`;
  const quote = href[1] !== undefined ? '"' : href[2] !== undefined ? "'" : "";
  const newBaseTag = baseTag.replace(
    BASE_HREF_PATTERN,
    () => `href=${quote}${tokenized}${quote}`,
  );
  return {
    html:
      html.slice(0, baseTagStart) +
      newBaseTag +
      html.slice(baseTagStart + baseTag.length),
    modified: true,
  };
}
