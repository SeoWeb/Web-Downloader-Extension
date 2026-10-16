import { NextRequest, NextResponse } from "next/server";
import { API_GATEWAY_URL } from "@/lib/env";
import { contentTypeForPath, sandboxHeaders } from "@/lib/serving-headers";
import { isSafeSegment } from "@/lib/proxy-path";

const API_BASE = API_GATEWAY_URL;

// Share tokens are URL-safe random strings (secrets.token_urlsafe alphabet) —
// anything else is rejected before an upstream request is composed
// (archived-file-proxy "Route Allow-List and Traversal Rejection").
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

export async function GET(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ token: string; path: string[] }> },
) {
  const { token, path } = await params;

  if (!TOKEN_PATTERN.test(token)) {
    return new NextResponse("Invalid token", { status: 400 });
  }
  // Path segments under the token are validated exactly like /api/pp's
  // (dot-segments, separators, and encoded variants are rejected with 400).
  if (!path.every(isSafeSegment)) {
    return new NextResponse("Invalid path", { status: 400 });
  }

  const filePath = path.join("/");
  const gatewayUrl = `${API_BASE}/share/public/${token}/f/${filePath}`;

  try {
    const response = await fetch(gatewayUrl, { cache: "no-store" });

    if (!response.ok) {
      // 204/304 are null-body statuses — never attach a text body to them.
      if (response.status === 204 || response.status === 304) {
        return new NextResponse(null, { status: response.status });
      }
      return new NextResponse(
        response.status === 404 ? "Not found" : "Error fetching file",
        { status: response.status },
      );
    }

    // Sandboxed serving headers (archived-html-serving): mirror the gateway's
    // serving.py set — CSP sandbox without allow-same-origin, nosniff, pinned
    // content type, no-referrer on HTML. Overlaid on a copy of the upstream
    // headers so the proxy never serves archived content without them, even
    // if the gateway response is missing headers.
    const headers = new Headers(response.headers);
    const sandbox = sandboxHeaders(
      response.headers.get("content-type") ?? contentTypeForPath(filePath),
    );
    for (const [name, value] of Object.entries(sandbox)) {
      headers.set(name, value);
    }
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "public, max-age=3600");
    }

    // Stream the bytes through — never materialize a 256 MB archive via
    // arrayBuffer() in route-handler memory.
    return new NextResponse(response.body, {
      status: response.status,
      headers,
    });
  } catch {
    return new NextResponse("Internal error", { status: 500 });
  }
}
