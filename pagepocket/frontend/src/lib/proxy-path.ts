/**
 * Path-segment validation shared by the two gateway proxies
 * (`/api/pp/[...path]` and `/api/sc/[token]/[...]`) — archived-file-proxy
 * "Route Allow-List and Traversal Rejection".
 *
 * Next.js catch-all params arrive URL-decoded, so a request to
 * `/api/pp/api/v1/archive/%2e%2e/%2e%2e/docs` reaches the handler with the
 * literal segment `..`. We additionally decode one more level (the gateway's
 * ASGI server would) and reject anything that then yields a dot-segment,
 * separator, or control character — a segment is only proxied when it is
 * safe in both decodings.
 */
export function isSafeSegment(segment: string): boolean {
  if (segment === "." || segment === "..") return false;
  if (/[/\\\0-\x1f]/.test(segment)) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — never proxy it upstream.
    return false;
  }
  if (decoded !== segment) {
    if (decoded === "." || decoded === "..") return false;
    if (/[/\\\0-\x1f]/.test(decoded)) return false;
  }
  return true;
}
