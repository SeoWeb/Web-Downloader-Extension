/**
 * @vitest-environment jsdom
 *
 * UI tests for the reworked scraping options ("Full Scraping" first level).
 *
 * The old "Download links" checkbox (legacy simple-fetch mode) is gone:
 *  - no downloadLinks checkbox is rendered anymore,
 *  - "Full Scraping" (downloadLinksFullScraping) is the first-level toggle
 *    and owns the max-pages / delay / include-external controls,
 *  - the "Download Full Website" preset derives from
 *    downloadHTML + downloadAssets + downloadLinksFullScraping,
 *  - singleFile forces the crawl flag off (one file, no crawling).
 *
 * Same harness as filter-text-only.test.tsx: jsdom + createRoot + act, the
 * filter STORE is mocked (so the real useFilterOptions mapping runs), and
 * react-i18next resolves labels through the real en.json.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Filter renders PagePocketToggle → pagepocketStore, which registers a
// chrome.storage.onChanged listener at module load. setup.cjs mocks
// storage.local only — add onChanged BEFORE importing the component tree
// (dynamic import; same pattern as filter-text-only.test.tsx).
if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const storeMocks = vi.hoisted(() => {
  const defaultOptions = () => ({
    downloadHTML: true,
    downloadImages: true,
    downloadLinks: false,
    downloadAssets: true,
    downloadContentAsText: false,
    downloadContentAsMarkdown: false,
    downloadDocuments: true,
    singleFile: false,
    alwaysAskWhereToSave: true,
  });
  return {
    options: defaultOptions() as Record<string, any>,
    defaultOptions,
    setFilterOption: vi.fn(),
    setAllOptions: vi.fn(),
    resetToDefaults: vi.fn(),
    initializeFromStorage: vi.fn(),
    clearStorageError: vi.fn(),
    hasAnyContentSelected: vi.fn(() => true),
    isValidConfiguration: vi.fn(() => true),
  };
});

vi.mock("../../src/stores/filterStore", () => ({
  useFilterStore: () => ({
    options: storeMocks.options,
    isLoading: false,
    isInitialized: true,
    hasStorageError: false,
    storageErrorMessage: null,
    setFilterOption: storeMocks.setFilterOption,
    setAllOptions: storeMocks.setAllOptions,
    resetToDefaults: storeMocks.resetToDefaults,
    initializeFromStorage: storeMocks.initializeFromStorage,
    clearStorageError: storeMocks.clearStorageError,
    hasAnyContentSelected: storeMocks.hasAnyContentSelected,
    isValidConfiguration: storeMocks.isValidConfiguration,
  }),
}));

vi.mock("react-i18next", async () => {
  const en = (await import("../../src/i18n/locales/en.json")).default;
  const t = (key: string) => {
    let cur: any = en.translation ?? en;
    for (const part of key.split(".")) cur = cur?.[part];
    return typeof cur === "string" ? cur : key;
  };
  return { useTranslation: () => ({ t }) };
});

const { default: Filter } = await import("../../src/components/Filter");

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const enJson = (await import("../../src/i18n/locales/en.json")).default as any;
const LABEL = {
  fullScraping: enJson.translation.filter.fullScraping as string,
  fullScrapingInfo: enJson.translation.filter.fullScrapingInfo as string,
  maxPages: enJson.translation.filter.maxPages as string,
  pageDelay: enJson.translation.filter.pageDelay as string,
  includeExternal: enJson.translation.filter.includeExternal as string,
  legacyDownloadLinks: enJson.translation.filter.downloadLinks as string,
  legacyLinksWarning: enJson.translation.filter.linksWarning as string,
};

// ---------------------------------------------------------------------------
// Minimal render harness (createRoot + act + dispatched bubbling events)
// ---------------------------------------------------------------------------

function renderFilter() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () =>
    act(() => {
      root.render(<Filter download={vi.fn()} tabUrl="https://example.com" />);
    });
  render();

  return {
    container,
    checkbox: (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `button[role="checkbox"]#${id}`,
      ),
    rerender: render,
    click: (el: Element) =>
      act(() => {
        el.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function fullScrapingOn(): Record<string, any> {
  return { ...storeMocks.defaultOptions(), downloadLinksFullScraping: true };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Filter — legacy downloadLinks checkbox removed", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("renders no downloadLinks checkbox or warning, with fullScraping on or off", () => {
    for (const options of [storeMocks.defaultOptions(), fullScrapingOn()]) {
      storeMocks.options = options;
      const ui = renderFilter();

      expect(ui.checkbox("downloadLinks")).toBeNull();
      expect(
        ui.container.querySelector('label[for="downloadLinks"]'),
      ).toBeNull();
      // Legacy label and the removed simple-mode warning are gone everywhere
      expect(ui.container.textContent).not.toContain(LABEL.legacyDownloadLinks);
      expect(ui.container.textContent).not.toContain(LABEL.legacyLinksWarning);

      ui.unmount();
    }
  });
});

describe("Filter — Full Scraping first-level toggle owns the crawl controls", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("hides maxPages/delay/external while fullScraping is off", () => {
    storeMocks.options = storeMocks.defaultOptions();
    const ui = renderFilter();

    expect(ui.checkbox("downloadLinksFullScraping")).not.toBeNull();
    expect(ui.container.querySelectorAll('input[type="range"]')).toHaveLength(
      0,
    );
    expect(ui.checkbox("linkedPagesIncludeExternal")).toBeNull();
    expect(ui.container.textContent).not.toContain(LABEL.maxPages);
    expect(ui.container.textContent).not.toContain(LABEL.pageDelay);

    ui.unmount();
  });

  it("shows maxPages/delay/external directly when fullScraping is on", () => {
    storeMocks.options = fullScrapingOn();
    const ui = renderFilter();

    expect(ui.container.querySelectorAll('input[type="range"]')).toHaveLength(
      2,
    );
    expect(ui.checkbox("linkedPagesIncludeExternal")).not.toBeNull();
    expect(ui.container.textContent).toContain(LABEL.maxPages);
    expect(ui.container.textContent).toContain(LABEL.pageDelay);
    expect(ui.container.textContent).toContain(LABEL.includeExternal);
    // The label + info text render once, on the first-level row
    expect(ui.container.textContent).toContain(LABEL.fullScraping);
    expect(ui.container.textContent).toContain(LABEL.fullScrapingInfo);

    ui.unmount();
  });

  it("toggling fullScraping shows and hides the crawl controls", () => {
    storeMocks.options = storeMocks.defaultOptions();
    const ui = renderFilter();

    // OFF → ON
    ui.click(ui.checkbox("downloadLinksFullScraping")!);
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadLinksFullScraping",
      true,
    );
    storeMocks.options = fullScrapingOn();
    ui.rerender();
    expect(ui.container.querySelectorAll('input[type="range"]')).toHaveLength(
      2,
    );
    expect(ui.checkbox("linkedPagesIncludeExternal")).not.toBeNull();

    // ON → OFF
    ui.click(ui.checkbox("downloadLinksFullScraping")!);
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadLinksFullScraping",
      false,
    );
    storeMocks.options = storeMocks.defaultOptions();
    ui.rerender();
    expect(ui.container.querySelectorAll('input[type="range"]')).toHaveLength(
      0,
    );
    expect(ui.checkbox("linkedPagesIncludeExternal")).toBeNull();

    ui.unmount();
  });
});

describe("Filter — Download Full Website preset", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("checks when HTML + assets + fullScraping are all on, unchecked otherwise", () => {
    storeMocks.options = fullScrapingOn();
    const ui = renderFilter();
    expect(ui.checkbox("fullWebsite")!.getAttribute("aria-checked")).toBe(
      "true",
    );
    ui.unmount();

    // Any missing leg (here: crawl flag off) leaves it unchecked
    storeMocks.options = storeMocks.defaultOptions();
    const ui2 = renderFilter();
    expect(ui2.checkbox("fullWebsite")!.getAttribute("aria-checked")).toBe(
      "false",
    );
    ui2.unmount();
  });

  it("turning the preset on sets html+assets+crawling and turns singleFile off", () => {
    storeMocks.options = storeMocks.defaultOptions();
    const ui = renderFilter();

    ui.click(ui.checkbox("fullWebsite")!);

    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "singleFile",
      false,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadHTML",
      true,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadAssets",
      true,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadLinksFullScraping",
      true,
    );
    // The legacy key is never written by the UI
    const legacyWrite = storeMocks.setFilterOption.mock.calls.find(
      ([key]) => key === "downloadLinks",
    );
    expect(legacyWrite).toBeUndefined();

    ui.unmount();
  });

  it("turning the preset off only clears the crawl flag", () => {
    storeMocks.options = fullScrapingOn();
    const ui = renderFilter();

    ui.click(ui.checkbox("fullWebsite")!);

    expect(storeMocks.setFilterOption).toHaveBeenCalledTimes(1);
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadLinksFullScraping",
      false,
    );
    const legacyWrite = storeMocks.setFilterOption.mock.calls.find(
      ([key]) => key === "downloadLinks",
    );
    expect(legacyWrite).toBeUndefined();

    ui.unmount();
  });
});

describe("Filter — singleFile disables crawling", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("checking singleFile forces downloadLinksFullScraping off", () => {
    storeMocks.options = fullScrapingOn();
    const ui = renderFilter();

    ui.click(ui.checkbox("singleFile")!);

    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadLinksFullScraping",
      false,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith("singleFile", true);

    ui.unmount();
  });
});
