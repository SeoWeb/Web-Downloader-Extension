/**
 * @vitest-environment jsdom
 *
 * UI test for the "Download content as Markdown" checkbox
 * (download-as-markdown task 3.8 / user-interface spec).
 *
 * Verifies the OptionItem renders with the translated label, reflects the
 * option's state, forwards toggles to the store setter, and is disabled
 * (pointer-events-none) under single-file mode like the other granular
 * options.
 *
 * Rendered with react-dom/client directly (no @testing-library/react —
 * not a project dependency), against a jsdom document — same harness as
 * session-delete.test.tsx.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Filter renders PagePocketToggle → pagepocketStore, which registers a
// chrome.storage.onChanged listener at module load. setup.cjs mocks
// storage.local only — add onChanged BEFORE importing the component tree
// (dynamic import; same pattern as pagepocket-store-init.test.ts).
if (typeof globalThis.chrome?.storage === "object") {
  (globalThis.chrome.storage as Record<string, unknown>).onChanged = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
}

const { default: Filter } = await import("../../src/components/Filter");

// ---------------------------------------------------------------------------
// Mocks — labels resolve through react-i18next (return the key so the
// assertion matches the translated output), and the filter hooks are
// replaced with a controlled options object + setter spies.
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const mocks = vi.hoisted(() => ({
  options: {
    downloadHTML: true,
    downloadImages: true,
    downloadLinks: false,
    downloadAssets: true,
    downloadContentAsText: false,
    downloadContentAsMarkdown: false,
    downloadDocuments: true,
    singleFile: false,
    alwaysAskWhereToSave: true,
  } as Record<string, any>,
  setDownloadContentAsMarkdown: vi.fn(),
}));

vi.mock("../../src/hooks/useFilterOptions", () => ({
  useFilterOptions: () => ({
    options: mocks.options,
    isLoading: false,
    isInitialized: true,
    hasStorageError: false,
    storageErrorMessage: null,
    setDownloadHTML: vi.fn(),
    setDownloadImages: vi.fn(),
    setDownloadLinks: vi.fn(),
    setDownloadAssets: vi.fn(),
    setDownloadContentAsText: vi.fn(),
    setDownloadContentAsMarkdown: mocks.setDownloadContentAsMarkdown,
    setDownloadDocuments: vi.fn(),
    setSingleFile: vi.fn(),
    setDownloadLinksFullScraping: vi.fn(),
    setLinkedPagesMaxCount: vi.fn(),
    setLinkedPagesDelay: vi.fn(),
    setLinkedPagesIncludeExternal: vi.fn(),
    setAlwaysAskWhereToSave: vi.fn(),
  }),
  useDownloadOptions: () => ({ ...mocks.options }),
  useStorageStatus: () => ({ isLoadingFromStorage: false }),
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Minimal render harness (createRoot + act + dispatched bubbling events)
// ---------------------------------------------------------------------------

function renderFilter() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Filter download={vi.fn()} tabUrl="https://example.com" />);
  });

  return {
    container,
    findCheckbox: () =>
      container.querySelector<HTMLButtonElement>(
        'button[role="checkbox"]#downloadContentAsMarkdown',
      ),
    findLabel: () =>
      container.querySelector<HTMLLabelElement>(
        'label[for="downloadContentAsMarkdown"]',
      ),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Filter — download content as Markdown checkbox", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    mocks.setDownloadContentAsMarkdown.mockClear();
    mocks.options.downloadContentAsMarkdown = false;
    mocks.options.singleFile = false;
  });

  it("renders with the translated label and starts unchecked", () => {
    const ui = renderFilter();

    const checkbox = ui.findCheckbox();
    expect(checkbox).not.toBeNull();
    expect(checkbox!.getAttribute("aria-checked")).toBe("false");
    expect(checkbox!.getAttribute("data-state")).toBe("unchecked");

    const label = ui.findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("filter.downloadContentAsMarkdown");

    ui.unmount();
  });

  it("reflects the enabled state via aria-checked", () => {
    mocks.options.downloadContentAsMarkdown = true;
    const ui = renderFilter();

    expect(ui.findCheckbox()!.getAttribute("aria-checked")).toBe("true");
    expect(ui.findCheckbox()!.getAttribute("data-state")).toBe("checked");

    ui.unmount();
  });

  it("forwards toggles to the store setter", () => {
    const ui = renderFilter();

    ui.click(ui.findCheckbox()!);

    expect(mocks.setDownloadContentAsMarkdown).toHaveBeenCalledWith(true);

    ui.unmount();
  });

  it("is disabled under single-file mode (granular section is inert)", () => {
    mocks.options.singleFile = true;
    const ui = renderFilter();

    // The granular section wraps the markdown checkbox and gets
    // "opacity-50 pointer-events-none" when singleFile is on.
    const inertSection = ui.container.querySelector(".pointer-events-none");
    expect(inertSection).not.toBeNull();
    expect(
      inertSection!.querySelector('label[for="downloadContentAsMarkdown"]'),
    ).not.toBeNull();

    ui.unmount();
  });
});
