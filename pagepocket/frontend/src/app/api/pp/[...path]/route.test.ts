import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { NextRequest } from "next/server";

// env.ts parses process.env at import time — seed before importing the route.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";

const { GET, POST, DELETE } = await import("./route");

const API_BASE = "http://localhost:8090/api/v1";
const fetchMock = vi.fn();

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
});

function base64url(payload: object): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeAccessToken(sub: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  return `${base64url({ alg: "none" })}.${base64url({ sub, exp })}.sig`;
}

function callGet(path: string[], cookie?: string) {
  const request = new NextRequest(
    `http://localhost:3000/api/pp/${path.join("/")}`,
    { ...(cookie ? { headers: { cookie } } : {}) },
  );
  return GET(request, { params: Promise.resolve({ path }) });
}

function callApi(
  method: string,
  path: string[],
  init?: { body?: string; contentType?: string; cookie?: string; headers?: Record<string, string> },
) {
  const headers: Record<string, string> = { ...init?.headers };
  if (init?.contentType) headers["content-type"] = init.contentType;
  if (init?.cookie) headers["cookie"] = init.cookie;
  const request = new NextRequest(`http://localhost:3000/api/pp/${path.join("/")}`, {
    method,
    headers,
    ...(init?.body !== undefined ? { body: init.body } : {}),
  });
  const handler = method === "POST" ? POST : method === "DELETE" ? DELETE : GET;
  return handler(request, { params: Promise.resolve({ path }) });
}

function gatewayResponse(body: string, headers: Record<string, string>) {
  return new Response(body, { status: 200, headers });
}

function streamResponse(body: string, headers: Record<string, string>) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
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

describe("private caching of cookie-authenticated files", () => {
  it("downgrades public/immutable to private, preserving max-age", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png", {
        "Content-Type": "image/png",
        "Cache-Control": "public, immutable, max-age=31536000",
      }),
    );

    const res = await callGet(["archive", "page-1", "f", "assets", "logo.png"]);

    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000");
  });

  it("never leaves public or immutable on a file response (already-private kept)", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png", {
        "Content-Type": "image/png",
        "Cache-Control": "immutable, max-age=60",
      }),
    );

    const res = await callGet(["archive", "page-1", "f", "assets", "logo.png"]);

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("private");
    expect(cc).not.toContain("public");
    expect(cc).not.toContain("immutable");
    expect(cc).toContain("max-age=60");
  });

  it("sets private when the gateway sends no cache-control on a file", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", { "Content-Type": "text/html; charset=utf-8" }),
    );

    const res = await callGet(["archive", "page-1", "f", "index.html"]);

    expect(res.headers.get("cache-control")).toBe("private");
  });

  it("non-file JSON responses keep their upstream cache-control unchanged", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("[]", { "Content-Type": "application/json" }),
    );

    const res = await callGet(["library", "collections"]);

    expect(res.headers.get("cache-control")).toBeNull();
  });
});

describe("route allow-list and traversal rejection", () => {
  it("rejects decoded dot-dot escapes with 400 and never proxies", async () => {
    const res = await callGet(["api", "v1", "archive", "..", "..", "docs"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects encoded dot-segment variants with 400", async () => {
    for (const escape of ["%2e%2e", "%2E%2E", "%2e%2f"]) {
      fetchMock.mockClear();
      const res = await callGet(["api", "v1", "archive", escape, escape, "docs"]);
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects segments that decode into separators (encoded slashes)", async () => {
    const res = await callGet(["archive", "pages%2F..%2F..%2Fdocs", "f", "x.html"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects composed paths outside the allowed route families (docs, openapi.json)", async () => {
    for (const path of [["docs"], ["openapi.json"], ["health"], ["v1", "auth", "login"]]) {
      fetchMock.mockClear();
      const res = await callGet(path);
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("forwards legitimate routes to the same normalized gateway path", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", { "Content-Type": "text/html; charset=utf-8" }),
    );

    const res = await callGet(["archive", "pages", "abc", "f", "index.html"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(`${API_BASE}/archive/pages/abc/f/index.html?`);
  });
});

describe("conditional and media header passthrough", () => {
  it("forwards Range/Accept/If-None-Match/If-Modified-Since upstream", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("chunk", {
        "Content-Type": "application/octet-stream",
        "Content-Range": "bytes 1000-1999/5000",
      }),
    );

    const request = new NextRequest(
      "http://localhost:3000/api/pp/archive/page-1/f/video.mp4",
      {
        headers: {
          range: "bytes=1000-1999",
          accept: "*/*",
          "if-none-match": '"etag-1"',
          "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
        },
      },
    );
    await GET(request, {
      params: Promise.resolve({ path: ["archive", "page-1", "f", "video.mp4"] }),
    });

    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
    const upstreamHeaders = init!.headers! as Record<string, string>;
    expect(upstreamHeaders["Range"]).toBe("bytes=1000-1999");
    expect(upstreamHeaders["Accept"]).toBe("*/*");
    expect(upstreamHeaders["If-None-Match"]).toBe('"etag-1"');
    expect(upstreamHeaders["If-Modified-Since"]).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  it("forwards the caller Content-Type instead of hardcoding application/json", async () => {
    fetchMock.mockResolvedValue(gatewayResponse("ok", { "Content-Type": "text/plain" }));

    await callApi("POST", ["library", "collections"], {
      body: "a,b,c",
      contentType: "text/csv",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const upstreamHeaders = init!.headers! as Record<string, string>;
    expect(upstreamHeaders["Content-Type"]).toBe("text/csv");
  });

  it("passes a 206 partial-content response through untouched", async () => {
    fetchMock.mockResolvedValue(
      new Response("chunk", {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-4/100" },
      }),
    );

    const res = await callGet(["archive", "page-1", "f", "video.mp4"]);

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/100");
  });
});

describe("streaming body handling", () => {
  it("streams upstream response bodies without buffering", async () => {
    fetchMock.mockResolvedValue(
      streamResponse("streamed-bytes", { "Content-Type": "application/octet-stream" }),
    );

    const res = await callGet(["archive", "page-1", "f", "big.zip"]);

    expect(await res.text()).toBe("streamed-bytes");
  });

  it("forwards DELETE request bodies to the gateway", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse('{"success":true}', { "Content-Type": "application/json" }),
    );

    const res = await callApi("DELETE", ["library", "collections", "x"], {
      body: JSON.stringify({ purge: true }),
      contentType: "application/json",
    });

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toBe(JSON.stringify({ purge: true }));
    expect((init!.method as string)).toBe("DELETE");
  });

  it("streams non-JSON request bodies through (not buffered text)", async () => {
    fetchMock.mockResolvedValue(gatewayResponse("ok", { "Content-Type": "text/plain" }));

    await callApi("POST", ["library", "collections"], {
      body: "raw-upload-bytes",
      contentType: "application/octet-stream",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.body).toBeInstanceOf(ReadableStream);
  });
});

describe("refresh hardening", () => {
  const cookie = (sub: string) =>
    `pp_access=${makeAccessToken(sub)}; pp_refresh=r-old`;

  function jsonResponse(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("returns 503 (not a raw 500) when the refresh call throws", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ detail: "expired" }, 401);
    });

    const res = await callGet(["library", "collections"], cookie("user-1"));

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("returns 503 when the refresh response is not JSON", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        return new Response("<html>gateway error</html>", { status: 200 });
      }
      return jsonResponse({ detail: "expired" }, 401);
    });

    const res = await callGet(["library", "collections"], cookie("user-2"));

    expect(res.status).toBe(503);
  });

  it("signs out (401 + cleared cookies) when refresh is 401", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        return jsonResponse({ detail: "invalid" }, 401);
      }
      return jsonResponse({ detail: "expired" }, 401);
    });

    const res = await callGet(["library", "collections"], cookie("user-3"));

    expect(res.status).toBe(401);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("pp_access=;");
    expect(cookies).toContain("pp_refresh=;");
  });

  it("keeps the session (503) when refresh fails with a gateway 5xx", async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        return jsonResponse({ detail: "unavailable" }, 503);
      }
      return jsonResponse({ detail: "expired" }, 401);
    });

    const res = await callGet(["library", "collections"], cookie("user-4"));

    expect(res.status).toBe(503);
  });

  it("retries the original request once and rotates cookies when refresh succeeds", async () => {
    const newAccess = makeAccessToken("user-5");
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        return jsonResponse(
          { access_token: newAccess, refresh_token: "r-new" },
          200,
        );
      }
      if (fetchMock.mock.calls.length <= 1) {
        return jsonResponse({ detail: "expired" }, 401);
      }
      return gatewayResponse("[]", { "Content-Type": "application/json" });
    });

    const res = await callGet(["library", "collections"], cookie("user-5"));

    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("pp_access=");
    expect(cookies).toContain("pp_refresh=r-new");
  });

  it("never writes an empty pp_refresh cookie when no refresh token is rotated", async () => {
    const newAccess = makeAccessToken("user-6");
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        return jsonResponse({ access_token: newAccess }, 200);
      }
      if (fetchMock.mock.calls.length <= 1) {
        return jsonResponse({ detail: "expired" }, 401);
      }
      return gatewayResponse("[]", { "Content-Type": "application/json" });
    });

    const res = await callGet(["library", "collections"], cookie("user-6"));

    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toContain("pp_access=");
    expect(cookies).not.toContain("pp_refresh=");
    expect(cookies).not.toContain("pp_refresh=;");
  });

  it("collapses concurrent 401s into exactly one refresh call", async () => {
    const newAccess = makeAccessToken("user-7");
    let initialCalls = 0;
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/auth/refresh")) {
        refreshCalls++;
        return jsonResponse(
          { access_token: newAccess, refresh_token: "r-new" },
          200,
        );
      }
      initialCalls++;
      if (initialCalls <= 2) {
        return jsonResponse({ detail: "expired" }, 401);
      }
      return gatewayResponse("[]", { "Content-Type": "application/json" });
    });

    const [a, b] = await Promise.all([
      callGet(["library", "collections"], cookie("user-7")),
      callGet(["search", "x"], cookie("user-7")),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refreshCalls).toBe(1);
  });

  it("forwards the inbound X-Forwarded-For verbatim to the gateway", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("[]", { "Content-Type": "application/json" }),
    );

    const request = new NextRequest("http://localhost:3000/api/pp/library/collections", {
      headers: {
        "x-forwarded-for": "203.0.113.7, 10.0.0.2",
      },
    });
    await GET(request, { params: Promise.resolve({ path: ["library", "collections"] }) });

    const [, init] = fetchMock.mock.calls[0]!;
    const upstreamHeaders = init!.headers! as Record<string, string>;
    expect(upstreamHeaders["X-Forwarded-For"]).toBe("203.0.113.7, 10.0.0.2");
  });
});
