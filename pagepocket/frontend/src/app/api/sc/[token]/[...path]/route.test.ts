import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

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

function gatewayResponse(body: string, headers: Record<string, string>) {
  return new Response(body, { status: 200, headers });
}

function callGet(path: string[]) {
  const request = new Request(`http://localhost:3000/api/sc/tok/${path.join("/")}`);
  return GET(request as never, { params: Promise.resolve({ token: "tok", path }) });
}

describe("GET /api/sc/[token]/[...path] — archived-html-serving headers", () => {
  it("HTML path: sandbox CSP, nosniff, pinned utf-8 type, no-referrer", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", { "Content-Type": "text/html; charset=utf-8" }),
    );

    const res = await callGet(["index.html"]);

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

  it("non-HTML path: sandbox CSP + nosniff, stored content type, no referrer-policy", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("body{}", { "Content-Type": "text/css" }),
    );

    const res = await callGet(["assets", "style.css"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/css");
    expect(res.headers.get("referrer-policy")).toBeNull();
  });

  it("pins the content type from the path when the gateway sends none", async () => {
    const response = gatewayResponse("<p>hi</p>", {});
    response.headers.delete("content-type"); // undici would default it
    fetchMock.mockResolvedValue(response);

    const res = await callGet(["index.html"]);

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
  });

  it("HTML without charset from the gateway is pinned to utf-8", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", { "Content-Type": "text/html" }),
    );

    const res = await callGet(["index.html"]);

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});
