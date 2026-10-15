/**
 * Unit tests for the CSS file handler (OpenSpec tasks 1.5, 2.4, 3.1, 3.3, 3.4).
 *
 * Covers:
 * - relative URLs resolved against the document URL (design D2)
 * - charset-aware decoding: Content-Type, then @charset, then UTF-8 (design D6)
 * - @import extraction: nested chains, cycles, depth cap of 3, dedup
 * - opaque (no-cors) responses recorded as a categorized `cors` failure
 * - robust url() extraction (quoted URLs containing parentheses)
 * - collision-free archive paths for same-basename stylesheets
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import type { RequestResult } from "../../src/types/queue";
import { RequestQueueError } from "../../src/types/queue";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockEnqueue = vi.fn();
vi.mock("../../src/utils/RequestQueue", () => ({
  requestQueue: {
    enqueue: (...args: any[]) => mockEnqueue(...args),
  },
}));

// Import after mocks are set up
import { addCssFiles } from "../../src/background/fileHandlers/css";

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

/** RequestResult carrying the Wave-1 snapshot API with the given text bytes. */
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

/** Opaque (no-cors) result — the body is unreadable, bytes are null. */
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

function cssBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

/** Configure enqueue to answer each URL from a map (or factory). */
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

function okCss(content: string, contentType?: string) {
  return (url: string) => makeResult(cssBytes(content), contentType, url);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("addCssFiles", () => {
  let storage: IStorageAdapter;
  const messages: any[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    messages.length = 0;
    storage = createMockStorage();
  });

  // ------------------------------------------------------------------------
  // Task 1.5 — document-URL resolution
  // ------------------------------------------------------------------------

  describe("document URL resolution (task 1.5)", () => {
    it("resolves relative CSS URLs against the document URL, not the origin", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        return okCss("body{}")(url);
      });

      await addCssFiles(
        ["css/theme.css"],
        storage,
        "https://host/dir/page.html",
        (m) => messages.push(m),
        undefined,
        { documentUrl: "https://host/dir/page.html" },
      );

      expect(fetched).toContain("https://host/dir/css/theme.css");
      expect(fetched).not.toContain("https://host/css/theme.css");
    });

    it("resolves root-relative and protocol-relative references via the document URL", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        return okCss("body{}")(url);
      });

      await addCssFiles(
        ["/abs/style.css", "//cdn.example.org/lib/x.css"],
        storage,
        "https://host/dir/page.html",
        (m) => messages.push(m),
        undefined,
        { documentUrl: "https://host/dir/page.html" },
      );

      expect(fetched).toContain("https://host/abs/style.css");
      expect(fetched).toContain("https://cdn.example.org/lib/x.css");
    });

    it("falls back to the legacy origin-based resolution without documentUrl", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        return okCss("body{}")(url);
      });

      await addCssFiles(
        ["css/theme.css"],
        storage,
        "https://host/dir/page.html",
        (m) => messages.push(m),
      );

      // Previous behavior: resolved against origin + "/"
      expect(fetched).toContain("https://host/css/theme.css");
    });
  });

  // ------------------------------------------------------------------------
  // Task 3.1 — collision-free archive paths
  // ------------------------------------------------------------------------

  describe("archive paths (task 3.1)", () => {
    it("stores same-basename stylesheets from different directories at distinct paths", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/a/main.css": okCss(".a{}")("https://host/a/main.css"),
        "https://host/b/main.css": okCss(".b{}")("https://host/b/main.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/a/main.css", "https://host/b/main.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/a/main.css",
        expect.any(Blob),
        "text/css",
      );
      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/b/main.css",
        expect.any(Blob),
        "text/css",
      );

      // Each file keeps its own content.
      const a = await (storage.addFile as any).mock.calls.find(
        (c) => c[0] === "styles/a/main.css",
      )[1].text();
      const b = await (storage.addFile as any).mock.calls.find(
        (c) => c[0] === "styles/b/main.css",
      )[1].text();
      expect(a).toBe(".a{}");
      expect(b).toBe(".b{}");
    });

    it("hashes query variants of the same path into distinct filenames", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/w/x.css?v=1": okCss(".v1{}")("https://host/w/x.css?v=1"),
        "https://host/w/x.css?v=2": okCss(".v2{}")("https://host/w/x.css?v=2"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/w/x.css?v=1", "https://host/w/x.css?v=2"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const paths = (storage.addFile as any).mock.calls.map((c) => c[0]);
      expect(paths).toHaveLength(2);
      expect(new Set(paths).size).toBe(2);
      for (const path of paths) {
        expect(path).toMatch(/^styles\/w\/x_[0-9a-f]{8}\.css$/);
      }
    });
  });

  // ------------------------------------------------------------------------
  // Task 3.3 — charset-aware decoding
  // ------------------------------------------------------------------------

  describe("charset decoding (task 3.3)", () => {
    // "テスト" in Shift_JIS bytes.
    const SJIS_TEST = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67];

    function shiftJisBytes(withAtCharset: boolean): Uint8Array {
      const prefix = withAtCharset
        ? '@charset "Shift_JIS";\nbody::before{content:"'
        : 'body::before{content:"';
      return Uint8Array.from([
        ...new TextEncoder().encode(prefix),
        ...SJIS_TEST,
        ...new TextEncoder().encode('";}'),
      ]);
    }

    it("decodes Shift_JIS content via the Content-Type charset header", async () => {
      configureEnqueue(
        okCss("", "text/css; charset=Shift_JIS"),
      );
      // Override the responder to hand back raw Shift_JIS bytes (no @charset).
      configureEnqueue((url) =>
        makeResult(
          shiftJisBytes(false),
          "text/css; charset=Shift_JIS",
          url,
        ),
      );

      await addCssFiles(
        ["https://host/jp/page.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(storage.addFile).toHaveBeenCalledTimes(1);
      const blob = (storage.addFile as any).mock.calls[0][1] as Blob;
      const text = await blob.text();
      expect(text).toContain("テスト");
      expect(text).not.toContain("\uFFFD"); // no mojibake replacement chars
    });

    it("decodes Shift_JIS via the @charset rule when the header has no charset", async () => {
      configureEnqueue((url) =>
        makeResult(shiftJisBytes(true), "text/css", url),
      );

      await addCssFiles(
        ["https://host/jp/page.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const blob = (storage.addFile as any).mock.calls[0][1] as Blob;
      const text = await blob.text();
      expect(text).toContain('@charset "Shift_JIS";');
      expect(text).toContain("テスト");
      expect(text).not.toContain("\uFFFD");
    });

    it("decodes iso-8859-1 via the @charset rule (spec scenario)", async () => {
      const bytes = Uint8Array.from([
        ...new TextEncoder().encode('@charset "iso-8859-1";\n.a{content:"caf'),
        0xe9, // é in ISO-8859-1
        ...new TextEncoder().encode('"}'),
      ]);
      configureEnqueue((url) => makeResult(bytes, "text/css", url));

      await addCssFiles(
        ["https://host/latin/page.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const blob = (storage.addFile as any).mock.calls[0][1] as Blob;
      const text = await blob.text();
      expect(text).toContain("café");
    });

    it("falls back to UTF-8 when no charset is declared anywhere", async () => {
      configureEnqueue((url) =>
        makeResult(cssBytes(".a{content:'ü'}"), "text/css", url),
      );

      await addCssFiles(
        ["https://host/plain.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const blob = (storage.addFile as any).mock.calls[0][1] as Blob;
      await expect(blob.text()).resolves.toBe(".a{content:'ü'}");
    });

    it("decodes from raw snapshot bytes (a response.text() UTF-8 pass would mojibake)", async () => {
      // Shift_JIS bytes with an @charset rule and NO charset header: only a
      // bytes-based decoder that honors @charset can round-trip this.
      const sjis = Uint8Array.from([
        ...new TextEncoder().encode('@charset "Shift_JIS";\nbody::before{content:"'),
        0x83, 0x65, 0x83, 0x58, 0x83, 0x67, // テスト
        ...new TextEncoder().encode('";}'),
      ]);
      configureEnqueue((url) => makeResult(sjis, "text/css", url));

      await addCssFiles(
        ["https://host/jp/page.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const blob = (storage.addFile as any).mock.calls[0][1] as Blob;
      const text = await blob.text();
      expect(text).toContain("テスト");
      expect(text).not.toContain("\uFFFD");
    });
  });

  // ------------------------------------------------------------------------
  // Task 2.4 — opaque responses fail cleanly
  // ------------------------------------------------------------------------

  describe("opaque responses (task 2.4)", () => {
    it("records a categorized cors failure and uploads nothing", async () => {
      const opaque = makeOpaqueResult("https://host/blocked.css");
      const responseSpy = vi.spyOn(opaque, "response", "get");
      configureEnqueue(() => opaque);

      await addCssFiles(
        ["https://host/blocked.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(responseSpy).not.toHaveBeenCalled();
      expect(storage.addFile).not.toHaveBeenCalled();

      const summary = messages.find(
        (m) => typeof m === "object" && m.key === "status.cssSummary",
      );
      expect(summary).toBeDefined();
      expect(summary.options.failed).toBe(1);
      expect(summary.options.failureCategories).toEqual({ cors: 1 });
    });

    it("records queue failures with their RequestQueueError category", async () => {
      configureEnqueue(
        () =>
          new RequestQueueError("HTTP 404: Not Found", "http", { status: 404 }),
      );

      await addCssFiles(
        ["https://host/missing.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const summary = messages.find(
        (m) => typeof m === "object" && m.key === "status.cssSummary",
      );
      expect(summary.options.failed).toBe(1);
      expect(summary.options.failureCategories).toEqual({ http: 1 });
    });

    it("keeps processing the remaining stylesheets after an opaque failure", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/blocked.css": makeOpaqueResult("https://host/blocked.css"),
        "https://host/fine.css": okCss(".fine{}")("https://host/fine.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/blocked.css", "https://host/fine.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/fine.css",
        expect.any(Blob),
        "text/css",
      );
      const summary = messages.find(
        (m) => typeof m === "object" && m.key === "status.cssSummary",
      );
      expect(summary.options.succeeded).toBe(1);
      expect(summary.options.failed).toBe(1);
    });
  });

  // ------------------------------------------------------------------------
  // url() extraction robustness + scheme filtering
  // ------------------------------------------------------------------------

  describe("url() extraction", () => {
    it("captures quoted URLs containing parentheses", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        if (url.endsWith(".css")) {
          return okCss(
            '.a{background-image:url("foo(bar).png")}' +
              ".b{background:url('a)b.png')}" +
              ".c{background:url(plain.png)}",
          )(url);
        }
        return makeResult(new Uint8Array([1]), "image/png", url);
      });

      await addCssFiles(
        ["https://host/styles/main.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(fetched).toContain("https://host/styles/foo(bar).png");
      expect(fetched).toContain("https://host/styles/a)b.png");
      expect(fetched).toContain("https://host/styles/plain.png");
    });

    it("never fetches CSS url(#fragment) references", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        return okCss(".a{background:url(#gradient);color:red}", undefined)(url);
      });

      await addCssFiles(
        ["https://host/svg.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      // Only the stylesheet itself is fetched — no #gradient resource.
      expect(fetched).toEqual(["https://host/svg.css"]);
      expect(fetched.some((u) => u.includes("#gradient"))).toBe(false);
    });

    it("skips data: and blob: references in CSS url()", async () => {
      const fetched: string[] = [];
      configureEnqueue((url) => {
        fetched.push(url);
        return okCss(
          ".a{background:url(data:image/png;base64,AAAA)}" +
            ".b{background:url(blob:https://host/uuid)}",
        )(url);
      });

      await addCssFiles(
        ["https://host/inline.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(fetched).toEqual(["https://host/inline.css"]);
    });
  });

  // ------------------------------------------------------------------------
  // Task 3.4 — @import extraction
  // ------------------------------------------------------------------------

  describe("@import extraction (task 3.4)", () => {
    it("downloads a nested import chain (url form + string form)", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/css/main.css": okCss(
          '@import url("theme.css");',
        )("https://host/css/main.css"),
        "https://host/css/theme.css": okCss(
          '@import "reset.css";',
        )("https://host/css/theme.css"),
        "https://host/css/reset.css": okCss(
          "*{margin:0}",
        )("https://host/css/reset.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/css/main.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/css/main.css",
        expect.any(Blob),
        "text/css",
      );
      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/css/theme.css",
        expect.any(Blob),
        "text/css",
      );
      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/css/reset.css",
        expect.any(Blob),
        "text/css",
      );
      // Imported stylesheets are uploaded to the styles bucket exactly once
      // each — they are not also fetched as url() "background images".
      const paths = (storage.addFile as any).mock.calls.map((c) => c[0]);
      expect(paths.filter((p: string) => p.startsWith("styles/css/"))).toHaveLength(3);
      expect(paths.filter((p: string) => p.startsWith("images/"))).toHaveLength(0);
    });

    it("resolves import targets against the importing stylesheet's URL", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/dir/css/main.css": okCss(
          '@import url(pieces/x.css);',
        )("https://host/dir/css/main.css"),
        "https://host/dir/css/pieces/x.css": okCss(
          ".x{}",
        )("https://host/dir/css/pieces/x.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/dir/css/main.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://host/dir/css/pieces/x.css" }),
      );
      expect(storage.addFile).toHaveBeenCalledWith(
        "styles/dir/css/pieces/x.css",
        expect.any(Blob),
        "text/css",
      );
    });

    it("downloads each side of an import cycle exactly once", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/a.css": okCss(
          '@import url("b.css");',
        )("https://host/a.css"),
        "https://host/b.css": okCss(
          '@import url("a.css");',
        )("https://host/b.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/a.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      // Each stylesheet uploaded exactly once despite the cycle.
      const paths = (storage.addFile as any).mock.calls.map((c) => c[0]);
      expect(paths.sort()).toEqual(["styles/a.css", "styles/b.css"]);
      // The cycle terminates: a.css enqueued once, b.css once.
      const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
      expect(enqueuedUrls.filter((u) => u === "https://host/a.css")).toHaveLength(1);
      expect(enqueuedUrls.filter((u) => u === "https://host/b.css")).toHaveLength(1);
    });

    it("stops recursion at the depth cap of 3", async () => {
      // c0 → c1 → c2 → c3 → c4: with a cap of 3, c0..c3 download but c4
      // (a 4th-level import) is never fetched.
      const byUrl: Record<string, RequestResult | Error> = {};
      for (let i = 0; i <= 4; i++) {
        const url = `https://host/c${i}.css`;
        const next = i < 4 ? `@import url("c${i + 1}.css");` : "";
        byUrl[url] = okCss(next)(url);
      }
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/c0.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
      expect(enqueuedUrls).toContain("https://host/c3.css");
      expect(enqueuedUrls).not.toContain("https://host/c4.css");
      const paths = (storage.addFile as any).mock.calls.map((c) => c[0]);
      expect(paths).toContain("styles/c3.css");
      expect(paths).not.toContain("styles/c4.css");
    });

    it("dedups the same imported stylesheet referenced repeatedly", async () => {
      const byUrl: Record<string, RequestResult | Error> = {
        "https://host/page.css": okCss(
          '@import url("shared.css");@import url("shared.css");',
        )("https://host/page.css"),
        "https://host/shared.css": okCss(
          ".shared{}",
        )("https://host/shared.css"),
      };
      configureEnqueue((url) => byUrl[url]);

      await addCssFiles(
        ["https://host/page.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
      expect(
        enqueuedUrls.filter((u) => u === "https://host/shared.css"),
      ).toHaveLength(1);
    });

    it("skips data: imports and never enqueues them", async () => {
      configureEnqueue(
        okCss('@import url("data:text/css,body{}");.a{}'),
      );

      await addCssFiles(
        ["https://host/only.css"],
        storage,
        "https://host/page.html",
        (m) => messages.push(m),
      );

      const enqueuedUrls = mockEnqueue.mock.calls.map((c) => c[0].url);
      expect(enqueuedUrls).toEqual(["https://host/only.css"]);
    });
  });
});
