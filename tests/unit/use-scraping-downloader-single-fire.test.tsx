/**
 * @vitest-environment jsdom
 *
 * (Fix A — replay loop) Hook-level tests for useScrapingDownloader.
 *
 * Incident: the download effect re-ran on every render whose dependencies
 * changed and replayed START_DOWNLOAD each time — a tab switch mid-flow
 * retargeted the replay at the newly focused tab while carrying the ORIGINAL
 * tab's html, producing five server sessions for a single press.
 *
 * Under test:
 * 1. START_DOWNLOAD fires EXACTLY ONCE per intentional press, and
 *    dependency churn (tab switches, re-renders) after the fire cannot
 *    replay it.
 * 2. tabId/tabUrl are captured AT PRESS TIME: a tab switch DURING the run
 *    neither retargets the scroll commands nor the START_DOWNLOAD payload.
 * 3. A NEW press re-arms the gate and snapshots the CURRENT tab at that
 *    press.
 * 4. The stop/partial-save path is gated by the same single-fire rule.
 *
 * Harness: react-dom/client createRoot + act() (same pattern as
 * actions-status.test.tsx — no @testing-library/react in this repo).
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/client/message", () => ({
  sendMessageToBackground: vi.fn(),
}));
vi.mock("../../src/sidepanel/utils/messageHandlers", () => ({
  handleStartScroll: vi.fn(),
  handleStartDownload: vi.fn(),
}));

import { useScrapingDownloader } from "../../src/sidepanel/hooks/useScrapingDownloader";
import {
  handleStartScroll,
  handleStartDownload,
} from "../../src/sidepanel/utils/messageHandlers";
import { sendMessageToBackground } from "../../src/client/message";
import { messageActions } from "../../src/common/message";

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Mock behavior wiring
// ---------------------------------------------------------------------------

const ORIGIN = { tabId: 1, tabUrl: "https://origin.example/page" };

/** Response still scrolling (NOT at bottom). */
const scrollingResponse = () => ({
  top: 200,
  height: 1000,
  viewportHeight: 600,
  html: "<html><body>partial</body></html>",
  heightChanged: false,
  hydrationElapsedMs: 5000,
  imagesPending: 0,
});

/** Response settled at the bottom of a static, fully loaded page. */
const settledResponse = () => ({
  top: 400,
  height: 1000,
  viewportHeight: 600,
  html: "<html><body>settled</body></html>",
  heightChanged: false,
  hydrationElapsedMs: 5000,
  imagesPending: 0,
});

let scrollScript: Array<Record<string, unknown>> = [];

function installDefaultMocks() {
  vi.mocked(sendMessageToBackground).mockImplementation(
    async (action: string) => {
      if (action === messageActions.SERVER_CREATE_SESSION) {
        return { success: true, sessionId: "sess-hook-1" };
      }
      if (action === messageActions.SERVER_UPLOAD_HTML_CHUNK) {
        return { success: true };
      }
      return {};
    },
  );

  scrollScript = [scrollingResponse(), settledResponse()];
  vi.mocked(handleStartScroll).mockImplementation(async () => {
    return scrollScript.shift() ?? settledResponse();
  });

  vi.mocked(handleStartDownload).mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Test host — drives the hook with controlled props
// ---------------------------------------------------------------------------

interface HostControls {
  press: (options?: Record<string, unknown>) => void;
  switchTab: (tabId: number, tabUrl: string) => void;
  complete: () => void;
  stop: () => void;
  isScraping: () => boolean;
}

function TestHost({
  controls,
}: {
  controls: React.RefObject<HostControls | null>;
}) {
  const [tabId, setTabId] = useState(ORIGIN.tabId);
  const [tabUrl, setTabUrl] = useState(ORIGIN.tabUrl);
  const [isScraping, setIsScraping] = useState(false);
  const [downloadOptions, setDownloadOptions] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [, setMessages] = useState<any[]>([]);

  const hook = useScrapingDownloader({
    tabId,
    tabUrl,
    isScraping,
    setIsScraping,
    downloadOptions: downloadOptions as any,
    setMessages,
  });

  controls.current = {
    press: (options = { downloadHTML: true, singleFile: false }) => {
      // Mirrors sidepanel onClickStartDownload (press-time state batch).
      setIsScraping(true);
      setDownloadOptions(options);
    },
    switchTab: (nextTabId, nextTabUrl) => {
      setTabId(nextTabId);
      setTabUrl(nextTabUrl);
    },
    complete: () => {
      // Mirrors the DOWNLOAD_COMPLETE reset in sidepanel.
      hook.setDownloadResponse(null);
      setIsScraping(false);
    },
    stop: () => {
      void hook.stopScraping();
    },
    isScraping: () => isScraping,
  };

  return null;
}

function renderHost() {
  const controls: React.RefObject<HostControls | null> = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TestHost controls={controls} />);
  });
  return {
    controls,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** Flush microtask/render rounds so the async effect loop can progress. */
async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const downloadCalls = () => vi.mocked(handleStartDownload).mock.calls;
const scrollCalls = () => vi.mocked(handleStartScroll).mock.calls;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  installDefaultMocks();
});

describe("useScrapingDownloader — single-fire START_DOWNLOAD (Fix A)", () => {
  it("fires START_DOWNLOAD exactly once when the scrape settles", async () => {
    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    await flush();

    expect(downloadCalls()).toHaveLength(1);
    unmount();
  });

  it("never replays on tab switches or re-renders after the fire", async () => {
    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    await flush();
    expect(downloadCalls()).toHaveLength(1);

    // Dependency-churn storm: tab switches + idle re-render rounds — the
    // exact trigger of the five-session incident.
    for (const tab of [2, 3, 4]) {
      act(() => controls.current!.switchTab(tab, `https://tab${tab}.example/`));
      await flush();
    }

    expect(downloadCalls()).toHaveLength(1);
    unmount();
  });

  it("pins tabId/tabUrl AT PRESS TIME: a mid-run tab switch retargets nothing", async () => {
    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    // One flush: first scroll step (still in progress) is in flight.
    await flush(2);
    expect(scrollCalls().length).toBeGreaterThanOrEqual(1);

    // The user switches to a DIFFERENT tab mid-run.
    act(() => controls.current!.switchTab(999, "https://other.example/"));
    await flush();

    // Download fired once, for the PRESS-TIME tab — not the focused one.
    expect(downloadCalls()).toHaveLength(1);
    const [calledTabId, html, calledTabUrl] = downloadCalls()[0];
    expect(calledTabId).toBe(ORIGIN.tabId);
    expect(calledTabUrl).toBe(ORIGIN.tabUrl);
    expect(html).toContain("settled");

    // Scroll commands were also pinned to the press-time tab.
    for (const call of scrollCalls()) {
      expect(call[0]).toBe(ORIGIN.tabId);
    }
    unmount();
  });

  it("re-arms on a NEW press and snapshots THAT press's tab", async () => {
    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    await flush();
    expect(downloadCalls()).toHaveLength(1);

    // Flow completes (mirrors DOWNLOAD_COMPLETE reset).
    act(() => controls.current!.complete());
    await flush();

    // The user moved to another tab and presses download THERE.
    act(() => controls.current!.switchTab(7, "https://seventh.example/"));
    act(() => controls.current!.press());
    await flush();

    expect(downloadCalls()).toHaveLength(2);
    const [secondTabId, , secondTabUrl] = downloadCalls()[1];
    expect(secondTabId).toBe(7);
    expect(secondTabUrl).toBe("https://seventh.example/");
    unmount();
  });

  it("gates the stop/partial-save download with the same single-fire rule", async () => {
    // A page whose FIRST scroll step resolves (so the partial HTML reaches
    // the hook) and whose SUBSEQUENT steps never do — mirroring a genuinely
    // long-running scrape. The only way a download can fire is the user's
    // partial save.
    let scrollStep = 0;
    vi.mocked(handleStartScroll).mockImplementation(async () => {
      scrollStep += 1;
      if (scrollStep === 1) {
        return {
          top: 100,
          height: 100000,
          viewportHeight: 600,
          html: "<html><body>partial</body></html>",
          heightChanged: false,
          hydrationElapsedMs: 5000,
          imagesPending: 0,
        } as any;
      }
      // Never resolves — the run cannot finish on its own.
      return new Promise(() => {});
    });

    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    await flush(3); // a few scroll steps, run still active
    expect(scrollCalls().length).toBeGreaterThanOrEqual(1);
    expect(downloadCalls()).toHaveLength(0);

    act(() => controls.current!.stop());
    await flush();

    // The partial save fired exactly ONE START_DOWNLOAD…
    expect(downloadCalls()).toHaveLength(1);
    const [calledTabId, , calledTabUrl, options] = downloadCalls()[0];
    expect(calledTabId).toBe(ORIGIN.tabId);
    expect(calledTabUrl).toBe(ORIGIN.tabUrl);
    // …with linked-page scraping disabled (partial-save contract).
    expect(options).toMatchObject({ downloadLinks: false });

    // …and no replay on churn afterwards.
    act(() => controls.current!.switchTab(5, "https://fifth.example/"));
    await flush();
    expect(downloadCalls()).toHaveLength(1);
    unmount();
  });

  it("creates the server session for the press-time tab, once per run", async () => {
    const { controls, unmount } = renderHost();

    act(() => controls.current!.press());
    await flush();
    act(() => controls.current!.switchTab(3, "https://tab3.example/"));
    await flush();

    const createCalls = vi
      .mocked(sendMessageToBackground)
      .mock.calls.filter(
        ([action]) => action === messageActions.SERVER_CREATE_SESSION,
      );
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0][1] as any).url).toBe(ORIGIN.tabUrl);
    unmount();
  });
});
