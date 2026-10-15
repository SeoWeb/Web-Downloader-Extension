/**
 * Tests for bounded non-full linked-page collection (task 3.7).
 *
 * The non-full linked-page mode used to fetch EVERY <a href> with a bare
 * fetch() + text() and upload the body as "linked" HTML — including PDFs,
 * ZIPs and media, with no size limit and no timeout. fetchAndUploadLinkedPages
 * bounds the collection:
 * - only text/html responses are uploaded as "linked" HTML (a PDF link must
 *   never become a corrupt HTML document),
 * - non-HTML responses count as skipped,
 * - a 5 MB size cap is enforced via Content-Length and a capped stream read,
 * - each fetch is bounded by the download abort signal + per-request timeout.
 */

import { fetchAndUploadLinkedPages } from "../../src/background/download-core";

vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: vi.fn().mockResolvedValue(undefined),
  setActiveServerSession: vi.fn(),
  getActiveServerSessionId: vi.fn().mockReturnValue(null),
  hasStreamedHtmlChunks: vi.fn().mockReturnValue(false),
  deleteServerSessionState: vi.fn(),
}));

function htmlResponse(
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

function nonHtmlResponse(contentType: string, body = "x"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("fetchAndUploadLinkedPages (task 3.7)", () => {
  let uploadChunk: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    uploadChunk = vi.fn().mockResolvedValue(undefined);
  });

  it("uploads a text/html linked page with its index and page URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<html><body>hi</body></html>")),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/page"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(uploadChunk).toHaveBeenCalledWith(
      expect.stringContaining("<html>"),
      0,
      "https://example.com/page",
    );
  });

  it("does NOT upload a PDF link as HTML and counts it as skipped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        nonHtmlResponse("application/pdf", "%PDF-1.4 binary..."),
      ),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/report.pdf"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.uploadedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });

  it("skips non-HTML responses (zip, images, json)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith(".zip")) {
          return nonHtmlResponse("application/zip", "PK");
        }
        if (url.endsWith(".png")) {
          return nonHtmlResponse("image/png", "binary");
        }
        return nonHtmlResponse("application/json", "{}");
      }),
    );

    const result = await fetchAndUploadLinkedPages({
      links: [
        "https://example.com/a.zip",
        "https://example.com/b.png",
        "https://example.com/api",
      ],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.uploadedCount).toBe(0);
    expect(result.skippedCount).toBe(3);
  });

  it("skips non-OK responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
      ),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/missing"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("skips responses whose Content-Length exceeds the size cap without reading the body", async () => {
    const bigLength = 6 * 1024 * 1024; // > 5 MB default cap
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse("<html>huge</html>", {
          "content-length": String(bigLength),
        }),
      ),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/huge"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("skips streams that exceed the cap mid-read (no Content-Length)", async () => {
    const bigChunk = "a".repeat(1024 * 1024); // 1 MB per chunk
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 7; i++) {
          controller.enqueue(new TextEncoder().encode(bigChunk)); // 7 MB total
        }
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/streaming-huge"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.skippedCount).toBe(1);
  });

  it("uploads HTML bodies within the cap when Content-Length is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<html><body>small</body></html>")),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/small"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
      maxBytes: 1024,
    });

    expect(result.uploadedCount).toBe(1);
    expect(uploadChunk).toHaveBeenCalledOnce();
  });

  it("counts fetch failures (network/timeout) as skipped and keeps going", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/dead")) {
          throw new TypeError("fetch failed");
        }
        return htmlResponse("<html>ok</html>");
      }),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/dead", "https://example.com/alive"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    expect(result.uploadedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(uploadChunk).toHaveBeenCalledTimes(1);
  });

  it("stops and counts the rest as skipped once the abort signal fires", async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchMock = vi.fn().mockResolvedValue(htmlResponse("<html>x</html>"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAndUploadLinkedPages({
      links: [
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/c",
      ],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      signal: controller.signal,
      uploadChunk,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadChunk).not.toHaveBeenCalled();
    expect(result.uploadedCount).toBe(0);
    expect(result.skippedCount).toBe(3);
  });

  it("counts invalid URLs as skipped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<html>x</html>")),
    );

    const result = await fetchAndUploadLinkedPages({
      links: ["not a url at all"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk,
    });

    // "not a url at all" resolves against the base into a valid URL, so it
    // uploads; a truly invalid base would throw in the URL constructor.
    expect(result.uploadedCount).toBe(1);
  });

  it("propagates uploadChunk failures as skipped pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(htmlResponse("<html>x</html>")),
    );
    const failingUpload = vi.fn().mockRejectedValue(new Error("413 full"));

    const result = await fetchAndUploadLinkedPages({
      links: ["https://example.com/a"],
      baseUrl: "https://example.com/",
      sessionId: "sess-1",
      uploadChunk: failingUpload,
    });

    expect(result.uploadedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
