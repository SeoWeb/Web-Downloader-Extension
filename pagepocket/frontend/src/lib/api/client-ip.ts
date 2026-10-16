import "server-only";

/**
 * Client-IP forwarding (client-identity-propagation / design D3).
 *
 * nginx builds the X-Forwarded-For chain with `$proxy_add_x_forwarded_for`:
 * the FIRST entry is the real client and later entries are appended upstream
 * hops. This server sits behind nginx, so the correct behavior is to forward
 * the inbound `X-Forwarded-For` value VERBATIM as the outbound value on every
 * server→gateway fetch — nothing is parsed, trusted, or appended here. The
 * gateway then walks the chain right-to-left against its TRUSTED_PROXIES
 * (the spoof-proof derivation lives in the gateway's rate-limit middleware,
 * not here).
 *
 * Server-side only: the value is read from the inbound request headers
 * (route handlers / server components) — never derived from client-rendered
 * code.
 */
export function forwardedClientIpHeadersFrom(
  inboundHeaders: Headers,
): Record<string, string> {
  const forwardedFor = inboundHeaders.get("x-forwarded-for");
  return forwardedFor ? { "X-Forwarded-For": forwardedFor } : {};
}
