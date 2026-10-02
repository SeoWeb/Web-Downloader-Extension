import { describe, it, expect, beforeEach, vi } from "vitest";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import * as sniffModule from "../../src/background/sniffImageMime";

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

/** Helper: build a Blob from a hex string. */
function blobFromHex(hex: string): Blob {
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map((b) => parseInt(b, 16));
  return new Blob([new Uint8Array(bytes)]);
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

/** Helper: make a fake Response-like object. */
function makeResponse(blob: Blob, contentType?: string): Response {
  return {
    blob: async () => blob,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? (contentType ?? "") : null,
    },
    ok: true,
    status: 200,
    statusText: "OK",
  } as unknown as Response;
}

/** Helper: configure enqueue to resolve immediately with the given response. */
function enqueueImage(response: Response) {
  mockEnqueue.mockImplementation(async (opts: any) => {
    opts.onComplete({ response });
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
    const pngBlob = blobFromHex("89 50 4E 47 0D 0A 1A 0A 00 00 00 0D");
    mockSniff.mockResolvedValue("image/png");
    enqueueImage(makeResponse(pngBlob));

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
    const pngBlob = blobFromHex("89 50 4E 47 0D 0A 1A 0A");
    mockSniff.mockResolvedValue("image/png");
    enqueueImage(makeResponse(pngBlob));

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
    const randomBlob = blobFromHex("DE AD BE EF 00 11 22 33");
    mockSniff.mockResolvedValue(null);
    enqueueImage(makeResponse(randomBlob));

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
    const webpBlob = blobFromHex("52 49 46 46 00 00 00 00 57 45 42 50");
    enqueueImage(makeResponse(webpBlob, "image/webp"));

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
    const jpegBlob = blobFromHex("FF D8 FF E0 00 10");
    mockSniff.mockResolvedValue("image/jpeg");
    enqueueImage(makeResponse(jpegBlob, "application/octet-stream"));

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
});
