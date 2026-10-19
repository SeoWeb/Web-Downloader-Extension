/**
 * Fix G regression tests: absolute source URLs reach the server.
 *
 * The css/js/documents handlers used to call storage.addFile WITHOUT the
 * 4th originalUrl argument, so ServerStorageAdapter fell back to the local
 * archive path and resources.original_url == local_path. The monolith's
 * archived-HTML converter resolves stylesheet/script hrefs to ABSOLUTE urls
 * and looks them up in the session filename map — which only images used to
 * populate — so every stylesheet 404'd on the legacy basename fallback.
 *
 * After fix G each handler:
 * (a) passes the resolved ABSOLUTE url (query string included) as the 4th
 *     addFile argument (resources.original_url on the server), and
 * (b) returns a filename map keyed BOTH by the raw as-authored attribute
 *     and by the absolute resolved URL → archive path (with `_hash8` for
 *     query-queried files), mirroring the image handler.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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

// download-processors imports the fileHandlers barrel — mocked here for the
// pass-through tests (the handler tests below import the real files).
const mockAddCssFiles = vi.fn();
const mockAddJsFiles = vi.fn();
const mockAddDocumentFiles = vi.fn();
vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: (...args: any[]) => mockAddCssFiles(...args),
  addJsFiles: (...args: any[]) => mockAddJsFiles(...args),
  addDocumentFiles: (...args: any[]) => mockAddDocumentFiles(...args),
  addImageFiles: vi.fn(),
}));

// Import after mocks are set up
import { addCssFiles } from "../../src/background/fileHandlers/css";
import { addJsFiles } from "../../src/background/fileHandlers/js";
import { addDocumentFiles } from "../../src/background/fileHandlers/documents";
import {
  mergeFilenameMaps,
  processAssets,
  processDocuments,
} from "../../src/background/download-processors";

// ---------------------------------------------------------------------------
// Helpers (same patterns as file-handler-pipeline.test.ts)
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

function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

/** The spec scenario path shape: nested wp-content stylesheet with ?ver=. */
const QUERIED_CSS_URL = "https://site/wp-content/a/b/styles.css?ver=9";
const QUERIED_CSS_PATH = /^styles\/wp-content\/a\/b\/styles_[0-9a-f]{8}\.css$/;

// ---------------------------------------------------------------------------
// Stylesheets — the archived-page 404 scenario
// ---------------------------------------------------------------------------

describe("fix G: stylesheets carry absolute URLs into addFile and the filename map", () => {
  let storage: IStorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it('maps <link href="https://site/wp-content/a/b/styles.css?ver=9"> by its absolute URL (query included) to the _hash8 archive path', async () => {
    configureEnqueue((url) => makeResult(textBytes("body{}"), "text/css", url));

    const map = await addCssFiles(
      [QUERIED_CSS_URL],
      storage,
      "https://site/page.html",
      () => {},
    );

    // (a) filename-map entry keyed by the ABSOLUTE URL, query included
    const archivePath = map.get(QUERIED_CSS_URL);
    expect(archivePath).toMatch(QUERIED_CSS_PATH);
  });

  it("passes the absolute originalUrl as the 4th addFile argument (not the archive path)", async () => {
    configureEnqueue((url) => makeResult(textBytes("body{}"), "text/css", url));

    await addCssFiles(
      [QUERIED_CSS_URL],
      storage,
      "https://site/page.html",
      () => {},
    );

    // (b) addFile receives the absolute originalUrl — resources.original_url
    // must NOT equal local_path anymore
    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(QUERIED_CSS_PATH),
      expect.any(Blob),
      "text/css",
      QUERIED_CSS_URL,
    );
  });

  it("also keys the map by the raw as-authored attribute (document-relative href)", async () => {
    configureEnqueue((url) => makeResult(textBytes("body{}"), "text/css", url));

    const raw = "/wp-content/a/b/styles.css?ver=9";
    const map = await addCssFiles(
      [raw],
      storage,
      "https://site/page.html",
      () => {},
      undefined,
      { documentUrl: "https://site/page.html" },
    );

    const viaRaw = map.get(raw);
    const viaAbsolute = map.get(QUERIED_CSS_URL);
    expect(viaRaw).toMatch(QUERIED_CSS_PATH);
    expect(viaRaw).toBe(viaAbsolute);
  });
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

describe("fix G: scripts carry absolute URLs into addFile and the filename map", () => {
  let storage: IStorageAdapter;
  const SCRIPT_URL = "https://site/wp-content/a/b/app.js?ver=9";
  const SCRIPT_PATH = /^scripts\/wp-content\/a\/b\/app_[0-9a-f]{8}\.js$/;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it("maps the script by absolute URL and raw attribute to the archive path", async () => {
    configureEnqueue((url) =>
      makeResult(textBytes("//js"), "application/javascript", url),
    );

    const map = await addJsFiles(
      [SCRIPT_URL],
      storage,
      "https://site/page.html",
      () => {},
    );

    expect(map.get(SCRIPT_URL)).toMatch(SCRIPT_PATH);
  });

  it("passes the absolute originalUrl as the 4th addFile argument", async () => {
    configureEnqueue((url) =>
      makeResult(textBytes("//js"), "application/javascript", url),
    );

    await addJsFiles([SCRIPT_URL], storage, "https://site/page.html", () => {});

    expect(storage.addFile).toHaveBeenCalledWith(
      expect.stringMatching(SCRIPT_PATH),
      expect.any(Blob),
      "application/javascript",
      SCRIPT_URL,
    );
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

describe("fix G: documents carry absolute URLs into addFile and the filename map", () => {
  let storage: IStorageAdapter;
  const DOC_URL = "https://site/wp-content/uploads/2024/report.pdf";
  const DOC_PATH = "documents/wp-content/uploads/2024/report.pdf";

  beforeEach(() => {
    vi.clearAllMocks();
    storage = createMockStorage();
  });

  it("maps the document by absolute URL and raw attribute to the archive path", async () => {
    configureEnqueue((url) =>
      makeResult(new Uint8Array([1, 2, 3]), "application/pdf", url),
    );

    const map = await addDocumentFiles(
      [DOC_URL],
      storage,
      "https://site/page.html",
      () => {},
    );

    expect(map.get(DOC_URL)).toBe(DOC_PATH);
  });

  it("passes the absolute originalUrl as the 4th addFile argument", async () => {
    configureEnqueue((url) =>
      makeResult(new Uint8Array([1, 2, 3]), "application/pdf", url),
    );

    await addDocumentFiles(
      [DOC_URL],
      storage,
      "https://site/page.html",
      () => {},
    );

    expect(storage.addFile).toHaveBeenCalledWith(
      DOC_PATH,
      expect.any(Blob),
      "application/pdf",
      DOC_URL,
    );
  });
});

// ---------------------------------------------------------------------------
// Map merge + call-chain pass-through
// ---------------------------------------------------------------------------

describe("fix G: filename map merge and handler pass-through", () => {
  it("mergeFilenameMaps keeps image entries first and never clobbers them", () => {
    const images = new Map([
      ["https://host/i.png", "images/i.png"],
      ["https://host/shared", "images/shared"],
    ]);
    const css = new Map([
      ["https://host/shared", "styles/shared"],
      ["https://host/s.css", "styles/s.css"],
    ]);
    const js = new Map([["https://host/a.js", "scripts/a.js"]]);

    const merged = mergeFilenameMaps(images, css, js);

    // Image entry wins the (rare) shared-URL collision
    expect(merged.get("https://host/shared")).toBe("images/shared");
    expect(merged.get("https://host/i.png")).toBe("images/i.png");
    expect(merged.get("https://host/s.css")).toBe("styles/s.css");
    expect(merged.get("https://host/a.js")).toBe("scripts/a.js");
  });

  it("mergeFilenameMaps tolerates undefined sources (category disabled)", () => {
    const merged = mergeFilenameMaps(
      new Map([["k", "images/k"]]),
      undefined,
      undefined,
    );
    expect(merged.get("k")).toBe("images/k");
    expect(merged.size).toBe(1);
  });

  it("processAssets returns the merged css+js map; processDocuments the document map", async () => {
    mockAddCssFiles.mockResolvedValue(
      new Map([["https://host/a.css", "styles/a.css"]]),
    );
    mockAddJsFiles.mockResolvedValue(
      new Map([["https://host/a.js", "scripts/a.js"]]),
    );

    const sendMessage = vi.fn();
    const assetsMap = await processAssets(
      { css: ["a.css"], js: ["a.js"] },
      createMockStorage(),
      "https://host/page.html",
      sendMessage,
      undefined,
      { documentUrl: "https://host/page.html" },
    );
    expect(assetsMap.get("https://host/a.css")).toBe("styles/a.css");
    expect(assetsMap.get("https://host/a.js")).toBe("scripts/a.js");

    mockAddDocumentFiles.mockResolvedValue(
      new Map([["https://host/d.pdf", "documents/d.pdf"]]),
    );
    const docsMap = await processDocuments(
      ["d.pdf"],
      createMockStorage(),
      "https://host/page.html",
      sendMessage,
      undefined,
      { documentUrl: "https://host/page.html" },
    );
    expect(docsMap.get("https://host/d.pdf")).toBe("documents/d.pdf");
  });

  it("processAssets returns an empty map when no css/js are present", async () => {
    const map = await processAssets(
      { css: [], js: [] },
      createMockStorage(),
      "https://host/page.html",
      vi.fn(),
    );
    expect(map.size).toBe(0);
  });
});
