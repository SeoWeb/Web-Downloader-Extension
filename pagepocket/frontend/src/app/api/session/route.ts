import { NextRequest, NextResponse } from "next/server";
import {
  setAuthCookies,
  clearAuthCookies,
} from "@/lib/auth/cookies";
import { API_GATEWAY_URL } from "@/lib/env";

const API_BASE = API_GATEWAY_URL;

export async function POST(request: NextRequest) {
  const body = await request.json();

  const res = await fetch(`${API_BASE}/auth/login`, {
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
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  });

  return response;
}

export async function GET(request: NextRequest) {
  // Lightweight auth probe for statically rendered pages. Only decodes the
  // cookie — the gateway remains the authoritative token verifier.
  const accessToken = (await request.cookies).get("pp_access")?.value;
  let authenticated = false;

  if (accessToken) {
    try {
      const payloadPart = accessToken.split(".")[1];
      if (payloadPart) {
        const payload = JSON.parse(
          atob(payloadPart.replace(/-/g, "+").replace(/_/g, "/")),
        ) as { sub?: string };
        authenticated = Boolean(payload.sub);
      }
    } catch {
      authenticated = false;
    }
  }

  return NextResponse.json({ authenticated });
}

export async function DELETE(request: NextRequest) {
  const accessToken = (await request.cookies).get("pp_access")?.value;

  if (accessToken) {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => {});
  }

  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response.cookies);
  return response;
}
