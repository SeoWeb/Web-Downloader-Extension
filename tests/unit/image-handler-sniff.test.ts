import { describe, it, expect, beforeEach, vi } from "vitest";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import * as sniffModule from "../../src/background/sniffImageMime";
import type { RequestResult } from "../../src/types/queue";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../../src/background/sniffImageMime", () => ({
  sniffImageMimeType: vi.fn(),
}));

// Mock the RequestQueue singleton
const mockEnqueue = vi.fn();
vi.mock("../../src/utils/RequestQueue", () => ({
  requestQueue: {
    enqueue: (...args: any[]) => mockEnqueue(...args),
  },
}));

const mockSniff = vi.mocked(sniffModule.sniffImageMimeType);

// Import after mocks are set up
import { addImageFiles } from "../../src/background/fileHandlers/images";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper: build a byte array from a hex string. */
function bytesFromHex(hex: string): Uint8Array {
  return new Uint8Array(
    hex
      .trim()
      .split(/\s+/)
      .map((b) => parseInt(b, 16)),
  );
}

/** Helper: create a mock storage adapter. */
function createMockStorage(): IStorageAdapter {
  const files = new Map<string, { blob: Blob; mime?: string }>();
  return {
    addFile: vi.fn(async (path: string, blob: Blob, mimeType?: string) => {
      files.set(path, { blob, mime: mimeType });
    }),
    getFile: vi.fn(async (path: string) => {
      return files.get(path)?.blob ?? null;
    }),
    getAllFiles: vi.fn(async () => Array.from(files.keys())),
    clear: vi.fn(async () => {
      files.clear();
    }),
    getResourceCount: vi.fn(async () => files.size),
  };
}

/**
 * Helper: build a RequestResult carrying the Wave-1 snapshot API
 * (`result.snapshot.bytes` / `result.snapshot.contentType` / `result.type`).
 */
function makeResult(bytes: Uint8Array, contentType?: string): RequestResult {
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
    requestId: "req-1",
    url: "https://cdn.example.com/asset",
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

/** Helper: build an opaque (no-cors) RequestResult — body never readable. */
function makeOpaqueResult(): RequestResult {
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
    requestId: "req-1",
    url: "https://cdn.example.com/asset",
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

/** Helper: configure enqueue to resolve immediately with the given result. */
function enqueueImage(result: RequestResult) {
  mockEnqueue.mockImplementation(async (opts: any) => {
    opts.onComplete(result);
    return { id: "1" };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("addImageFiles — MIME sniffing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sniffs PNG when Content-Type is empty and maps to .png filename", async () => {
    const pngBytes = bytesFromHex("89 50 4E 47 0D 0A 1A 0A 00 00 00 0D");
    mockSniff.mockResolvedValue("image/png");
    enqueueImage(makeResult(pngBytes));

    const storage = createMockStorage();
    const map = await addImageFiles(
      ["https://cdn.example.com/icon-product-mac"],
      storage,
      "https://cdn.example.com/page",
      () => {},
    );

    expect(mockSniff).toHaveBeenCalled();
    const mapped = map.get("https://cdn.example.com/icon-product-mac");
    expect(mapped).toBeDefined();
    expect(mapped).toMatch(/\.png$/);
  });

  it("passes sniffed MIME to storage.addFile", async () => {
    const pngBytes = bytesFromHex("89 50 4E 47 0D 0A 1A 0A");
    mockSniff.mockResolvedValue("image/png");
    enqueueImage(makeResult(pngBytes));

    const storage = createMockStorage();
    await addImageFiles(
      ["https://cdn.example.com/icon"],
      storage,
      "https://cdn.example.com/page",
      () => {},
    );

    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(/images\/.*\.png/),
      expect.any(Blob),
      "image/png",
      "https://cdn.example.com/icon",
    );
  });

  it("falls back to .bin when sniff returns null", async () => {
    const randomBytes = bytesFromHex("DE AD BE EF 00 11 22 33");
    mockSniff.mockResolvedValue(null);
    enqueueImage(makeResult(randomBytes));

    const storage = createMockStorage();
    const map = await addImageFiles(
      ["https://cdn.example.com/unknown"],
      storage,
      "https://cdn.example.com/page",
      () => {},
    );

    expect(mockSniff).toHaveBeenCalled();
    const mapped = map.get("https://cdn.example.com/unknown");
    expect(mapped).toBeDefined();
    expect(mapped).toMatch(/\.bin$/);
    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(/images\/.*\.bin/),
      expect.any(Blob),
      undefined,
      "https://cdn.example.com/unknown",
    );
  });

  it("does NOT sniff when Content-Type is already known", async () => {
    const webpBytes = bytesFromHex("52 49 46 46 00 00 00 00 57 45 42 50");
    enqueueImage(makeResult(webpBytes, "image/webp"));

    const storage = createMockStorage();
    const map = await addImageFiles(
      ["https://cdn.example.com/photo"],
      storage,
      "https://cdn.example.com/page",
      () => {},
    );

    expect(mockSniff).not.toHaveBeenCalled();
    const mapped = map.get("https://cdn.example.com/photo");
    expect(mapped).toBeDefined();
    expect(mapped).toMatch(/\.webp$/);
    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(/images\/.*\.webp/),
      expect.any(Blob),
      "image/webp",
      "https://cdn.example.com/photo",
    );
  });

  it("sniffs when Content-Type is application/octet-stream", async () => {
    const jpegBytes = bytesFromHex("FF D8 FF E0 00 10");
    mockSniff.mockResolvedValue("image/jpeg");
    enqueueImage(makeResult(jpegBytes, "application/octet-stream"));

    const storage = createMockStorage();
    const map = await addImageFiles(
      ["https://cdn.example.com/data"],
      storage,
      "https://cdn.example.com/page",
      () => {},
    );

    expect(mockSniff).toHaveBeenCalled();
    const mapped = map.get("https://cdn.example.com/data");
    expect(mapped).toBeDefined();
    expect(mapped).toMatch(/\.jpg$/);
    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(/images\/.*\.jpg/),
      expect.any(Blob),
      "image/jpeg",
      "https://cdn.example.com/data",
    );
  });

  // ------------------------------------------------------------------------
  // Opaque (no-cors) responses — task 2.4
  // ------------------------------------------------------------------------

  it("records a categorized cors failure for opaque responses and never reads the body", async () => {
    const opaqueResult = makeOpaqueResult();
    const responseSpy = vi.spyOn(opaqueResult, "response", "get");
    enqueueImage(opaqueResult);

    const storage = createMockStorage();
    const messages: any[] = [];
    const map = await addImageFiles(
      ["https://cdn.example.com/blocked.png"],
      storage,
      "https://cdn.example.com/page",
      (m) => messages.push(m),
    );

    // The body must never be touched.
    expect(responseSpy).not.toHaveBeenCalled();
    expect(mockSniff).not.toHaveBeenCalled();
    expect(storage.addFile).not.toHaveBeenCalled();

    // Recorded as a failure with the "cors" category, download continues.
    expect(map.size).toBe(0);
    const summary = messages.find(
      (m) => typeof m === "object" && m.key === "status.imagesSummary",
    );
    expect(summary).toBeDefined();
    expect(summary.options.failed).toBe(1);
    expect(summary.options.failureCategories).toEqual({ cors: 1 });
  });
});
