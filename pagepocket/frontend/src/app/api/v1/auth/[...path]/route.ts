import { NextRequest, NextResponse } from "next/server";
import { API_GATEWAY_URL } from "@/lib/env";

/**
 * Proxy route for extension auth requests.
 *
 * The Chrome extension calls /api/v1/auth/{login,register,refresh,logout}
 * directly. This catch-all proxies those requests to the API gateway and
 * returns the raw JSON response (including JWT tokens in the body) so the
 * extension can store them in chrome.storage.local.
 *
 * This is intentionally separate from the /api/session/* routes which wrap
 * tokens in HttpOnly cookies for the web frontpage.
 */

const API_BASE = API_GATEWAY_URL;

// Only allow known auth sub-paths
const ALLOWED_PATHS = new Set(["login", "register", "refresh", "logout"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const subPath = path.join("/");

  // Reject unknown paths
  if (!ALLOWED_PATHS.has(subPath)) {
    return NextResponse.json(
      { detail: "Unknown auth endpoint" },
      { status: 404 },
    );
  }

  const gatewayUrl = `${API_BASE}/auth/${subPath}`;

  // Build headers — forward Authorization if present (needed for logout)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    headers["Authorization"] = authHeader;
  }

  // Forward request body
  const body = await request.text();

  const gatewayResponse = await fetch(gatewayUrl, {
    method: "POST",
    cache: "no-store",
    headers,
    ...(body ? { body } : {}),
  });

  // Return the raw gateway response — tokens stay in the JSON body
  const responseBody = await gatewayResponse.text();
  return new NextResponse(responseBody, {
    status: gatewayResponse.status,
    headers: { "Content-Type": "application/json" },
  });
}
