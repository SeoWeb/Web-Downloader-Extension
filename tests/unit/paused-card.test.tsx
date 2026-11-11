/**
 * @vitest-environment jsdom
 *
 * (multipage-download-fixes 5.6 / design D2 + D9) The Paused card.
 *
 * A pause — HELD (worker alive) or PARKED (worker died while paused, the
 * phase-`paused` checkpoint + snapshot survive) — renders a localized
 * Paused card with Resume + Stop. Interrupted wording is never used for a
 * paused download.
 *
 * Also pins the server-mode phase machine additions ("paused" phase from
 * status.scraperPaused, back to "scraping" on a park-resume) and the pure
 * resume-action routing (held → SCRAPER_RESUME, parked →
 * SCRAPER_RESUME_FROM_PARK).
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
import { choosePausedResumeAction } from "../../src/sidepanel/utils/pausedRouting";
import { interruptedPresentation } from "../../src/sidepanel/utils/interruptedRouting";
import type { ServerModeState } from "../../src/sidepanel/server-mode-state";

// ---------------------------------------------------------------------------
// i18n mock — resolve through the REAL en.json (flat dotted key), like the
// download-status-phase-labels harness.
// ---------------------------------------------------------------------------

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

// React 19 requires this flag for act() outside its own test renderer.
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

const INTERRUPTED_WORDING = [
  "service was restarted",
  "downloadInterruptedTitle",
];

describe("Paused card (5.6)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("a PARKED pause (checkpoint via CHECK_INTERRUPTED_DOWNLOAD) renders the Paused card with Resume + Stop", () => {
    const { container, unmount } = renderStatus({
      pausedDownload: {
        serverSessionId: "sess-park",
        tabId: 3,
        parked: true,
      },
      onStopScraping: () => {},
    });

    const text = container.textContent ?? "";
    expect(text).toContain(resolveKey("status.pausedTitle") as string);
    // Both controls present.
    expect(text).toContain(resolveKey("actions.resume") as string);
    expect(text).toContain(resolveKey("actions.stop") as string);
    // Interrupted wording NEVER appears for a paused download.
    for (const wording of INTERRUPTED_WORDING) {
      expect(text).not.toContain(wording);
    }
    unmount();
  });

  it("a HELD pause (phase paused after status.scraperPaused) renders the same card", () => {
    const state = applyServerModeMessage(
      initialServerModeState,
      "status.scraperPaused",
    );
    expect(state.phase).toBe("paused");

    const { container, unmount } = renderStatus({
      serverModeState: state,
      isPaused: true,
      isScrapingLinkedPages: true,
      onStopScraping: () => {},
    });

    const text = container.textContent ?? "";
    expect(text).toContain(resolveKey("status.pausedTitle") as string);
    expect(text).toContain(resolveKey("actions.resume") as string);
    expect(text).toContain(resolveKey("actions.stop") as string);
    for (const wording of INTERRUPTED_WORDING) {
      expect(text).not.toContain(wording);
    }
    unmount();
  });
});

describe("server-mode phase machine: paused (5.6)", () => {
  it("status.scraperPaused moves the phase to paused", () => {
    const next = applyServerModeMessage(
      { ...initialServerModeState, phase: "scraping" },
      "status.scraperPaused",
    );
    expect(next.phase).toBe("paused");
  });

  it("status.scrapingLinkedPages (park-resume) moves the phase back to scraping", () => {
    const paused = applyServerModeMessage(
      { ...initialServerModeState, phase: "paused" },
      "status.scraperPaused",
    );
    const next = applyServerModeMessage(paused, "status.scrapingLinkedPages");
    expect(next.phase).toBe("scraping");
  });
});

describe("paused resume routing (5.6)", () => {
  it("a parked pause resumes via SCRAPER_RESUME_FROM_PARK", () => {
    expect(choosePausedResumeAction(true)).toBe("resumeFromPark");
  });

  it("a held pause resumes via the live SCRAPER_RESUME path", () => {
    expect(choosePausedResumeAction(false)).toBe("resumeLive");
  });

  it("the paused checkpoint presentation is 'paused' for both sources", () => {
    expect(interruptedPresentation({ phase: "paused" })).toBe("paused");
  });
});

describe("paused state typing", () => {
  it("ServerModeState.phase accepts 'paused'", () => {
    const state: ServerModeState = {
      ...initialServerModeState,
      phase: "paused",
    };
    expect(state.phase).toBe("paused");
  });
});
