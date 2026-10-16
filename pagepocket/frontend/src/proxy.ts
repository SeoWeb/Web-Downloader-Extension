import { NextRequest, NextResponse } from "next/server";

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return true;
    return false;
  } catch {
    return true;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const accessCookie = request.cookies.get("pp_access");
  const hasRefresh = Boolean(request.cookies.get("pp_refresh")?.value);

  const accessMissingOrExpired =
    !accessCookie?.value || isTokenExpired(accessCookie.value);

  // A present refresh token is pass-worthy (design D10): the /api/pp refresh
  // primitive rotates the access token on the first API call. Hard-redirecting
  // here would sign out users with a valid 30-day refresh token and turn RSC
  // deep-links into 404s.
  if (accessMissingOrExpired && !hasRefresh) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*"],
};
