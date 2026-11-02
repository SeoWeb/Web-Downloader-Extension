/**
 * @vitest-environment jsdom
 *
 * Stopped-with-partial-archive card + archive warning block
 * (archive-warning-and-replace-fixes, download-ux-feedback delta).
 *
 * The component branches are driven by the ServerModeState phases:
 * - phase "cancelled" + serverDownloadUrl → stopped-with-partial-archive
 *   card with cancellation wording (NEVER the green complete card) and the
 *   download action for the salvaged URL.
 * - phase "cancelled" without a URL → no server-archive affordance.
 * - a mid-run URL (phase still assembling) → the stopped card never shows.
 * - archiveWarning renders a warning block on the ready card and on the
 *   stopped-with-archive card; a clean session renders without one.
 *
 * Resolution runs against the actual en.json like
 * download-status-phase-labels.test.tsx, so a missing or renamed key fails
 * here too. A locale-coverage check pins the three new keys in every
 * shipped locale file.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import en from "../../src/i18n/locales/en.json";
import { DownloadStatus } from "../../src/sidepanel/components/DownloadStatus";
import type { ServerModeState } from "../../src/sidepanel/server-mode-state";

// ---------------------------------------------------------------------------
// i18n mock — resolve through the REAL en.json like i18next would (flat
// dotted key → nested translation map), falling back to the raw key,
// exactly how i18next behaves.
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
      if (typeof value === "string") return value;
      if (typeof defaultValueOrOptions === "string") {
        return defaultValueOrOptions;
      }
      return key;
    },
  }),
}));

// DownloadStatus → common/chrome → background/message → background/
// download-core → cleanupHandlers touches chrome.runtime at module scope
// (service-worker only). The panel never needs that chain in tests.
vi.mock("../../src/common/chrome", () => ({
  sendMessage: vi.fn(async () => {}),
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Render harness (createRoot + act, per session-delete.test.tsx)
// ---------------------------------------------------------------------------

function renderUi(ui: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  const queryButtons = () => Array.from(container.querySelectorAll("button"));
  const findButtonByText = (text: string) =>
    queryButtons().find((b) => b.textContent?.includes(text)) ?? null;
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
  return {
    container,
    queryButtons,
    findButtonByText,
    click,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function baseState(overrides: Partial<ServerModeState>): ServerModeState {
  return {
    phase: null,
    uploadCompleted: 0,
    uploadTotal: 0,
    assemblyPhase: null,
    assemblyProgressPct: null,
    assemblyElapsedSeconds: null,
    serverDownloadUrl: null,
    isSingleFile: false,
    failedUploads: 0,
    serverSessionId: null,
    archiveWarning: null,
    serverError: null,
    ...overrides,
  };
}

function renderServerMode(state: ServerModeState, extra?: Partial<any>) {
  return renderUi(
    <DownloadStatus
      tabId={1}
      isScraping={false}
      isScrapingLinkedPages={false}
      isPaused={false}
      action={null}
      downloadResponse={null}
      setIsPaused={() => {}}
      serverModeState={state}
      {...extra}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DownloadStatus stopped-with-partial-archive card (real en.json resolution)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the stopped card with cancellation wording for cancelled phase + salvaged URL", () => {
    const onDownloadFromServer = vi.fn();
    const { container, findButtonByText, click, unmount } = renderServerMode(
      baseState({
        phase: "cancelled",
        serverDownloadUrl: "https://server.example.com/api/v1/sessions/s1/dl",
        serverSessionId: "sess-s1",
      }),
      { onDownloadFromServer },
    );

    // Cancellation wording — present.
    expect(container.textContent).toContain(
      resolveKey("status.stoppedWithArchiveTitle") as string,
    );
    expect(container.textContent).toContain(
      resolveKey("status.stoppedWithArchiveSubtitle") as string,
    );
    // NEVER the green complete presentation.
    expect(container.textContent).not.toContain(
      resolveKey("status.complete") as string,
    );
    expect(container.textContent).not.toContain(
      resolveKey("status.archiveReadySubtitle") as string,
    );
    // The download action is offered and wired to onDownloadFromServer.
    const button = findButtonByText(
      resolveKey("status.downloadFromServer") as string,
    );
    expect(button).not.toBeNull();
    click(button!);
    expect(onDownloadFromServer).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("shows no server-archive affordance when a stop produced no URL", () => {
    const { container, queryButtons, unmount } = renderServerMode(
      baseState({ phase: "cancelled", serverSessionId: "sess-s2" }),
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).not.toContain(
      resolveKey("status.stoppedWithArchiveTitle") as string,
    );
    expect(container.textContent).not.toContain(
      resolveKey("status.downloadFromServer") as string,
    );
    expect(queryButtons().length).toBe(0);

    unmount();
  });

  it("never renders the stopped card mid-run, even with a self-healed URL", () => {
    const { container, unmount } = renderServerMode(
      baseState({
        phase: "assembling",
        assemblyPhase: "merging_html",
        assemblyProgressPct: 40,
        serverDownloadUrl: "https://server.example.com/mid",
        serverSessionId: "sess-m",
      }),
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).not.toContain(
      resolveKey("status.stoppedWithArchiveTitle") as string,
    );
    expect(container.textContent).not.toContain(
      resolveKey("status.downloadFromServer") as string,
    );

    unmount();
  });
});

describe("DownloadStatus archive warning block (real en.json resolution)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the warning on the completed card when the server reported one", () => {
    const { container, unmount } = renderServerMode(
      baseState({
        phase: "ready",
        serverDownloadUrl: "https://server.example.com/dl",
        archiveWarning: "3 resources missing from the archive",
      }),
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).toContain(
      resolveKey("status.archiveWarningHeading") as string,
    );
    expect(container.textContent).toContain(
      "3 resources missing from the archive",
    );
    // The download action is still offered alongside the warning.
    expect(container.textContent).toContain(
      resolveKey("status.downloadFromServer") as string,
    );

    unmount();
  });

  it("renders a clean completion without any warning affordance", () => {
    const { container, unmount } = renderServerMode(
      baseState({
        phase: "ready",
        serverDownloadUrl: "https://server.example.com/dl",
        archiveWarning: null,
      }),
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).not.toContain(
      resolveKey("status.archiveWarningHeading") as string,
    );

    unmount();
  });

  it("shows the warning on the stopped-with-archive card", () => {
    const { container, unmount } = renderServerMode(
      baseState({
        phase: "cancelled",
        serverDownloadUrl: "https://server.example.com/dl",
        archiveWarning: "1 resource failed during assembly",
      }),
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).toContain(
      resolveKey("status.archiveWarningHeading") as string,
    );
    expect(container.textContent).toContain(
      "1 resource failed during assembly",
    );

    unmount();
  });
});

// ---------------------------------------------------------------------------
// Localization — the three new keys exist in EVERY shipped locale file
// (the localization spec's all-locales requirement; English source values
// are the established fallback pattern until translations land).
// ---------------------------------------------------------------------------

describe("stopped-with-archive + archive warning keys exist in every locale", () => {
  const localesDir = join(__dirname, "..", "..", "src", "i18n", "locales");
  const localeFiles = readdirSync(localesDir).filter((f) =>
    f.endsWith(".json"),
  );

  it("covers all shipped locale files", () => {
    expect(localeFiles.length).toBeGreaterThanOrEqual(45);
  });

  it.each(localeFiles)("%s has the three new status keys", (file) => {
    const raw = JSON.parse(readFileSync(join(localesDir, file), "utf-8")) as {
      translation?: Record<string, any>;
    } & Record<string, any>;
    const status = (raw.translation ?? raw).status;
    expect(status.stoppedWithArchiveTitle).toBeTruthy();
    expect(status.stoppedWithArchiveSubtitle).toBeTruthy();
    expect(status.archiveWarningHeading).toBeTruthy();
  });
});
