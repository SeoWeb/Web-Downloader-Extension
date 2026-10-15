import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { NextRequest } from "next/server";

// env.ts parses process.env at import time — seed before importing the route.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";

const { GET } = await import("./route");

const fetchMock = vi.fn();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
});

function callGet(path: string[]) {
  const request = new NextRequest(`http://localhost:3000/api/pp/${path.join("/")}`);
  return GET(request, { params: Promise.resolve({ path }) });
}

function gatewayResponse(body: string, headers: Record<string, string>) {
  return new Response(body, { status: 200, headers });
}

describe("GET /api/pp/archive/*/f/* — archived-html-serving headers", () => {
  it("HTML file: sandbox CSP, nosniff, pinned utf-8 type, no-referrer", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", { "Content-Type": "text/html; charset=utf-8" }),
    );

    const res = await callGet(["archive", "page-1", "f", "index.html"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
    expect(res.headers.get("content-security-policy")).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("<p>hi</p>");
  });

  it("non-HTML asset: sandbox CSP + nosniff, stored content type, no referrer-policy", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png-bytes", { "Content-Type": "image/png" }),
    );

    const res = await callGet(["archive", "page-1", "f", "assets", "logo.png"]);

    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("referrer-policy")).toBeNull();
  });

  it("pins the content type from the file path when the gateway sends none", async () => {
    const response = gatewayResponse("<p>hi</p>", {});
    response.headers.delete("content-type"); // undici would default it
    fetchMock.mockResolvedValue(response);

    const res = await callGet(["archive", "page-1", "f", "index.html"]);

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
  });

  it("non-file API routes are proxied without the sandbox header set", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("[]", { "Content-Type": "application/json" }),
    );

    const res = await callGet(["library", "collections"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
