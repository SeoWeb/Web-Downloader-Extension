import { NextRequest, NextResponse } from "next/server";
import {
  setAuthCookies,
  clearAuthCookies,
} from "@/lib/auth/cookies";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080/api/v1";

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
