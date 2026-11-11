/**
 * @vitest-environment jsdom
 *
 * (multipage-download-fixes 5.5 + 5.7 / design D9)
 *
 * 5.5 — Per-page progress counter: `status.linkedPageProgress`
 * (current/total) becomes first-class server-mode state and renders as a
 * prominent "Page X of Y" counter on the scraping card. Absence renders
 * nothing.
 *
 * 5.7 — Honest merge wording: when the session options have
 * `downloadHtml=false`, the `merging_html` assembly subtitle explains the
 * merge prepares the text conversion; HTML runs keep the existing wording.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import { DownloadStatus } from "../../src/sidepanel/components/DownloadStatus";
import {
  applyServerModeMessage,
  initialServerModeState,
} from "../../src/sidepanel/server-mode-state";
import type { ServerModeState } from "../../src/sidepanel/server-mode-state";

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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function renderUi(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function renderStatus(extra?: Partial<any>) {
  return renderUi(
    <DownloadStatus
      tabId={1}
      isScraping={false}
      isScrapingLinkedPages={false}
      isPaused={false}
      action={null}
      downloadResponse={null}
      setIsPaused={() => {}}
      {...extra}
    />,
  );
}

function scrapingState(
  overrides: Partial<ServerModeState> = {},
): ServerModeState {
  return { ...initialServerModeState, phase: "scraping", ...overrides };
}

function assemblingState(
  overrides: Partial<ServerModeState> = {},
): ServerModeState {
  return {
    ...initialServerModeState,
    phase: "assembling",
    assemblyPhase: "merging_html",
    assemblyProgressPct: 40,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 5.5 — per-page counter
// ---------------------------------------------------------------------------

describe("per-page progress counter (5.5)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("status.linkedPageProgress lifts current/total into dedicated state", () => {
    const next = applyServerModeMessage(
      initialServerModeState,
      "status.linkedPageProgress",
      {
        current: 3,
        total: 12,
        phase: "internal",
        isPaused: false,
      },
    );
    expect(next.linkedPageCurrent).toBe(3);
    expect(next.linkedPageTotal).toBe(12);
    expect(next.linkedPagePhase).toBe("internal");
  });

  it("the scraping card renders 'Page X of Y' from the state", () => {
    const { container, unmount } = renderStatus({
      isScrapingLinkedPages: true,
      serverModeState: scrapingState({
        linkedPageCurrent: 2,
        linkedPageTotal: 5,
      }),
    });

    expect(container.textContent).toContain("Page 2 of 5");
    unmount();
  });

  it("no linked-page scraping → no counter renders", () => {
    const { container, unmount } = renderStatus({
      isScrapingLinkedPages: true,
      serverModeState: scrapingState(),
    });

    expect(container.textContent).not.toContain("Page ");
    unmount();
  });

  it("the counter clears when linked pages complete", () => {
    const started = applyServerModeMessage(
      initialServerModeState,
      "status.linkedPageProgress",
      { current: 1, total: 4, phase: "internal" },
    );
    const done = applyServerModeMessage(started, "status.linkedPagesComplete", {
      succeeded: 3,
      failed: 1,
    });
    expect(done.linkedPageCurrent).toBeNull();
    expect(done.linkedPageTotal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.7 — honest merge wording
// ---------------------------------------------------------------------------

describe("honest merge wording for text-only runs (5.7)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const TEXT_WORDING =
    "Preparing text conversion (merging captured HTML)" as string;

  it("assemblyProgress stores the text-conversion flag when downloadHtml is false", () => {
    const next = applyServerModeMessage(
      initialServerModeState,
      "status.assemblyProgress",
      {
        phase: "merging_html",
        progressPct: 10,
        downloadHtml: false,
      },
    );
    expect(next.assemblyForTextConversion).toBe(true);
  });

  it("assemblyProgress keeps HTML wording when downloadHtml is true", () => {
    const next = applyServerModeMessage(
      initialServerModeState,
      "status.assemblyProgress",
      {
        phase: "merging_html",
        progressPct: 10,
        downloadHtml: true,
      },
    );
    expect(next.assemblyForTextConversion).toBe(false);
  });

  it("the assembling card uses the explanatory wording when downloadHtml is false", () => {
    const { container, unmount } = renderStatus({
      serverModeState: assemblingState({ assemblyForTextConversion: true }),
    });

    expect(container.textContent).toContain(TEXT_WORDING);
    unmount();
  });

  it("HTML-on runs keep the existing 'Merging HTML' wording", () => {
    const { container, unmount } = renderStatus({
      serverModeState: assemblingState({ assemblyForTextConversion: false }),
    });

    expect(container.textContent).toContain("Merging HTML");
    expect(container.textContent).not.toContain(TEXT_WORDING);
    unmount();
  });

  it("the explanatory key exists in en.json (i18n surface)", () => {
    expect(resolveKey("status.assemblyPhaseMerging_html_text")).toBe(
      TEXT_WORDING,
    );
  });
});
