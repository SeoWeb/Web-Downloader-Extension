import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";

// env.ts parses process.env at import time — seed before importing the route.
process.env.NEXT_PUBLIC_API_BASE_URL ||= "http://localhost:8090/api/v1";
process.env.NEXT_PUBLIC_MARKETING_SITE_URL ||= "http://localhost:3000";
process.env.COOKIE_SECRET ||= "test-cookie-secret";

const { GET } = await import("./route");

const API_BASE = "http://localhost:8090/api/v1";
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

function streamResponse(body: string, headers: Record<string, string>) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

function callGet(
  token: string,
  path: string[],
  headers?: Record<string, string>,
) {
  const request = new Request(
    `http://localhost:3000/api/sc/${token}/${path.join("/")}`,
    {
      ...(headers ? { headers } : {}),
    },
  );
  return GET(request as never, { params: Promise.resolve({ token, path }) });
}

describe("GET /api/sc/[token]/[...path] — archived-html-serving headers", () => {
  it("HTML path: sandbox CSP, nosniff, pinned utf-8 type, no-referrer", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", {
        "Content-Type": "text/html; charset=utf-8",
      }),
    );

    const res = await callGet("tok", ["index.html"]);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
    expect(res.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res.text()).toBe("<p>hi</p>");
  });

  it("non-HTML path: sandbox CSP + nosniff, stored content type, no referrer-policy", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("body{}", { "Content-Type": "text/css" }),
    );

    const res = await callGet("tok", ["assets", "style.css"]);

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

    const res = await callGet("tok", ["index.html"]);

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

    const res = await callGet("tok", ["index.html"]);

    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("opaque-origin viewer CORS (Origin echo on served files)", () => {
  it("file response with Origin: null echoes ACAO null + credentials + Vary", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>hi</p>", {
        "Content-Type": "text/html; charset=utf-8",
      }),
    );

    const res = await callGet("tok", ["index.html"], { origin: "null" });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("file response with a real Origin echoes it verbatim", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("css-bytes", { "Content-Type": "text/css" }),
    );

    const res = await callGet("tok", ["assets", "style.css"], {
      origin: "https://app.pagepocket.app",
    });

    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.pagepocket.app",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("file response without Origin gains no CORS headers at all", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png-bytes", { "Content-Type": "image/png" }),
    );

    const res = await callGet("tok", ["logo.png"]);

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("error responses (404) gain no ACAO even with an Origin", async () => {
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    const res = await callGet("tok", ["missing.html"], {
      origin: "https://evil.example",
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });
});

describe("token and path-segment validation", () => {
  it("rejects unsafe token segments with 400 and never proxies", async () => {
    for (const token of [
      "../evil",
      "tok;drop",
      "tok/../x",
      "tok%00",
      "tok rank",
    ]) {
      fetchMock.mockClear();
      const res = await callGet(token, ["index.html"]);
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects dot-segment traversal in the file path with 400", async () => {
    const res = await callGet("tok", ["..", "..", "docs"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects encoded dot-segment variants in the file path with 400", async () => {
    const res = await callGet("tok", ["%2e%2e", "%2e%2e", "openapi.json"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects segments that decode into separators with 400", async () => {
    const res = await callGet("tok", ["a%2F..%2F..%2Fb.html"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("streaming body handling", () => {
  it("streams the upstream body instead of buffering via arrayBuffer()", async () => {
    fetchMock.mockResolvedValue(
      streamResponse("archive-zip-bytes", {
        "Content-Type": "application/zip",
      }),
    );

    const res = await callGet("tok", ["exports", "archive.zip"]);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("archive-zip-bytes");
  });

  it("keeps the upstream cache-control (public share assets stay cacheable)", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png", {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=7200",
      }),
    );

    const res = await callGet("tok", ["logo.png"]);

    expect(res.headers.get("cache-control")).toBe("public, max-age=7200");
  });

  it("defaults cache-control when the gateway sends none", async () => {
    const response = gatewayResponse("png", { "Content-Type": "image/png" });
    response.headers.delete("cache-control");
    fetchMock.mockResolvedValue(response);

    const res = await callGet("tok", ["logo.png"]);

    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("passes 404 through with its status", async () => {
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    const res = await callGet("tok", ["missing.html"]);

    expect(res.status).toBe(404);
  });

  it("composes the gateway URL from the validated token and path", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("<p>x</p>", {
        "Content-Type": "text/html; charset=utf-8",
      }),
    );

    await callGet("abc123_-", ["assets", "style.css"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      `${API_BASE}/share/public/abc123_-/f/assets/style.css`,
    );
  });
});

describe("GET /api/sc/[token]/images — share gallery listing", () => {
  it("forwards /images without the /f/ infix and streams the JSON through", async () => {
    const body = '{"images":[],"is_image_gallery":true,"total":0}';
    fetchMock.mockResolvedValue(
      gatewayResponse(body, { "Content-Type": "application/json" }),
    );

    const res = await callGet("tok", ["images"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(`${API_BASE}/share/public/tok/images`);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.text()).toBe(body);
  });

  it("applies no sandbox/CORS overlay (first-party JSON, never iframe-served)", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("{}", { "Content-Type": "application/json" }),
    );

    const res = await callGet("tok", ["images"], {
      origin: "null",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("pins no-store when the gateway sends no cache-control (dynamic listing)", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("{}", { "Content-Type": "application/json" }),
    );

    const res = await callGet("tok", ["images"]);

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the upstream cache-control when present", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("{}", {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      }),
    );

    const res = await callGet("tok", ["images"]);

    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("passes upstream 404 through (non-gallery share → viewer fallback)", async () => {
    fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));

    const res = await callGet("tok", ["images"]);

    expect(res.status).toBe(404);
  });

  it("still validates the token before proxying the listing", async () => {
    const res = await callGet("tok%00", ["images"]);

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the file behavior for paths that merely contain 'images'", async () => {
    fetchMock.mockResolvedValue(
      gatewayResponse("png-bytes", { "Content-Type": "image/png" }),
    );

    const res = await callGet("tok", ["assets", "images"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [upstreamUrl] = fetchMock.mock.calls[0]!;
    expect(String(upstreamUrl)).toBe(
      `${API_BASE}/share/public/tok/f/assets/images`,
    );
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-popups allow-forms",
    );
    expect(await res.text()).toBe("png-bytes");
  });
});
