/**
 * @vitest-environment jsdom
 *
 * Assembly phase labels in DownloadStatus (raw-i18n fix, part 2a).
 *
 * The component builds dynamic keys `status.assemblyPhase${capitalize(p)}`
 * from the REAL server phase ids. These tests pin all five ids to their
 * en.json labels — a missing or renamed key would previously render the raw
 * id ("merging_html") to the user. Resolution runs against the actual
 * en.json, so key drift fails here too.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import { DownloadStatus } from "../../src/sidepanel/components/DownloadStatus";
import type { ServerModeState } from "../../src/sidepanel/server-mode-state";

// ---------------------------------------------------------------------------
// i18n mock — resolve through the REAL en.json like i18next would (flat
// dotted key → nested translation map), falling back to the defaultValue
// and finally the raw key, exactly how i18next behaves.
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
  return {
    container,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function assemblingState(phase: string): ServerModeState {
  return {
    phase: "assembling",
    uploadCompleted: 0,
    uploadTotal: 0,
    assemblyPhase: phase,
    assemblyProgressPct: 40,
    assemblyElapsedSeconds: null,
    serverDownloadUrl: null,
    isSingleFile: false,
    failedUploads: 0,
    serverError: null,
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

describe("DownloadStatus assembly phase labels (real en.json resolution)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["merging_html", "Merging HTML"],
    ["converting_urls", "Converting URLs"],
    ["converting_css", "Converting CSS"],
    ["inlining_css", "Inlining CSS"],
    ["assembling_zip", "Creating ZIP"],
  ])(
    "phase %s renders its translated label, never the raw id",
    (phase, label) => {
      const { container, unmount } = renderServerMode(assemblingState(phase));

      expect(container.textContent).toContain(label);
      expect(container.textContent).not.toContain(phase);

      unmount();
    },
  );

  it("the ready card no longer shows the assembly headline (2e)", () => {
    const { container, unmount } = renderServerMode(
      {
        ...assemblingState("merging_html"),
        phase: "ready",
        assemblyPhase: null,
        serverDownloadUrl: "https://example.com/archive.zip",
      },
      { onDownloadFromServer: () => {} },
    );

    expect(container.textContent).not.toContain("Assembling on server...");
    expect(container.textContent).toContain("Your file is ready to download");

    unmount();
  });
});
