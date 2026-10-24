/**
 * @vitest-environment jsdom
 *
 * UI + payload tests for the text-only download mode
 * (text-native-downloads D7 / "Inapplicable toggles disabled in the UI").
 *
 * When HTML is off and a text format (markdown/content-as-text) is the
 * only output:
 *  - the images/assets/documents/single-file toggles render DISABLED
 *    (not hidden) with a short hardcoded English hint,
 *  - re-checking HTML re-enables them,
 *  - the disabled toggles' stored values are neutralized in the OUTGOING
 *    download options (useDownloadOptions → normalizeTextOnlyOptions).
 *
 * Rendered with react-dom/client directly (no @testing-library/react —
 * not a project dependency), against a jsdom document — same harness as
 * filter-markdown-checkbox.test.tsx. The filter STORE is mocked (not the
 * hooks), so the real useFilterOptions/useDownloadOptions mapping runs.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Filter renders PagePocketToggle → pagepocketStore, which registers a
// chrome.storage.onChanged listener at module load. setup.cjs mocks
// storage.local only — add onChanged BEFORE importing the component tree
// (dynamic import; same pattern as filter-markdown-checkbox.test.tsx).
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

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const { default: Filter } = await import("../../src/components/Filter");
const { useDownloadOptions } = await import("../../src/hooks/useFilterOptions");
const { isTextOnlyDownload, normalizeTextOnlyOptions } =
  await import("../../src/types/filterTypes");

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT_ONLY_HINT = "Not applicable to text-only downloads";

/** The four toggles that are inapplicable to text-only downloads. */
const TEXT_ONLY_DISABLED_IDS = [
  "downloadImages",
  "downloadAssets",
  "downloadDocuments",
  "singleFile",
] as const;

/** Options for a text-only selection: HTML off, markdown on, with the
 * previously-stored granular preferences still set (they must be ignored). */
function textOnlyOptions(): Record<string, any> {
  return {
    ...storeMocks.defaultOptions(),
    downloadHTML: false,
    downloadImages: true, // stored user preference — must be neutralized
    downloadAssets: false,
    downloadDocuments: true, // stored user preference — must be neutralized
    downloadContentAsMarkdown: true,
  };
}

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

/** Render a probe component that captures the outgoing download options. */
function renderDownloadOptionsProbe() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let captured: ReturnType<typeof useDownloadOptions> | undefined;

  function Probe() {
    captured = useDownloadOptions();
    return null;
  }
  const render = () =>
    act(() => {
      root.render(<Probe />);
    });
  render();

  return {
    value: () => captured,
    rerender: render,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests — UI (6.3)
// ---------------------------------------------------------------------------

describe("Filter — text-only mode disables inapplicable toggles (D7)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("disables images/assets/documents/singleFile and shows the hint when HTML is off with markdown on", () => {
    storeMocks.options = textOnlyOptions();
    const ui = renderFilter();

    for (const id of TEXT_ONLY_DISABLED_IDS) {
      const checkbox = ui.checkbox(id);
      expect(checkbox, `${id} should render`).not.toBeNull();
      expect(
        checkbox!.hasAttribute("disabled"),
        `${id} should be disabled`,
      ).toBe(true);
    }

    // The still-relevant controls stay enabled — the user must be able to
    // re-check HTML or switch the text format.
    for (const id of [
      "downloadHTML",
      "downloadContentAsMarkdown",
      "downloadContentAsText",
    ]) {
      expect(
        ui.checkbox(id)!.hasAttribute("disabled"),
        `${id} must stay enabled`,
      ).toBe(false);
    }

    // Short visible hint (hardcoded English per D7)
    expect(ui.container.textContent).toContain(TEXT_ONLY_HINT);

    ui.unmount();
  });

  it("also applies with content-as-text as the selected format", () => {
    storeMocks.options = {
      ...textOnlyOptions(),
      downloadContentAsMarkdown: false,
      downloadContentAsText: true,
    };
    const ui = renderFilter();

    for (const id of TEXT_ONLY_DISABLED_IDS) {
      expect(ui.checkbox(id)!.hasAttribute("disabled")).toBe(true);
    }
    expect(ui.container.textContent).toContain(TEXT_ONLY_HINT);

    ui.unmount();
  });

  it("keeps every toggle enabled and shows no hint while HTML is on", () => {
    storeMocks.options = {
      ...storeMocks.defaultOptions(),
      downloadContentAsMarkdown: true,
    };
    const ui = renderFilter();

    for (const id of TEXT_ONLY_DISABLED_IDS) {
      expect(ui.checkbox(id)!.hasAttribute("disabled")).toBe(false);
    }
    expect(ui.container.textContent).not.toContain(TEXT_ONLY_HINT);

    ui.unmount();
  });

  it("re-enables the toggles when HTML is re-checked", () => {
    storeMocks.options = textOnlyOptions();
    const ui = renderFilter();

    // Re-check HTML — the existing handler restores images/assets
    ui.click(ui.checkbox("downloadHTML")!);

    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadHTML",
      true,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadImages",
      true,
    );
    expect(storeMocks.setFilterOption).toHaveBeenCalledWith(
      "downloadAssets",
      true,
    );

    // Store accepts the change → HTML on again → toggles enabled, no hint
    storeMocks.options = {
      ...storeMocks.options,
      downloadHTML: true,
    };
    ui.rerender();

    for (const id of TEXT_ONLY_DISABLED_IDS) {
      expect(
        ui.checkbox(id)!.hasAttribute("disabled"),
        `${id} should be re-enabled`,
      ).toBe(false);
    }
    expect(ui.container.textContent).not.toContain(TEXT_ONLY_HINT);

    ui.unmount();
  });

  it("ignores clicks on the disabled toggles", () => {
    storeMocks.options = textOnlyOptions();
    const ui = renderFilter();

    ui.click(ui.checkbox("downloadImages")!);
    ui.click(ui.checkbox("singleFile")!);

    expect(storeMocks.setFilterOption).not.toHaveBeenCalled();

    ui.unmount();
  });
});

// ---------------------------------------------------------------------------
// Tests — outgoing options normalization (6.3 gate: values must not leak)
// ---------------------------------------------------------------------------

describe("useDownloadOptions — text-only normalization", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    storeMocks.options = storeMocks.defaultOptions();
    vi.clearAllMocks();
  });

  it("neutralizes the inapplicable toggles in the outgoing options", () => {
    storeMocks.options = textOnlyOptions();
    const probe = renderDownloadOptionsProbe();

    const outgoing = probe.value()!;
    expect(outgoing.downloadHTML).toBe(false);
    expect(outgoing.downloadContentAsMarkdown).toBe(true);
    expect(outgoing.downloadImages).toBe(false);
    expect(outgoing.downloadLinks).toBe(false);
    expect(outgoing.downloadAssets).toBe(false);
    expect(outgoing.downloadDocuments).toBe(false);
    expect(outgoing.singleFile).toBe(false);

    probe.unmount();
  });

  it("preserves the text-format flags in the outgoing options", () => {
    storeMocks.options = {
      ...textOnlyOptions(),
      downloadContentAsMarkdown: false,
      downloadContentAsText: true,
    };
    const probe = renderDownloadOptionsProbe();

    const outgoing = probe.value()!;
    expect(outgoing.downloadContentAsText).toBe(true);
    expect(outgoing.downloadContentAsMarkdown).toBe(false);
    expect(outgoing.downloadHTML).toBe(false);

    probe.unmount();
  });

  it("passes options through unchanged when the selection is not text-only", () => {
    storeMocks.options = storeMocks.defaultOptions();
    const probe = renderDownloadOptionsProbe();

    const outgoing = probe.value()!;
    expect(outgoing.downloadHTML).toBe(true);
    expect(outgoing.downloadImages).toBe(true);
    expect(outgoing.downloadAssets).toBe(true);
    expect(outgoing.downloadDocuments).toBe(true);
    expect(outgoing.singleFile).toBe(false);

    probe.unmount();
  });
});

// ---------------------------------------------------------------------------
// Tests — pure helpers
// ---------------------------------------------------------------------------

describe("isTextOnlyDownload / normalizeTextOnlyOptions", () => {
  const base = storeMocks.defaultOptions;

  it("detects HTML-off + markdown-on as text-only", () => {
    expect(
      isTextOnlyDownload({
        ...base(),
        downloadHTML: false,
        downloadContentAsMarkdown: true,
      }),
    ).toBe(true);
  });

  it("detects HTML-off + content-as-text-on as text-only", () => {
    expect(
      isTextOnlyDownload({
        ...base(),
        downloadHTML: false,
        downloadContentAsText: true,
      }),
    ).toBe(true);
  });

  it("is not text-only while HTML is on, or with no text format selected", () => {
    expect(isTextOnlyDownload(base())).toBe(false);
    expect(isTextOnlyDownload({ ...base(), downloadHTML: false })).toBe(false);
    expect(
      isTextOnlyDownload({
        ...base(),
        downloadHTML: false,
        singleFile: true, // single-file forces the text flags off in the store
      }),
    ).toBe(false);
  });

  it("normalizes text-only selections without mutating stored preferences", () => {
    const options = textOnlyOptions();
    const normalized = normalizeTextOnlyOptions(options);

    expect(normalized.downloadImages).toBe(false);
    expect(normalized.downloadLinks).toBe(false);
    expect(normalized.downloadAssets).toBe(false);
    expect(normalized.downloadDocuments).toBe(false);
    expect(normalized.singleFile).toBe(false);
    // The format selection itself is preserved
    expect(normalized.downloadHTML).toBe(false);
    expect(normalized.downloadContentAsMarkdown).toBe(true);
    // The original object is untouched
    expect(options.downloadImages).toBe(true);
    expect(options.downloadDocuments).toBe(true);
  });

  it("returns non-text-only selections unchanged", () => {
    const options = base();
    expect(normalizeTextOnlyOptions(options)).toBe(options);
  });
});
