/**
 * @vitest-environment jsdom
 *
 * (multipage-download-fixes 5.8) 413 session-full early exit communicates
 * partial capture.
 *
 * DEFECT AT HEAD: when the linked-page loop exits via the 413 session-full
 * early exit, the run completes with an unqualified "Done!" — nothing tells
 * the user the queue was truncated by the size limit.
 *
 * NEW CONTRACT: the scraper pushes `status.sessionFullPagesCaptured`
 * (captured vs queue total, reuse of the existing PANEL_MESSAGE plumbing)
 * on the 413 exit; the download report stores it as `pagesPartial` and the
 * completed card renders a small honest note.
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import { messageActions } from "../../src/common/message";
import { LinkedPageScraper } from "../../src/background/linked-page-scraper";
import { AssetRegistry } from "../../src/background/asset-registry";
import { DownloadComplete } from "../../src/sidepanel/components/DownloadComplete";
import {
  applyDownloadReportMessage,
  initialDownloadReport,
} from "../../src/sidepanel/utils/downloadReport";

// ---------------------------------------------------------------------------
// Chrome mock serving BOTH parts: the scraper harness (tabs + scripting)
// and the completed card (storage.local + downloads).
// ---------------------------------------------------------------------------

const mockChromeTabsGet = vi.fn();
const mockChromeTabsUpdate = vi.fn();
const mockChromeTabsOnUpdated = {
  addListener: vi.fn(),
  removeListener: vi.fn(),
};
const mockChromeScriptingExecuteScript = vi.fn();
const downloadsShow = vi.fn();

Object.defineProperty(globalThis, "chrome", {
  value: {
    tabs: {
      get: mockChromeTabsGet,
      update: mockChromeTabsUpdate,
      onUpdated: mockChromeTabsOnUpdated,
    },
    scripting: {
      executeScript: mockChromeScriptingExecuteScript,
    },
    storage: {
      local: {
        get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) =>
          cb({}),
        set: (_items: unknown, cb?: () => void) => cb?.(),
      },
    },
    downloads: { show: downloadsShow },
  },
  writable: true,
});

vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    uploadHtmlChunk: vi.fn(),
    uploadFilenameMap: vi.fn().mockResolvedValue({}),
    uploadContent: vi.fn(),
    uploadPageContent: vi.fn().mockResolvedValue({}),
  },
  HttpError: class HttpError extends Error {
    constructor(
      msg: string,
      public statusCode: number,
    ) {
      super(msg);
    }
  },
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
  AssemblyTimeoutError: class extends Error {},
}));

vi.mock("../../src/background/resources", () => ({
  getResources: vi.fn(() => ({
    css: [],
    js: [],
    images: [],
    documents: [],
    links: [],
    text: "page text",
  })),
}));

vi.mock("../../src/background/fileHandlers", () => ({
  addCssFiles: vi.fn(async () => new Map()),
  addJsFiles: vi.fn(async () => new Map()),
  addImageFiles: vi.fn(async () => new Map()),
  addDocumentFiles: vi.fn(async () => new Map()),
}));

// i18n resolves through the REAL en.json (per download-complete-close harness).
const translation = (en as { translation: Record<string, unknown> })
  .translation;

function resolveKey(key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc !== null && typeof acc === "object"
          ? (acc as Record<string, unknown>)[part]
          : undefined,
      translation,
    );
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: unknown) => {
      const value = resolveKey(key);
      const str =
        typeof value === "string"
          ? value
          : typeof defaultValueOrOptions === "string"
            ? defaultValueOrOptions
            : key;
      const opts =
        typeof defaultValueOrOptions === "object" &&
        defaultValueOrOptions !== null
          ? (defaultValueOrOptions as Record<string, unknown>)
          : {};
      // Interpolate {{name}} like i18next would.
      return str.replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
        opts[name] !== undefined ? String(opts[name]) : _m,
      );
    },
  }),
}));

vi.mock("../../src/common/chrome", () => ({
  sendMessage: vi.fn(async () => {}),
}));

vi.mock("../../src/components/ChromeExtensionRating", () => ({
  default: () => null,
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { serverClient, HttpError } from "../../src/background/server-client";

// ---------------------------------------------------------------------------
// Part 1 — scraper pushes the note on the 413 exit (asset-gating harness)
// ---------------------------------------------------------------------------

function mockScraperTabFlow() {
  mockChromeTabsGet.mockResolvedValue({ url: "https://example.com/start" });
  mockChromeTabsUpdate.mockImplementation((_tabId: any, opts: any) => {
    const calls = mockChromeTabsOnUpdated.addListener.mock.calls;
    const listener = calls[calls.length - 1]?.[0];
    if (listener) {
      setTimeout(
        () => listener(1, { status: "complete" }, { url: opts.url }),
        0,
      );
    }
    return Promise.resolve();
  });
  mockChromeScriptingExecuteScript.mockImplementation((opts: any) => {
    if (opts.args) return Promise.resolve([{ result: null }]);
    return Promise.resolve([
      {
        result: {
          skeleton: "<html><head></head><body></body></html>",
          bodyChildren: ["<div>x</div>"],
        },
      },
    ]);
  });
}

describe("413 session-full partial note — scraper push (5.8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScraperTabFlow();
  });

  it("the scraper pushes captured/total counts on the 413 early exit", async () => {
    // Page 1 uploads fine; page 2 hits the session size limit (413).
    vi.mocked(serverClient.uploadHtmlChunk)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(
        new HttpError("Session size limit exceeded", 413) as never,
      );

    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-413",
    });
    const sendMessage = vi.fn();

    for (const path of ["about", "contact"]) {
      await scraper.addToQueue({
        url: `https://example.com/${path}`,
        depth: 1,
        parentUrl: "https://example.com",
        status: "queued",
      });
    }
    await scraper.processQueue(1, { addFile: vi.fn() }, sendMessage);

    const note = sendMessage.mock.calls.find(
      (call) =>
        (call[0] as { key?: string })?.key ===
        "status.sessionFullPagesCaptured",
    );
    expect(note).toBeDefined();
    expect((note![0] as { options?: any }).options).toEqual({
      captured: 1, // page 1 captured before the limit hit
      total: 2, // both queued pages
    });

    // The loop exited early and the run completes with the ordinary
    // summary — the note is additive.
    const complete = sendMessage.mock.calls.find(
      (call) =>
        (call[0] as { key?: string })?.key === "status.linkedPagesComplete",
    );
    expect(complete).toBeDefined();
  });

  it("a clean run pushes NO partial note", async () => {
    vi.mocked(serverClient.uploadHtmlChunk).mockResolvedValue({} as never);

    const scraper = new LinkedPageScraper(new AssetRegistry(), {
      maxPages: 5,
      delayBetweenPages: 0,
      pageTimeout: 5000,
      serverSessionId: "sess-ok",
    });
    const sendMessage = vi.fn();

    await scraper.addToQueue({
      url: "https://example.com/about",
      depth: 1,
      parentUrl: "https://example.com",
      status: "queued",
    });
    await scraper.processQueue(1, { addFile: vi.fn() }, sendMessage);

    const note = sendMessage.mock.calls.find(
      (call) =>
        (call[0] as { key?: string })?.key ===
        "status.sessionFullPagesCaptured",
    );
    expect(note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the report layer stores the counts; the completed card renders
// the note.
// ---------------------------------------------------------------------------

describe("download report + completed card note (5.8)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("the report stores pagesPartial from status.sessionFullPagesCaptured", () => {
    const next = applyDownloadReportMessage(
      initialDownloadReport,
      "status.sessionFullPagesCaptured",
      { captured: 1, total: 8 },
    );
    expect(next.pagesPartial).toEqual({ captured: 1, total: 8 });
  });

  it("other messages leave pagesPartial null", () => {
    const next = applyDownloadReportMessage(
      initialDownloadReport,
      "status.uploadProgress",
      { completed: 1, total: 2 },
    );
    expect(next.pagesPartial).toBeNull();
  });

  it("the completed card renders the captured/total note", async () => {
    const report = applyDownloadReportMessage(
      initialDownloadReport,
      "status.sessionFullPagesCaptured",
      { captured: 1, total: 8 },
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DownloadComplete, {
          tabId: 1,
          tabUrl: "https://example.com",
          links: [],
          action: messageActions.DOWNLOAD_DONE,
          reset: () => {},
          downloadReport: report,
          failedUploads: 0,
        }),
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("1");
    expect(text).toContain("8");
    // The note's prefix text (up to the interpolation) is present.
    expect(text).toContain(
      String(resolveKey("status.sessionFullPagesCaptured")).split("{{")[0],
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("a clean completion renders no partial note", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DownloadComplete, {
          tabId: 1,
          tabUrl: "https://example.com",
          links: [],
          action: messageActions.DOWNLOAD_DONE,
          reset: () => {},
          downloadReport: initialDownloadReport,
          failedUploads: 0,
        }),
      );
    });

    expect(container.textContent).not.toContain(
      String(resolveKey("status.sessionFullPagesCaptured")).split("{{")[0],
    );
    await act(async () => {
      root.unmount();
    });
  });
});
