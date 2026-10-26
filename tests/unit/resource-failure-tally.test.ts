/**
 * Unit tests for the resourcesFailed aggregation (Fix: report failed
 * resource fetches end-to-end).
 *
 * Covers:
 * - sumResourceFailures: pure per-category → total aggregation
 * - `~` is preserved by fixFilename / generateImageFilename /
 *   buildArchivePath (sanitizeArchiveSegment) — Turbopack asset names
 *   contain `~` and the server matches CSS url() references literally
 * - handler → tally wiring: addJsFiles / addImageFiles feed their
 *   failCount into the shared tally threaded via FileHandlerOptions
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import type { RequestResult } from "../../src/types/queue";

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
import {
  sumResourceFailures,
  fixFilename,
  generateImageFilename,
  buildArchivePath,
} from "../../src/background/urlUtils";
import { addJsFiles } from "../../src/background/fileHandlers/js";
import { addImageFiles } from "../../src/background/fileHandlers/images";

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

/** Configure enqueue so every request fails like a 404 would. */
function configureEnqueueAllFail(): void {
  mockEnqueue.mockImplementation(async (opts: any) => {
    opts.onError(new Error("404 Not Found"));
    return { id: opts.url };
  });
}

// ---------------------------------------------------------------------------
// sumResourceFailures (pure aggregation)
// ---------------------------------------------------------------------------

describe("sumResourceFailures", () => {
  it("sums per-category counts (css 2 + images 1 + js 0 + documents 0 → 3)", () => {
    expect(
      sumResourceFailures({ css: 2, images: 1, js: 0, documents: 0 }),
    ).toBe(3);
  });

  it("treats missing categories as 0", () => {
    expect(sumResourceFailures({})).toBe(0);
    expect(sumResourceFailures({ css: 4 })).toBe(4);
    expect(sumResourceFailures({ documents: 2, js: 5 })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// `~` preservation (Turbopack asset names contain `~`)
// ---------------------------------------------------------------------------

describe("tilde preservation in sanitized filenames", () => {
  it("fixFilename preserves `~` (Turbopack font asset name)", () => {
    expect(fixFilename("6306c77e7c8268e4-s.0rhz0arwfsn~5.woff2")).toBe(
      "6306c77e7c8268e4-s.0rhz0arwfsn~5.woff2",
    );
  });

  it("fixFilename still sanitizes the other reserved characters", () => {
    expect(fixFilename("we^ird&name.png")).toBe("we-ird-name.png");
  });

  it("generateImageFilename preserves `~`", () => {
    expect(generateImageFilename("https://host/img/pic~1.webp")).toBe(
      "img_pic~1.webp",
    );
  });

  it("buildArchivePath preserves `~` (exercises sanitizeArchiveSegment)", () => {
    expect(
      buildArchivePath(
        "https://host/_next/static/chunks/6306c77e7c8268e4-s.0rhz0arwfsn~5.woff2",
        "images",
      ),
    ).toBe("images/_next/static/chunks/6306c77e7c8268e4-s.0rhz0arwfsn~5.woff2");
  });
});

// ---------------------------------------------------------------------------
// Handler → tally wiring
// ---------------------------------------------------------------------------

describe("handler failure tally wiring", () => {
  let storage: IStorageAdapter;

  beforeEach(() => {
    storage = createMockStorage();
    mockEnqueue.mockReset();
  });

  it("addJsFiles feeds its failCount into the shared tally", async () => {
    configureEnqueueAllFail();
    const tally: Record<string, number> = {};
    await addJsFiles(
      ["a.js", "b.js"],
      storage,
      "https://site/page.html",
      () => {},
      undefined,
      { failureTally: tally as any },
    );
    expect(tally.js).toBe(2);
  });

  it("addImageFiles feeds its failCount into the shared tally", async () => {
    configureEnqueueAllFail();
    const tally: Record<string, number> = {};
    await addImageFiles(
      ["a.png", "b.png", "c.png"],
      storage,
      "https://site/page.html",
      () => {},
      undefined,
      { failureTally: tally as any },
    );
    expect(tally.images).toBe(3);
  });

  it("handlers leave the tally untouched when no tally is provided", async () => {
    configureEnqueueAllFail();
    await addJsFiles(["a.js"], storage, "https://site/page.html", () => {});
    // No throw — the tally is optional
    expect(mockEnqueue).toHaveBeenCalled();
  });

  it("records 0 (not undefined) when all fetches succeed", async () => {
    mockEnqueue.mockImplementation(async (opts: any) => {
      opts.onComplete(makeOkResult(opts.url));
      return { id: opts.url };
    });
    const tally: Record<string, number> = {};
    await addJsFiles(
      ["a.js"],
      storage,
      "https://site/page.html",
      () => {},
      undefined,
      { failureTally: tally as any },
    );
    expect(tally.js).toBe(0);
  });
});

/** Minimal successful RequestResult (bytes only, enough for js handler). */
function makeOkResult(url: string): RequestResult {
  const bytes = new Uint8Array([0x61, 0x62]); // "ab"
  const snapshot = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    contentType: "application/javascript",
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
      return new Response(bytes);
    },
  } as unknown as RequestResult;
}
