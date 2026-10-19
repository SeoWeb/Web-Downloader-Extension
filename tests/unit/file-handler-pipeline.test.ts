/**
 * Unit tests for the JS / images / documents file handlers
 * (OpenSpec tasks 1.5, 2.4, 3.1, 3.6).
 *
 * Covers:
 * - relative URLs resolved against the document URL (design D2)
 * - opaque (no-cors) responses recorded as categorized `cors` failures,
 *   body never read, download continues
 * - collision-free archive paths preserving directory structure
 * - non-fetchable schemes (blob:, data:, javascript:, fragments) skipped
 * - queue failure categories surfaced in summaries
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import type { RequestResult } from "../../src/types/queue";
import { RequestQueueError } from "../../src/types/queue";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the modules under test
// ---------------------------------------------------------------------------

const mockEnqueue = vi.fn();
vi.mock("../../src/utils/RequestQueue", () => ({
  requestQueue: {
    enqueue: (...args: any[]) => mockEnqueue(...args),
  },
}));

// Import after mocks are set up
import { addJsFiles } from "../../src/background/fileHandlers/js";
import { addImageFiles } from "../../src/background/fileHandlers/images";
import { addDocumentFiles } from "../../src/background/fileHandlers/documents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(): IStorageAdapter {
  const files = new Map<string, { blob: Blob; mime?: string }>();
  return {
    addFile: vi.fn(async (path: string, blob: Blob, mimeType?: string) => {
      files.set(path, { blob, mime: mimeType });
    }),
    getFile: vi.fn(async (path: string) => files.get(path)?.blob ?? null),
    getAllFiles: vi.fn(async () =>
      Array.from(files.keys()).map((path) => ({ path, size: 0 })),
    ),
    clear: vi.fn(async () => files.clear()),
  } as unknown as IStorageAdapter;
}

function makeResult(
  bytes: Uint8Array,
  contentType?: string,
  url = "https://host/asset",
): RequestResult {
  const headers: Record<string, string> = contentType
    ? { "content-type": contentType }
    : {};
  const snapshot = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers,
    contentType: contentType ?? "",
    type: "default" as const,
    bytes,
    text: null,
  };
  return {
    requestId: "req",
    url,
    snapshot,
    type: "default",
    duration: 1,
    size: bytes.byteLength,
    fromCache: false,
    get response() {
      return new Response(bytes, { headers });
    },
  } as unknown as RequestResult;
}

function makeOpaqueResult(url: string): RequestResult {
  const snapshot = {
    ok: false,
    status: 0,
    statusText: "",
    headers: {},
    contentType: "",
    type: "opaque" as const,
    bytes: null,
    text: null,
  };
  return {
    requestId: "req",
    url,
    snapshot,
    type: "opaque",
    duration: 1,
    size: 0,
    fromCache: false,
    get response() {
      return new Response(null);
    },
  } as unknown as RequestResult;
}

/** Configure enqueue to answer each URL from a factory. */
function configureEnqueue(
  responder: (url: string) => RequestResult | Error,
): void {
  mockEnqueue.mockImplementation(async (opts: any) => {
    const outcome = responder(opts.url);
    if (outcome instanceof Error) {
      opts.onError(outcome);
    } else {
      opts.onComplete(outcome);
    }
    return { id: opts.url };
  });
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);

// ---------------------------------------------------------------------------
// JS handler
// ---------------------------------------------------------------------------

describe("addJsFiles", () => {
  let storage: IStorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it("resolves relative script URLs against the document URL", async () => {
    const fetched: string[] = [];
    configureEnqueue((url) => {
      fetched.push(url);
      return makeResult(new TextEncoder().encode("//js"), url);
    });

    await addJsFiles(
      ["js/app.js"],
      storage,
      "https://host/dir/page.html",
      () => {},
      undefined,
      { documentUrl: "https://host/dir/page.html" },
    );

    expect(fetched).toContain("https://host/dir/js/app.js");
    expect(fetched).not.toContain("https://host/js/app.js");
  });

  it("falls back to legacy origin-based resolution without documentUrl", async () => {
    const fetched: string[] = [];
    configureEnqueue((url) => {
      fetched.push(url);
      return makeResult(new TextEncoder().encode("//js"), url);
    });

    await addJsFiles(
      ["js/app.js"],
      storage,
      "https://host/dir/page.html",
      () => {},
    );

    expect(fetched).toContain("https://host/js/app.js");
  });

  it("uploads scripts at collision-free archive paths preserving directories", async () => {
    configureEnqueue((url) =>
      makeResult(new TextEncoder().encode("//js"), url),
    );

    await addJsFiles(
      ["https://host/a/app.js", "https://host/b/app.js"],
      storage,
      "https://host/page.html",
      () => {},
    );

    expect(storage.addFile).toHaveBeenCalledWith(
      "scripts/a/app.js",
      expect.any(Blob),
      "application/javascript",
      "https://host/a/app.js",
    );
    expect(storage.addFile).toHaveBeenCalledWith(
      "scripts/b/app.js",
      expect.any(Blob),
      "application/javascript",
      "https://host/b/app.js",
    );
  });

  it("records a categorized cors failure for opaque responses without reading the body", async () => {
    const opaque = makeOpaqueResult("https://host/blocked.js");
    const responseSpy = vi.spyOn(opaque, "response", "get");
    configureEnqueue(() => opaque);

    const messages: any[] = [];
    await addJsFiles(
      ["https://host/blocked.js"],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    expect(responseSpy).not.toHaveBeenCalled();
    expect(storage.addFile).not.toHaveBeenCalled();
    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.jsSummary",
    );
    expect(summary.options.failed).toBe(1);
    expect(summary.options.failureCategories).toEqual({ cors: 1 });
  });

  it("surfaces queue failure categories in the summary", async () => {
    configureEnqueue(() => new RequestQueueError("Timed out", "timeout"));

    const messages: any[] = [];
    await addJsFiles(
      ["https://host/slow.js"],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.jsSummary",
    );
    expect(summary.options.failureCategories).toEqual({ timeout: 1 });
  });

  it("skips blob:, javascript: and fragment-only script URLs", async () => {
    configureEnqueue((url) =>
      makeResult(new TextEncoder().encode("//js"), url),
    );

    const messages: any[] = [];
    await addJsFiles(
      [
        "blob:https://host/uuid",
        "javascript:void(0)",
        "#fragment",
        "https://host/real.js",
      ],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
    expect(enqueuedUrls).toEqual(["https://host/real.js"]);
    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.jsSummary",
    );
    expect(summary.options.skipped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Images handler
// ---------------------------------------------------------------------------

describe("addImageFiles", () => {
  let storage: IStorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it("resolves relative image URLs against the document URL (nested page scenario)", async () => {
    const fetched: string[] = [];
    configureEnqueue((url) => {
      fetched.push(url);
      return makeResult(PNG_BYTES, "image/png", url);
    });

    const map = await addImageFiles(
      ["img/x.png"],
      storage,
      "https://host/dir/page.html",
      () => {},
      undefined,
      { documentUrl: "https://host/dir/page.html" },
    );

    // Spec scenario: https://host/dir/page.html + img/x.png → /dir/img/x.png
    expect(fetched).toContain("https://host/dir/img/x.png");
    expect(fetched).not.toContain("https://host/img/x.png");
    // The filename map points at the actual uploaded archive path.
    expect(map.get("img/x.png")).toBe("images/dir/img/x.png");
    expect(map.get("https://host/dir/img/x.png")).toBe("images/dir/img/x.png");
  });

  it("resolves parent-relative references from linked pages against their own URL", async () => {
    const fetched: string[] = [];
    configureEnqueue((url) => {
      fetched.push(url);
      return makeResult(PNG_BYTES, "image/jpeg", url);
    });

    await addImageFiles(
      ["../../c/pic.jpg"],
      storage,
      "https://host/a/page.html",
      () => {},
      undefined,
      { documentUrl: "https://host/a/b/post.html" },
    );

    // Two parent hops from the linked page's directory (/a/b/) reach /c/.
    expect(fetched).toContain("https://host/c/pic.jpg");
  });

  it("stores same-basename images from different directories at distinct paths", async () => {
    configureEnqueue((url) => makeResult(PNG_BYTES, "image/png", url));

    const map = await addImageFiles(
      ["https://host/a/pic.png", "https://host/b/pic.png"],
      storage,
      "https://host/page.html",
      () => {},
    );

    const paths = (storage.addFile as any).mock.calls.map((c) => c[0]);
    expect(paths).toEqual(["images/a/pic.png", "images/b/pic.png"]);
    expect(map.get("https://host/a/pic.png")).toBe("images/a/pic.png");
    expect(map.get("https://host/b/pic.png")).toBe("images/b/pic.png");
  });

  it("records a categorized cors failure for opaque responses and continues", async () => {
    const byUrl: Record<string, RequestResult> = {
      "https://host/blocked/img.png": makeOpaqueResult(
        "https://host/blocked/img.png",
      ),
      "https://host/ok/img.png": makeResult(
        PNG_BYTES,
        "image/png",
        "https://host/ok/img.png",
      ),
    };
    const opaqueSpy = vi.spyOn(
      byUrl["https://host/blocked/img.png"],
      "response",
      "get",
    );
    configureEnqueue((url) => byUrl[url]);

    const messages: any[] = [];
    const map = await addImageFiles(
      ["https://host/blocked/img.png", "https://host/ok/img.png"],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    // Opaque body never read; the other image still downloads.
    expect(opaqueSpy).not.toHaveBeenCalled();
    expect(storage.addFile).toHaveBeenCalledTimes(1);
    expect(storage.addFile).toHaveBeenCalledWith(
      "images/ok/img.png",
      expect.any(Blob),
      "image/png",
      "https://host/ok/img.png",
    );

    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.imagesSummary",
    );
    expect(summary.options.failed).toBe(1);
    expect(summary.options.succeeded).toBe(1);
    expect(summary.options.failureCategories).toEqual({ cors: 1 });
    expect(map.has("https://host/blocked/img.png")).toBe(false);
  });

  it("skips blob: and data: image URLs without enqueueing them", async () => {
    configureEnqueue((url) => makeResult(PNG_BYTES, "image/png", url));

    const map = await addImageFiles(
      [
        "blob:https://host/uuid",
        "data:image/png;base64,AAAA",
        "https://host/real.png",
      ],
      storage,
      "https://host/page.html",
      () => {},
    );

    const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
    expect(enqueuedUrls).toEqual(["https://host/real.png"]);
    expect(map.has("blob:https://host/uuid")).toBe(false);
    expect(map.has("data:image/png;base64,AAAA")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Documents handler
// ---------------------------------------------------------------------------

describe("addDocumentFiles", () => {
  let storage: IStorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it("resolves relative document URLs against the document URL", async () => {
    const fetched: string[] = [];
    configureEnqueue((url) => {
      fetched.push(url);
      return makeResult(new Uint8Array([1, 2, 3]), "application/pdf", url);
    });

    await addDocumentFiles(
      ["files/report.pdf"],
      storage,
      "https://host/dir/page.html",
      () => {},
      undefined,
      { documentUrl: "https://host/dir/page.html" },
    );

    expect(fetched).toContain("https://host/dir/files/report.pdf");
  });

  it("uploads documents at collision-free archive paths with the right MIME", async () => {
    configureEnqueue((url) =>
      makeResult(new Uint8Array([1, 2, 3]), "application/pdf", url),
    );

    await addDocumentFiles(
      ["https://host/2024/report.pdf", "https://host/2025/report.pdf"],
      storage,
      "https://host/page.html",
      () => {},
    );

    expect(storage.addFile).toHaveBeenCalledWith(
      "documents/2024/report.pdf",
      expect.any(Blob),
      "application/pdf",
      "https://host/2024/report.pdf",
    );
    expect(storage.addFile).toHaveBeenCalledWith(
      "documents/2025/report.pdf",
      expect.any(Blob),
      "application/pdf",
      "https://host/2025/report.pdf",
    );
  });

  it("records a cors failure for opaque document responses", async () => {
    const opaque = makeOpaqueResult("https://host/blocked.pdf");
    const responseSpy = vi.spyOn(opaque, "response", "get");
    configureEnqueue(() => opaque);

    const messages: any[] = [];
    await addDocumentFiles(
      ["https://host/blocked.pdf"],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    expect(responseSpy).not.toHaveBeenCalled();
    expect(storage.addFile).not.toHaveBeenCalled();
    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.documentsSummary",
    );
    expect(summary.options.failed).toBe(1);
    expect(summary.options.failureCategories).toEqual({ cors: 1 });
  });

  it("skips blob: and fragment-only document URLs", async () => {
    configureEnqueue((url) =>
      makeResult(new Uint8Array([1]), "application/pdf", url),
    );

    const messages: any[] = [];
    await addDocumentFiles(
      ["blob:https://host/x.pdf", "#report", "https://host/real.pdf"],
      storage,
      "https://host/page.html",
      (m) => messages.push(m),
    );

    const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
    expect(enqueuedUrls).toEqual(["https://host/real.pdf"]);
    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.documentsSummary",
    );
    expect(summary.options.skipped).toBe(2);
  });
});
