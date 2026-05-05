import "server-only";
import type { cookies } from "next/headers";

// Only decode — the gateway is the authoritative token verifier.
// Expiry is not checked here because the API proxy (/api/pp/...) transparently
// refreshes expired access tokens, so a server component may see an expired
// cookie that will be refreshed on the next API call.

type JwtPayload = {
  sub?: string;
};

function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1]!;
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded) as JwtPayload;
  } catch {
    return null;
  }
}

export async function getCurrentUserId(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<string | null> {
  const accessCookie = cookieStore.get("pp_access");
  if (!accessCookie?.value) return null;

  const payload = decodeJwtPayload(accessCookie.value);
  if (!payload?.sub) return null;

  return payload.sub;
}
