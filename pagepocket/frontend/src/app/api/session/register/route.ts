import { NextRequest, NextResponse } from "next/server";
import { setAuthCookies } from "@/lib/auth/cookies";
import { API_GATEWAY_URL } from "@/lib/env";

const API_BASE = API_GATEWAY_URL;

export async function POST(request: NextRequest) {
  const body = await request.json();

  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  const data = await res.json();
  const response = NextResponse.json({ ok: true });

  setAuthCookies(response.cookies, {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  });

  return response;
}
