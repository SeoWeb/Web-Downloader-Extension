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

  if (!accessCookie?.value || isTokenExpired(accessCookie.value)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*"],
};
