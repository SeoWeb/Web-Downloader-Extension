/**
 * @vitest-environment jsdom
 *
 * Close (✕) icon-button on the DownloadComplete success hero.
 *
 * The ✕ must reuse the exact same reset flow as "Download Another" —
 * reset(tabUrl) — which returns the panel to its just-opened state without
 * wiping persisted filters/history/session data (those live outside this
 * component; here we only pin the wiring to the reset callback).
 *
 * Rendered with react-dom/client directly (no @testing-library/react —
 * not a project dependency), against a jsdom document.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../src/i18n/locales/en.json";
import { messageActions } from "../../src/common/message";
import { DownloadComplete } from "../../src/sidepanel/components/DownloadComplete";
import type { CloudUploadState } from "../../src/components/CloudUploadStatus";

// ---------------------------------------------------------------------------
// Mocks — i18n resolves through the REAL en.json like i18next would (per
// download-status-phase-labels.test.tsx), so a missing or renamed
// actions.close key renders the raw key and fails the aria-label assertion.
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
    t: (key: string) => {
      const value = resolveKey(key);
      return typeof value === "string" ? value : key;
    },
  }),
}));

// DownloadComplete → common/chrome → background/message touches
// chrome.runtime at module scope (service-worker only). The panel never
// needs that chain in tests.
vi.mock("../../src/common/chrome", () => ({
  sendMessage: vi.fn(async () => {}),
}));

// The rating widget is lazy-loaded inside the hero; stub it to keep the
// test focused on the ✕ wiring.
vi.mock("../../src/components/ChromeExtensionRating", () => ({
  default: () => null,
}));

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no chrome APIs — the component reads storage in effects and
// calls chrome.downloads.show from "Show in Folder".
const downloadsShow = vi.fn();
(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: (_keys: unknown, cb: (result: Record<string, unknown>) => void) =>
        cb({}),
      set: (_items: unknown, cb?: () => void) => cb?.(),
    },
  },
  downloads: { show: downloadsShow },
};

// ---------------------------------------------------------------------------
// Minimal render harness (createRoot + act + dispatched bubbling events)
// ---------------------------------------------------------------------------

const TAB_URL = "https://example.com/page";

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
  const findCloseButton = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

  return {
    container,
    root: root as Root,
    queryButtons,
    findButtonByText,
    findCloseButton,
    click,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** Harness rendering the done state with test-controlled props. */
function Harness(props: {
  reset: (newTabUrl: string) => void;
  serverDownloadUrl?: string | null;
  cloudUploadState?: CloudUploadState | null;
}) {
  return (
    <DownloadComplete
      tabId={1}
      tabUrl={TAB_URL}
      links={[]}
      action={messageActions.DOWNLOAD_DONE}
      reset={props.reset}
      serverDownloadUrl={props.serverDownloadUrl ?? null}
      isSingleFile={false}
      serverSessionId={null}
      cloudUploadState={props.cloudUploadState ?? null}
      downloadReport={null}
      failedUploads={0}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DownloadComplete close (✕) button", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    downloadsShow.mockClear();
  });

  it("renders the ✕ with the en.json close label in the top-right of the hero card", () => {
    const reset = vi.fn();
    const ui = renderUi(<Harness reset={reset} />);

    const close = ui.findCloseButton();
    expect(close).not.toBeNull();
    // Anchored to the card (absolute) — the card itself is position:relative.
    expect(close!.className).toContain("absolute");
    expect(close!.className).toContain("top-3");
    expect(close!.className).toContain("right-3");

    ui.unmount();
  });

  it("calls reset exactly once with the tabUrl when ✕ is clicked", () => {
    const reset = vi.fn();
    const ui = renderUi(<Harness reset={reset} />);

    ui.click(ui.findCloseButton()!);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(TAB_URL);

    ui.unmount();
  });

  it("keeps the reset identical to 'Download Another' — same handler target", () => {
    const reset = vi.fn();
    const ui = renderUi(<Harness reset={reset} />);

    ui.click(ui.findCloseButton()!);
    ui.click(ui.findButtonByText("Download Another")!);

    expect(reset).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenNthCalledWith(2, TAB_URL);

    ui.unmount();
  });

  it("still renders 'Show in Folder' and 'Download Another' alongside the ✕", () => {
    const reset = vi.fn();
    const ui = renderUi(<Harness reset={reset} />);

    expect(ui.findButtonByText("Show in Folder")).not.toBeNull();
    expect(ui.findButtonByText("Download Another")).not.toBeNull();
    // The ✕ is its own control, separate from the two labeled actions.
    expect(ui.queryButtons().filter((b) => b.textContent === "")).toHaveLength(
      1,
    );

    ui.unmount();
  });

  it("works when the server-delete flow is present (serverDownloadUrl set)", () => {
    const reset = vi.fn();
    const ui = renderUi(
      <Harness reset={reset} serverDownloadUrl="https://srv/dl.zip" />,
    );

    expect(ui.findButtonByText("Delete server copy")).not.toBeNull();
    ui.click(ui.findCloseButton()!);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(TAB_URL);

    ui.unmount();
  });

  it("works for cloud uploads (no local actions row, ✕ still resets)", () => {
    const reset = vi.fn();
    const cloudUploadState: CloudUploadState = {
      status: "success",
      progress: 100,
      pageId: "p123",
    };
    const ui = renderUi(
      <Harness reset={reset} cloudUploadState={cloudUploadState} />,
    );

    expect(ui.findButtonByText("actions.showInFolder")).toBeNull();
    ui.click(ui.findCloseButton()!);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(TAB_URL);

    ui.unmount();
  });
});
