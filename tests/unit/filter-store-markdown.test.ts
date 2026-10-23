/**
 * Filter-store validation matrix for the Markdown option
 * (download-as-markdown task 3.8 / design D5 + D7).
 *
 * Gating semantics under test:
 * - `downloadContentAsMarkdown` counts as a content selection on its own
 *   (satisfies the nothing-selected guard);
 * - it is independent of `downloadContentAsText` (no coupling);
 * - singleFile forces it off like every other granular option;
 * - with nothing selected at all the configuration stays invalid.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// chrome mock — setup.cjs provides storage.local only; filterStore
// registers a storage.onChanged listener at module load (same pattern as
// pagepocket-store-init.test.ts).
// ---------------------------------------------------------------------------

if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { DEFAULT_FILTER_OPTIONS } = await import("../../src/types/filterTypes");
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

describe("filterStore — downloadContentAsMarkdown", () => {
  beforeEach(() => {
    useFilterStore.setState({
      options: { ...DEFAULT_FILTER_OPTIONS },
      isLoading: false,
      isInitialized: true,
      hasStorageError: false,
      storageErrorMessage: null,
    });
  });

  it("markdown alone counts as a content selection — download allowed", () => {
    useFilterStore
      .getState()
      .setAllOptions({ ...allOff(), downloadContentAsMarkdown: true });

    const { options, hasAnyContentSelected, isValidConfiguration } =
      useFilterStore.getState();

    // Kept as-is (hasContent passes via markdown) — no default re-enable.
    expect(options.downloadContentAsMarkdown).toBe(true);
    expect(options.downloadHTML).toBe(false);
    expect(hasAnyContentSelected()).toBe(true);
    expect(isValidConfiguration()).toBe(true);
  });

  it("markdown and text are independent — both can be on", () => {
    useFilterStore.getState().setAllOptions({
      ...allOff(),
      downloadContentAsText: true,
      downloadContentAsMarkdown: true,
    });

    const { options } = useFilterStore.getState();
    expect(options.downloadContentAsText).toBe(true);
    expect(options.downloadContentAsMarkdown).toBe(true);
  });

  it("turning HTML off does not clear markdown or force the text fallback", () => {
    useFilterStore
      .getState()
      .setAllOptions({ ...allOff(), downloadContentAsMarkdown: true });

    const { options } = useFilterStore.getState();
    expect(options.downloadHTML).toBe(false);
    expect(options.downloadContentAsMarkdown).toBe(true);
    expect(options.downloadContentAsText).toBe(false);
  });

  it("singleFile forces markdown off like the other granular options", () => {
    useFilterStore.getState().setAllOptions({
      ...DEFAULT_FILTER_OPTIONS,
      downloadContentAsMarkdown: true,
      singleFile: true,
    });

    const { options } = useFilterStore.getState();
    expect(options.singleFile).toBe(true);
    expect(options.downloadContentAsMarkdown).toBe(false);
  });

  it("nothing selected at all is invalid (raw state bypasses validation)", () => {
    // Raw setState simulates unvalidated state so the guard itself is
    // observable — validation would auto-recover by enabling defaults.
    useFilterStore.setState({ options: allOff() });

    expect(useFilterStore.getState().hasAnyContentSelected()).toBe(false);
    expect(useFilterStore.getState().isValidConfiguration()).toBe(false);

    // Markdown alone (raw state) satisfies the guard.
    useFilterStore.setState({
      options: { ...allOff(), downloadContentAsMarkdown: true },
    });
    expect(useFilterStore.getState().hasAnyContentSelected()).toBe(true);
    expect(useFilterStore.getState().isValidConfiguration()).toBe(true);
  });
});
