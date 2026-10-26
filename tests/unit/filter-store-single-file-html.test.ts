/**
 * Single-file mode must produce a self-contained HTML download (single-
 * file-is-HTML fix + resource inlining).
 *
 * The single-file output is one self-contained HTML file: it is an HTML
 * download (forcing downloadHTML off used to route server-mode sessions
 * into text-only assembly, which fails), and its images and CSS/JS/font
 * assets MUST be scraped and uploaded — the server inlines them as base64
 * data URIs. Without those uploads the output is plain HTML with broken
 * references.
 *
 * Gating semantics under test:
 * - selecting singleFile forces downloadHTML, downloadImages, and
 *   downloadAssets on, and every other granular format off (store
 *   validation);
 * - legacy stored state (singleFile=true, downloadHTML=false) is repaired
 *   on load, since initializeFromStorage re-validates stored options;
 * - a later downloadHTML=false write cannot turn HTML off while
 *   singleFile is active; likewise images cannot be turned off;
 * - singleFile state is never text-only (isTextOnlyDownload);
 * - text-only selections still neutralize singleFile in outgoing options
 *   (normalizeTextOnlyOptions).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// chrome mock — setup.cjs provides storage.local only; filterStore
// registers a storage.onChanged listener at module load (same pattern as
// filter-store-markdown.test.ts).
// ---------------------------------------------------------------------------

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { DEFAULT_FILTER_OPTIONS, isTextOnlyDownload, normalizeTextOnlyOptions } =
  await import("../../src/types/filterTypes");
const { useFilterStore } = await import("../../src/stores/filterStore");

/** Every content option off (defaults spread in for the optional keys). */
function allOff() {
  return {
    ...DEFAULT_FILTER_OPTIONS,
    downloadHTML: false,
    downloadImages: false,
    downloadLinks: false,
    downloadAssets: false,
    downloadContentAsText: false,
    downloadContentAsMarkdown: false,
    downloadDocuments: false,
    singleFile: false,
  };
}

describe("filterStore — singleFile implies downloadHTML", () => {
  beforeEach(() => {
    useFilterStore.setState({
      options: { ...DEFAULT_FILTER_OPTIONS },
      isLoading: false,
      isInitialized: true,
      hasStorageError: false,
      storageErrorMessage: null,
    });
  });

  it("selecting singleFile keeps HTML, images, and assets on and every other granular format off", () => {
    useFilterStore.getState().setAllOptions({
      ...DEFAULT_FILTER_OPTIONS,
      downloadImages: true,
      downloadLinks: true,
      downloadAssets: true,
      downloadContentAsText: true,
      downloadContentAsMarkdown: true,
      downloadDocuments: true,
      downloadLinksFullScraping: true,
      singleFile: true,
    });

    const { options } = useFilterStore.getState();
    expect(options.singleFile).toBe(true);
    expect(options.downloadHTML).toBe(true); // the fix — HTML stays on
    // The fix — images and assets are scraped and uploaded so the server
    // can inline them as base64 data URIs.
    expect(options.downloadImages).toBe(true);
    expect(options.downloadAssets).toBe(true);
    expect(options.downloadLinks).toBe(false);
    expect(options.downloadLinksFullScraping).toBe(false); // one file, no crawling
    expect(options.downloadContentAsText).toBe(false);
    expect(options.downloadContentAsMarkdown).toBe(false);
    expect(options.downloadDocuments).toBe(false);
  });

  it("keeps crawling allowed in text-only mode (HTML off + a text format on)", () => {
    useFilterStore.getState().setAllOptions({
      ...allOff(),
      downloadContentAsText: true,
      downloadLinksFullScraping: true,
    });

    const { options } = useFilterStore.getState();
    expect(options.downloadHTML).toBe(false);
    expect(options.downloadContentAsText).toBe(true);
    // The HTML-off branch must NOT clear the crawl flag
    expect(options.downloadLinksFullScraping).toBe(true);
  });

  it("repairs legacy stored state of singleFile=true with downloadHTML=false", () => {
    // initializeFromStorage re-validates whatever loadFilterOptions
    // returns, so stale storage with HTML off is corrected on load.
    useFilterStore.getState().setAllOptions({
      ...allOff(),
      singleFile: true,
    });

    const { options } = useFilterStore.getState();
    expect(options.singleFile).toBe(true);
    expect(options.downloadHTML).toBe(true);
  });

  it("cannot turn HTML or images off via setFilterOption while singleFile is active", () => {
    useFilterStore
      .getState()
      .setAllOptions({ ...DEFAULT_FILTER_OPTIONS, singleFile: true });

    useFilterStore.getState().setFilterOption("downloadHTML", false);
    useFilterStore.getState().setFilterOption("downloadImages", false);

    const { options } = useFilterStore.getState();
    expect(options.singleFile).toBe(true);
    expect(options.downloadHTML).toBe(true);
    expect(options.downloadImages).toBe(true); // neutralized back to true
    expect(options.downloadAssets).toBe(true);
  });

  it("singleFile state is not text-only, so the toggle stays applicable", () => {
    useFilterStore
      .getState()
      .setAllOptions({ ...DEFAULT_FILTER_OPTIONS, singleFile: true });

    expect(isTextOnlyDownload(useFilterStore.getState().options)).toBe(false);
  });

  it("text-only selections still neutralize singleFile in outgoing options", () => {
    const outgoing = normalizeTextOnlyOptions({
      ...allOff(),
      downloadContentAsText: true,
      singleFile: true,
    });

    expect(outgoing.singleFile).toBe(false);
    expect(outgoing.downloadHTML).toBe(false);
    expect(outgoing.downloadContentAsText).toBe(true);
  });
});
