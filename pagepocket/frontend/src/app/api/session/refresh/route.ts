import { NextRequest, NextResponse } from "next/server";
import {
  setAuthCookies,
  clearAuthCookies,
} from "@/lib/auth/cookies";
import { API_GATEWAY_URL } from "@/lib/env";

const API_BASE = API_GATEWAY_URL;

export async function POST(request: NextRequest) {
  const refreshToken = (await request.cookies).get("pp_refresh")?.value;

  if (!refreshToken) {
    const response = NextResponse.json(
      { error: "No refresh token" },
      { status: 401 },
    );
    clearAuthCookies(response.cookies);
    return response;
  }

  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const response = NextResponse.json(
      { error: "Refresh failed" },
      { status: 401 },
    );
    clearAuthCookies(response.cookies);
    return response;
  }

  const data = await res.json();
  const response = NextResponse.json(data);

  setAuthCookies(response.cookies, {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  });

  return response;
}
