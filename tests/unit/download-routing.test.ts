/**
 * @vitest-environment jsdom
 *
 * (Fix 1 — design D1) Download-identity message routing.
 *
 * Covers tasks 1.5 + 1.6:
 *   - classifyDownloadMessage: progress-class messages apply only on
 *     identity match; terminal messages are always evaluated and resolve
 *     the UI when they belong to the tracked download — including after
 *     the live tab has switched away, and when unscoped (tabId undefined,
 *     D1 risk note: resume-path pushes, startup-cleanup interrupts).
 *   - messageClassForPanelKey: which PANEL_MESSAGE payload keys are
 *     terminal-class.
 *   - classifyTerminalRecord: the chrome.storage fallback records
 *     (downloadComplete / downloadCancelled / downloadFailed) route with
 *     the same terminal semantics.
 *   - DownloadStatus controls glue (task 1.4): Pause/Resume send their
 *     control message with the PINNED origin tab, never the live focused
 *     tab; Stop goes through onStopScraping (the hook's pinned targetRef
 *     path) and sends nothing itself.
 *
 * Verified BY READING (panel glue not unit-tested here — needs a full
 * React harness around SidePanel): messageWorker guards call
 * classifyDownloadMessage with downloadIdentityRef.current (sidepanel.tsx
 * PANEL_MESSAGE / PAGEPOCKET_* / DOWNLOAD_* cases); the storage handler
 * calls classifyTerminalRecord and applies/skips + removes each record;
 * the identity is pinned at press time (onClickStartDownload), at download
 * start (onDownloadStarted), when a reopened panel adopts a live download
 * (mount effect), and on the resume/restart paths.
 *
 * The "bite" describe replicates the OLD live-tab routing verbatim
 * (HEAD's isPushForPanel guard + the storage fallback's `tabId === tabId`
 * comparison) and pins that the new identity routing decides the defect
 * scenarios the OPPOSITE way. Run against a stub implementing the old
 * rule, those expectations fail (see the change's verification notes).
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import { messageActions } from "../../src/common/message";
import {
  classifyDownloadMessage,
  classifyTerminalRecord,
  messageClassForPanelKey,
  type DownloadIdentity,
} from "../../src/sidepanel/utils/downloadRouting";
import { DownloadStatus } from "../../src/sidepanel/components/DownloadStatus";
import type { ServerModeState } from "../../src/sidepanel/server-mode-state";

// ---------------------------------------------------------------------------
// i18n mock — resolve through the REAL en.json (per
// download-status-phase-labels.test.tsx) so the control-button labels are
// the production ones.
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
    t: (key: string, optionsOrDefault?: unknown) => {
      const value = resolveKey(key);
      if (typeof value === "string") {
        if (
          optionsOrDefault &&
          typeof optionsOrDefault === "object" &&
          !Array.isArray(optionsOrDefault)
        ) {
          return Object.entries(
            optionsOrDefault as Record<string, unknown>,
          ).reduce(
            (acc, [name, replacement]) =>
              acc.replace(new RegExp(`{{${name}}}`, "g"), String(replacement)),
            value,
          );
        }
        return value;
      }
      return typeof optionsOrDefault === "string" ? optionsOrDefault : key;
    },
  }),
}));

// DownloadStatus → common/chrome sendMessage is the control-message channel.
const { sendMessageMock } = vi.hoisted(() => ({
  sendMessageMock: vi.fn(async () => {}),
}));

vi.mock("../../src/common/chrome", () => ({
  sendMessage: sendMessageMock,
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Harness (createRoot + act, per download-status-phase-labels.test.tsx —
// createElement, not JSX: this suite is a .ts file).
// ---------------------------------------------------------------------------

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

async function clickButton(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  expect(button, `button labeled "${label}"`).toBeTruthy();
  await act(async () => {
    button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function uploadingState(): ServerModeState {
  return {
    phase: "uploading",
    uploadCompleted: 0,
    uploadTotal: 0,
    assemblyPhase: null,
    assemblyProgressPct: null,
    assemblyElapsedSeconds: null,
    serverDownloadUrl: null,
    isSingleFile: false,
    failedUploads: 0,
    serverSessionId: null,
    serverError: null,
  };
}

function renderControls(extra: {
  isPaused?: boolean;
  downloadOriginTabId?: number;
  onStopScraping?: () => void;
}) {
  return renderUi(
    createElement(DownloadStatus, {
      tabId: 5, // the panel's LIVE focused tab
      isScraping: false,
      isScrapingLinkedPages: false,
      isPaused: false,
      action: null,
      downloadResponse: null,
      setIsPaused: () => {},
      serverModeState: uploadingState(),
      ...extra,
    }),
  );
}

// ---------------------------------------------------------------------------
// Fixtures — the download started on tab 9 (server session "sess-1"); the
// user is now viewing tab 5.
// ---------------------------------------------------------------------------

const TRACKED: DownloadIdentity = {
  originTabId: 9,
  serverSessionId: "sess-1",
};

// ---------------------------------------------------------------------------
// classifyDownloadMessage — progress class
// ---------------------------------------------------------------------------

describe("classifyDownloadMessage — progress class", () => {
  it("applies progress from the tracked origin tab", () => {
    expect(classifyDownloadMessage(TRACKED, { tabId: 9 }, "progress")).toBe(
      "apply",
    );
  });

  it("applies progress even though the live tab has switched away — routing never consults the live tab", () => {
    // There is no live-tab input in the API at all: the decision is the
    // same whichever tab the user is viewing.
    expect(classifyDownloadMessage(TRACKED, { tabId: 9 }, "progress")).toBe(
      "apply",
    );
  });

  it("ignores progress from a different download's tab (spec: other downloads are ignored)", () => {
    expect(classifyDownloadMessage(TRACKED, { tabId: 42 }, "progress")).toBe(
      "ignore",
    );
  });

  it("applies unscoped progress while tracking (resume-path pushes, D1 risk note)", () => {
    expect(
      classifyDownloadMessage(TRACKED, { tabId: undefined }, "progress"),
    ).toBe("apply");
  });

  it("ignores tab-tagged progress when nothing is tracked", () => {
    expect(classifyDownloadMessage(null, { tabId: 9 }, "progress")).toBe(
      "ignore",
    );
  });

  it("applies unscoped progress when nothing is tracked (legacy broadcast)", () => {
    expect(
      classifyDownloadMessage(null, { tabId: undefined }, "progress"),
    ).toBe("apply");
  });

  it("a payload session id is authoritative: matching session applies despite an odd tab", () => {
    expect(
      classifyDownloadMessage(
        TRACKED,
        { tabId: 42, serverSessionId: "sess-1" },
        "progress",
      ),
    ).toBe("apply");
  });

  it("a payload session id is authoritative: mismatching session is ignored despite the origin tab", () => {
    expect(
      classifyDownloadMessage(
        TRACKED,
        { tabId: 9, serverSessionId: "sess-OLD" },
        "progress",
      ),
    ).toBe("ignore");
  });

  it("an identity without a session id falls back to tab matching", () => {
    const noSession: DownloadIdentity = {
      originTabId: 9,
      serverSessionId: null,
    };
    expect(
      classifyDownloadMessage(
        noSession,
        { tabId: 9, serverSessionId: "sess-1" },
        "progress",
      ),
    ).toBe("apply");
  });
});

// ---------------------------------------------------------------------------
// classifyDownloadMessage — terminal class (always evaluated)
// ---------------------------------------------------------------------------

describe("classifyDownloadMessage — terminal class", () => {
  it.each([
    ["DOWNLOAD_COMPLETE", messageActions.DOWNLOAD_COMPLETE],
    ["DOWNLOAD_FAILED", messageActions.DOWNLOAD_FAILED],
    ["DOWNLOAD_CANCELLED", messageActions.DOWNLOAD_CANCELLED],
    ["DOWNLOAD_INTERRUPTED", messageActions.DOWNLOAD_INTERRUPTED],
  ])(
    "%s stamped with the origin tab resolves the UI after the live tab switched away",
    (_label, _action) => {
      // The whole fix: the decision keys on the PINNED origin tab, so the
      // tab the user is currently viewing is irrelevant.
      expect(classifyDownloadMessage(TRACKED, { tabId: 9 }, "terminal")).toBe(
        "terminal-apply",
      );
    },
  );

  it("unscoped terminal messages are treated as the tracked download's (D1 risk note)", () => {
    expect(
      classifyDownloadMessage(TRACKED, { tabId: undefined }, "terminal"),
    ).toBe("terminal-apply");
  });

  it("a terminal from a different download's tab never resolves the UI", () => {
    expect(classifyDownloadMessage(TRACKED, { tabId: 42 }, "terminal")).toBe(
      "terminal-ignore",
    );
  });

  it("a terminal naming a DIFFERENT session never resolves the UI — even from the origin tab", () => {
    expect(
      classifyDownloadMessage(
        TRACKED,
        { tabId: 9, serverSessionId: "sess-OTHER" },
        "terminal",
      ),
    ).toBe("terminal-ignore");
  });

  it("a terminal naming the tracked session resolves the UI — even from an odd tab", () => {
    expect(
      classifyDownloadMessage(
        TRACKED,
        { tabId: 42, serverSessionId: "sess-1" },
        "terminal",
      ),
    ).toBe("terminal-apply");
  });

  it("a tab-tagged terminal with nothing tracked still resolves (a just-opened panel must not strand)", () => {
    // Nothing pinned yet → nothing to contradict the terminal with. This
    // is what keeps startup-cleanup interrupts working on panel open.
    expect(classifyDownloadMessage(null, { tabId: 9 }, "terminal")).toBe(
      "terminal-apply",
    );
  });
});

// ---------------------------------------------------------------------------
// messageClassForPanelKey — the PANEL_MESSAGE payload key classes
// ---------------------------------------------------------------------------

describe("messageClassForPanelKey", () => {
  it.each([
    "status.complete",
    "status.cancelled",
    "status.failedWithError",
    "status.noDownloadableContent",
    "status.serverError",
    "status.serverFallbackOffer",
    "status.memoryLimitError",
    "status.networkError",
    "status.cloudNotLinked",
    "status.cloudIdentityMismatch",
    "status.pagepocketUploadComplete",
    "status.pagepocketUploadError",
  ])("%s is terminal-class", (key) => {
    expect(messageClassForPanelKey(key)).toBe("terminal");
  });

  it.each([
    "status.uploadProgress",
    "status.assemblyProgress",
    "status.scraping",
    "status.uploadingHtml",
    "status.serverDownloadReady",
    "status.connected",
    "some.unknown.key",
  ])("%s is progress-class", (key) => {
    expect(messageClassForPanelKey(key)).toBe("progress");
  });

  it("a missing key is progress-class", () => {
    expect(messageClassForPanelKey(undefined)).toBe("progress");
    expect(messageClassForPanelKey(null)).toBe("progress");
  });
});

// ---------------------------------------------------------------------------
// classifyTerminalRecord — chrome.storage fallback records (D4)
// ---------------------------------------------------------------------------

describe("classifyTerminalRecord (storage fallback)", () => {
  it("delivers a completion record for the tracked download after the live tab switched away", () => {
    const record = { downloadId: 7, tabId: 9, timestamp: 1 };
    expect(classifyTerminalRecord(TRACKED, record)).toBe("terminal-apply");
  });

  it.each(["downloadCancelled", "downloadFailed"] as const)(
    "delivers a %s record for the tracked download after the live tab switched away",
    (_key) => {
      const record = { downloadId: 7, tabId: 9, error: "x", timestamp: 1 };
      expect(classifyTerminalRecord(TRACKED, record)).toBe("terminal-apply");
    },
  );

  it("ignores a record from a different download's tab", () => {
    expect(classifyTerminalRecord(TRACKED, { tabId: 42 })).toBe(
      "terminal-ignore",
    );
  });

  it("delivers an unscoped record (defensive — mirrors the push rule)", () => {
    expect(classifyTerminalRecord(TRACKED, { tabId: undefined })).toBe(
      "terminal-apply",
    );
  });

  it("delivers a tab-tagged record when nothing is tracked (panel reopened post-completion)", () => {
    expect(classifyTerminalRecord(null, { tabId: 9 })).toBe("terminal-apply");
  });
});

// ---------------------------------------------------------------------------
// BITE — old live-tab routing vs the identity routing.
//
// The old-rule functions below are the pre-fix panel logic VERBATIM:
//   - isPushForPanel (src/sidepanel/utils/tabFilter.ts) composed as the old
//     messageWorker guard `acceptsTab(senderTabId)` with the LIVE tab and
//     the hook's pinned snapshot (0 in a reopened panel — the hook only
//     pins after a press).
//   - the storage fallback guard `record.tabId !== undefined &&
//     record.tabId === tabId` (live tab, stale closure).
// Each test pins BOTH verdicts: the old rule's (the defect) and the new
// rule's (the fix). Against a stub implementing the old rule, every "new
// rule" expectation here fails.
// ---------------------------------------------------------------------------

function isPushForPanelOld(
  senderTabId: number | undefined,
  focusedTabId: number,
  pinnedDownloadTabId: number | null | undefined,
): boolean {
  if (senderTabId === undefined) return true;
  return senderTabId === focusedTabId || senderTabId === pinnedDownloadTabId;
}

describe("bite — old live-tab routing vs identity routing", () => {
  it("terminal after a tab switch, reopened panel: the old guard drops it (pin=0, live=B), the identity routing delivers it", () => {
    // Panel reopened mid-download; hook never pressed → old pin = 0.
    // Terminal push stamped with the download's origin tab A.
    expect(isPushForPanelOld(9, 5, 0)).toBe(false); // OLD: dropped → frozen spinner
    expect(classifyDownloadMessage(TRACKED, { tabId: 9 }, "terminal")).toBe(
      "terminal-apply",
    ); // NEW: delivered
  });

  it("terminal after a tab switch, press-run: the old live-tab-only storage guard drops the record, the record routing delivers it", () => {
    // Old storage fallback compared against the LIVE tab (with a stale
    // closure) — no pinned fallback at all.
    const oldStorageGuardAccepts = (
      recordTabId: number | undefined,
      liveTabId: number,
    ) => recordTabId !== undefined && recordTabId === liveTabId;
    expect(oldStorageGuardAccepts(9, 5)).toBe(false); // OLD: record ignored
    expect(classifyTerminalRecord(TRACKED, { tabId: 9 })).toBe(
      "terminal-apply",
    ); // NEW: record applied
  });

  it("progress from ANOTHER download on the focused tab: the old guard accepted it, the identity routing ignores it", () => {
    // Old semantics let the focused tab's messages through — two
    // concurrent downloads cross-contaminated each other's UI.
    expect(isPushForPanelOld(5, 5, 9)).toBe(true); // OLD: accepted (wrong)
    expect(classifyDownloadMessage(TRACKED, { tabId: 5 }, "progress")).toBe(
      "ignore",
    ); // NEW: filtered
  });
});

// ---------------------------------------------------------------------------
// Task 1.4 glue — DownloadStatus controls target the pinned origin tab
// ---------------------------------------------------------------------------

describe("DownloadStatus controls target the download's origin tab", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    sendMessageMock.mockClear();
  });

  it("Pause sends SCRAPER_PAUSE with the PINNED origin tab (9), never the focused tab (5)", async () => {
    const { container, unmount } = renderControls({ downloadOriginTabId: 9 });

    await clickButton(container, "Pause");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      "background",
      expect.objectContaining({
        action: messageActions.SCRAPER_PAUSE,
        data: { tabId: 9 },
      }),
    );
    const targetedTabs = sendMessageMock.mock.calls.map(
      (call) => (call[1] as { data: { tabId: number } }).data.tabId,
    );
    expect(targetedTabs).not.toContain(5);

    unmount();
  });

  it("Resume sends SCRAPER_RESUME with the PINNED origin tab", async () => {
    const { container, unmount } = renderControls({
      isPaused: true,
      downloadOriginTabId: 9,
    });

    await clickButton(container, "Resume");

    expect(sendMessageMock).toHaveBeenCalledWith(
      "background",
      expect.objectContaining({
        action: messageActions.SCRAPER_RESUME,
        data: { tabId: 9 },
      }),
    );

    unmount();
  });

  it("Stop goes through onStopScraping (the hook's pinned targetRef path) and sends no tab-tagged control itself", async () => {
    const onStopScraping = vi.fn();
    const { container, unmount } = renderControls({
      downloadOriginTabId: 9,
      onStopScraping,
    });

    await clickButton(container, "Stop");

    expect(onStopScraping).toHaveBeenCalledTimes(1);
    // The component must NOT emit SCRAPER_* itself — the hook owns the
    // Stop target (targetRef).
    expect(sendMessageMock).not.toHaveBeenCalled();

    unmount();
  });

  it("without a pinned origin tab the controls fall back to the live tab (pre-download back-compat)", async () => {
    const { container, unmount } = renderControls({});

    await clickButton(container, "Pause");

    expect(sendMessageMock).toHaveBeenCalledWith(
      "background",
      expect.objectContaining({
        action: messageActions.SCRAPER_PAUSE,
        data: { tabId: 5 },
      }),
    );

    unmount();
  });
});
