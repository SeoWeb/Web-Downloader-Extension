/**
 * @vitest-environment jsdom
 *
 * (Fix 2 — design D2) Single-flow resume.
 *
 * Covers tasks 2.1–2.4:
 *   - One resume click → exactly ONE background flow: RESUME_SERVER_DOWNLOAD
 *     continues the existing session; the resume path NEVER enters the
 *     scrape pipeline (no SERVER_CREATE_SESSION, no scrolling, no
 *     START_DOWNLOAD).
 *   - A rapid double-click on Resume sends at most one RESUME_SERVER_DOWNLOAD
 *     (the hook's resume single-fire gate, beginResume/endResume, task 2.2).
 *   - The resume-failure fallback ("full restart") is the ONLY path from the
 *     resume flow into the scrape pipeline, and it starts exactly one scrape
 *     run through the normal single-run gate.
 *   - Clearing downloadOptions on DOWNLOAD_INTERRUPTED (task 2.3) removes
 *     the stale-options re-arm of the hook's auto-START_DOWNLOAD effect
 *     (Effect 2).
 *
 * Harness: the resume flow lives in sidepanel.tsx's onRestartDownload /
 * applyDownloadInterruptedState, which are not renderable without a full
 * React+chrome harness — so a TestHost mirrors that wiring LINE FOR LINE
 * (each control cites the mirrored block) around the REAL
 * useScrapingDownloader hook, with the message/scroll/download channels
 * mocked (same approach as use-scraping-downloader-single-fire.test.tsx).
 * Verified BY READING (not by this suite): sidepanel.tsx's
 * onRestartDownload performs the same gate/pin/status/resume/fallback
 * sequence, and applyDownloadInterruptedState performs the same
 * stash-options/clear-options/stop-state sequence.
 *
 * The "bite" describe replicates the OLD (HEAD 97c5007) wiring — resume
 * flipping isScraping true (arming Effect 1's scrape) and the interrupt
 * handler keeping downloadOptions — and pins the defect verdicts it
 * produces (a second session + a zombie START_DOWNLOAD), which the D2 gate
 * decides the opposite way. Run against a worktree at HEAD, the new-rule
 * expectations in this suite fail (see the change's verification notes).
 */

import { act, useRef, useState } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const ORIGIN = { tabId: 7, tabUrl: "https://origin.example/page" };
const OPTIONS = { downloadHTML: true, singleFile: false };

let scrollTopCounter = 0;

/** Scroll step still in progress: top advances (never "stuck"), page never
 * ends (never "at bottom") — an unscripted run keeps going until a test
 * scripts a settled step or the run is interrupted. */
const scrollingResponse = () => {
  scrollTopCounter += 300;
  return {
    top: scrollTopCounter,
    height: 1_000_000,
    viewportHeight: 600,
    html: "<html><body>partial</body></html>",
    heightChanged: false,
    hydrationElapsedMs: 5000,
    imagesPending: 0,
  };
};

/** Scroll step at the bottom of a settled page (the run finishes). */
const settledResponse = () => ({
  top: 400,
  height: 1000,
  viewportHeight: 600,
  html: "<html><body>settled</body></html>",
  heightChanged: false,
  hydrationElapsedMs: 5000,
  imagesPending: 0,
});

/**
 * Scroll script consumed step by step. Unscripted steps NEVER settle — an
 * in-flight press-run only finishes when a test explicitly scripts a
 * settled step (or interrupts it).
 */
let scrollScript: Array<Record<string, unknown>> = [];

/** What RESUME_SERVER_DOWNLOAD answers. */
let resumeResult: Record<string, unknown> = { success: true };
/** Optional in-flight resume — held until a test releases it (bite). */
let resumeDeferred: {
  promise: Promise<any>;
  resolve: (v: any) => void;
} | null = null;

function holdResume() {
  let resolveFn!: (v: any) => void;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  resumeDeferred = { promise, resolve: resolveFn };
}

function installDefaultMocks() {
  vi.mocked(sendMessageToBackground).mockImplementation(async (action) => {
    if (action === messageActions.SERVER_CREATE_SESSION) {
      return { success: true, sessionId: "sess-new" };
    }
    if (action === messageActions.RESUME_SERVER_DOWNLOAD) {
      return resumeDeferred ? resumeDeferred.promise : resumeResult;
    }
    if (action === messageActions.SERVER_UPLOAD_HTML_CHUNK) {
      return { success: true };
    }
    return {};
  });
  vi.mocked(handleStartScroll).mockImplementation(async () => {
    const scripted = scrollScript.shift();
    // Unscripted steps NEVER resolve: act() drains the whole microtask
    // chain, so an endless auto-advancing loop would run to the 500-step
    // safety limit inside a single flush. An in-flight press-run therefore
    // stays parked until a test scripts its steps or interrupts it (same
    // trick as the single-fire suite's partial-save scenario).
    if (!scripted) return new Promise(() => {}) as never;
    return scripted;
  });
  vi.mocked(handleStartDownload).mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Test host — mirrors sidepanel.tsx's resume wiring around the REAL hook
// ---------------------------------------------------------------------------

interface InterruptCard {
  phase: string;
  tabUrl: string;
  timestamp: number;
  tabId?: number;
  serverSessionId?: string;
}

interface HostControls {
  /** Mirrors onClickStartDownload's press-time state batch. */
  press: () => void;
  /** Mirrors applyDownloadInterruptedState (new) / HEAD's handler (legacy). */
  interrupt: (card: InterruptCard) => void;
  /** Mirrors onRestartDownload (new) / HEAD's (legacy). */
  restart: () => Promise<void>;
  switchTab: (tabId: number, tabUrl: string) => void;
}

function TestHost({
  controls,
  legacy = false,
}: {
  controls: React.RefObject<HostControls | null>;
  /** true = replicate the HEAD (pre-fix) wiring for the bite describe. */
  legacy?: boolean;
}) {
  const [tabId, setTabId] = useState(ORIGIN.tabId);
  const [tabUrl, setTabUrl] = useState(ORIGIN.tabUrl);
  const [isScraping, setIsScraping] = useState(false);
  const [downloadOptions, setDownloadOptions] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [interruptData, setInterruptData] = useState<InterruptCard | null>(
    null,
  );
  const [, setMessages] = useState<any[]>([]);

  // Render-time mirrors (sidepanel's liveTabIdRef / downloadOptionsRef
  // pattern).
  const downloadOptionsRef = useRef(downloadOptions);
  downloadOptionsRef.current = downloadOptions;
  const interruptedOptionsRef = useRef<Record<string, unknown> | null>(null);
  const resolvedTerminalRef = useRef<string | null>(null);

  const hook = useScrapingDownloader({
    tabId,
    tabUrl,
    isScraping,
    setIsScraping,
    downloadOptions: downloadOptions as any,
    setMessages,
    // (Fix 1 — D1) onDownloadStarted clears the terminal marker; not
    // further observable in this host — kept for wiring fidelity.
    onDownloadStarted: () => {
      resolvedTerminalRef.current = null;
    },
  });

  controls.current = {
    press: () => {
      // Mirrors onClickStartDownload: options + isScraping batch.
      setIsScraping(true);
      setDownloadOptions(OPTIONS);
    },
    interrupt: (card) => {
      if (legacy) {
        // HEAD's DOWNLOAD_INTERRUPTED handler: stops the run but KEEPS
        // downloadOptions (the stale-options re-arm defect).
        setInterruptData(card);
        hook.setDownloadResponse(null);
        setIsScraping(false);
        return;
      }
      // Mirrors applyDownloadInterruptedState (Fix 2 — 2.3): stash options
      // BEFORE the clear (the fallback re-reads them), then stop the run.
      interruptedOptionsRef.current = downloadOptionsRef.current;
      setDownloadOptions(null);
      setInterruptData(card);
      hook.setDownloadResponse(null);
      setIsScraping(false);
    },
    restart: async () => {
      if (legacy) {
        // ----- HEAD's onRestartDownload, verbatim logic -----------------
        setInterruptData(null);
        if (interruptData?.serverSessionId) {
          resolvedTerminalRef.current = null;
          setIsScraping(true); // ← THE DEFECT: arms Effect 1's scrape()
          try {
            const result = await sendMessageToBackground(
              messageActions.RESUME_SERVER_DOWNLOAD,
              { serverSessionId: interruptData.serverSessionId },
            );
            if (result?.fallback) {
              throw new Error(result.error || "Resume failed");
            }
            setIsScraping(false); // HEAD also set DOWNLOAD_DONE here.
          } catch {
            if (downloadOptions) {
              setIsScraping(true);
              setDownloadOptions(downloadOptions);
            }
          }
        } else if (downloadOptions) {
          setIsScraping(true);
          setDownloadOptions(downloadOptions);
        }
        return;
      }
      // ----- verbatim mirror of sidepanel.tsx onRestartDownload (Fix 2) --
      setInterruptData(null);
      if (interruptData?.serverSessionId) {
        // Resume NEVER scrapes; beginResume owns the single-fire gate
        // (rapid double-clicks → at most one RESUME_SERVER_DOWNLOAD, and
        // Effect 2 can never fire START_DOWNLOAD for the resume run).
        if (!hook.beginResume()) return;
        resolvedTerminalRef.current = null;
        setMessages((prev) => [...prev, { key: "status.reconnectingServer" }]);
        try {
          const result = await sendMessageToBackground(
            messageActions.RESUME_SERVER_DOWNLOAD,
            {
              serverSessionId: interruptData.serverSessionId,
              tabUrl: interruptData.tabUrl,
              phase: interruptData.phase,
            },
          );
          if (result?.fallback) {
            throw new Error(result.error || "Resume failed");
          }
          // Dedicated resume status (live card + poll) — not modeled here.
          hook.endResume();
        } catch {
          hook.endResume();
          // The ONLY scrape entry: full restart, through the normal
          // single-run gate (the false→true transition re-arms Effect 1's
          // Fix A gate). Options re-read from the pre-clear snapshot.
          const restartOptions =
            downloadOptions ?? interruptedOptionsRef.current;
          if (restartOptions) {
            interruptedOptionsRef.current = null;
            resolvedTerminalRef.current = null;
            setIsScraping(true);
            setDownloadOptions(restartOptions);
            setMessages((prev) => [...prev, { key: "status.scraping" }]);
          }
        }
      } else {
        // Full restart without a session — same gate, same snapshot re-read.
        const restartOptions = downloadOptions ?? interruptedOptionsRef.current;
        if (restartOptions) {
          interruptedOptionsRef.current = null;
          resolvedTerminalRef.current = null;
          setIsScraping(true);
          setDownloadOptions(restartOptions);
          setMessages((prev) => [...prev, { key: "status.scraping" }]);
        }
      }
    },
    switchTab: (nextTabId, nextTabUrl) => {
      setTabId(nextTabId);
      setTabUrl(nextTabUrl);
    },
  };

  return null;
}

function renderHost(legacy = false) {
  const controls: React.RefObject<HostControls | null> = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(TestHost, legacy ? { controls, legacy } : { controls }),
    );
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

const resumeCallCount = () =>
  vi
    .mocked(sendMessageToBackground)
    .mock.calls.filter(
      ([action]) => action === messageActions.RESUME_SERVER_DOWNLOAD,
    ).length;
const createCallCount = () =>
  vi
    .mocked(sendMessageToBackground)
    .mock.calls.filter(
      ([action]) => action === messageActions.SERVER_CREATE_SESSION,
    ).length;

/** Scenario shared by the flow tests: a press-run is interrupted mid-scrape. */
async function pressAndInterrupt(
  controls: React.RefObject<HostControls | null>,
  sessionId: string | undefined,
) {
  scrollScript = [scrollingResponse()];
  act(() => controls.current!.press());
  await flush(2);
  expect(vi.mocked(handleStartScroll).mock.calls.length).toBeGreaterThanOrEqual(
    1,
  );
  act(() =>
    controls.current!.interrupt({
      phase: "scraping",
      tabUrl: ORIGIN.tabUrl,
      timestamp: 1,
      tabId: ORIGIN.tabId,
      serverSessionId: sessionId,
    }),
  );
  await flush();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  scrollScript = [];
  scrollTopCounter = 0;
  resumeDeferred = null;
  resumeResult = { success: true };
  installDefaultMocks();
});

describe("single-flow resume (Fix 2 / D2)", () => {
  it("one resume click → exactly one background flow: RESUME_SERVER_DOWNLOAD, no session, no scroll, no START_DOWNLOAD", async () => {
    const { controls, unmount } = renderHost();

    await pressAndInterrupt(controls, "sess-1");

    const before = {
      resume: resumeCallCount(),
      create: createCallCount(),
      scroll: vi.mocked(handleStartScroll).mock.calls.length,
      download: vi.mocked(handleStartDownload).mock.calls.length,
    };

    await act(async () => {
      await controls.current!.restart();
    });
    await flush();

    expect(resumeCallCount()).toBe(before.resume + 1);
    expect(
      vi
        .mocked(sendMessageToBackground)
        .mock.calls.find(
          ([action]) => action === messageActions.RESUME_SERVER_DOWNLOAD,
        )![1],
    ).toMatchObject({ serverSessionId: "sess-1" });
    // The resume path NEVER enters the scrape pipeline:
    expect(createCallCount()).toBe(before.create); // no new server session
    expect(handleStartScroll).toHaveBeenCalledTimes(before.scroll); // no scrolling
    expect(handleStartDownload).toHaveBeenCalledTimes(before.download); // no START_DOWNLOAD

    unmount();
  });

  it("the one-flow property survives dependency churn (tab switches) after the resume", async () => {
    const { controls, unmount } = renderHost();

    await pressAndInterrupt(controls, "sess-1");
    await act(async () => {
      await controls.current!.restart();
    });
    await flush();
    const snapshot = {
      resume: resumeCallCount(),
      create: createCallCount(),
      download: vi.mocked(handleStartDownload).mock.calls.length,
    };
    expect(snapshot.resume).toBe(1);

    // Churn storm — must not replay the resume nor start a scrape.
    for (const tab of [2, 3]) {
      act(() => controls.current!.switchTab(tab, `https://tab${tab}.example/`));
      await flush();
    }

    expect(resumeCallCount()).toBe(snapshot.resume);
    expect(createCallCount()).toBe(snapshot.create);
    expect(handleStartDownload).toHaveBeenCalledTimes(snapshot.download);

    unmount();
  });

  it("rapid double-click on Resume sends at most one RESUME_SERVER_DOWNLOAD", async () => {
    const { controls, unmount } = renderHost();

    act(() =>
      controls.current!.interrupt({
        phase: "uploading",
        tabUrl: ORIGIN.tabUrl,
        timestamp: 1,
        tabId: ORIGIN.tabId,
        serverSessionId: "sess-1",
      }),
    );
    await flush();

    // Second click lands while the first resume flow is in flight (same
    // closure — both clicks precede the re-render, as with a real
    // double-click on the card's button).
    await act(async () => {
      const first = controls.current!.restart();
      const second = controls.current!.restart();
      await first;
      await second;
    });
    await flush();

    expect(resumeCallCount()).toBe(1);
    expect(createCallCount()).toBe(0);
    expect(handleStartDownload).not.toHaveBeenCalled();

    unmount();
  });

  it("resume-failure fallback starts exactly ONE scrape run through the normal single-run gate", async () => {
    const { controls, unmount } = renderHost();

    await pressAndInterrupt(controls, "sess-1");

    // Resume fails definitively → full-restart fallback.
    resumeResult = { success: false, fallback: true, error: "session expired" };
    // The fallback's fresh scrape must complete: script its settle steps.
    scrollScript = [settledResponse(), settledResponse()];
    const createBeforeFallback = createCallCount();
    await act(async () => {
      await controls.current!.restart();
    });
    await flush();

    expect(resumeCallCount()).toBe(1);
    // Exactly one scrape run: one NEW session, one START_DOWNLOAD.
    expect(createCallCount()).toBe(createBeforeFallback + 1);
    expect(handleStartDownload).toHaveBeenCalledTimes(1);

    // Repeated triggers do not stack additional runs.
    const afterFallback = {
      create: createCallCount(),
      download: vi.mocked(handleStartDownload).mock.calls.length,
    };
    for (const tab of [4, 5]) {
      act(() => controls.current!.switchTab(tab, `https://tab${tab}.example/`));
      await flush();
    }
    expect(createCallCount()).toBe(afterFallback.create);
    expect(handleStartDownload).toHaveBeenCalledTimes(afterFallback.download);

    unmount();
  });

  it("stale downloadOptions cannot re-arm the auto-START_DOWNLOAD effect after an interrupt (task 2.3)", async () => {
    const { controls, unmount } = renderHost();

    // Interrupt DURING the scrape phase: START_DOWNLOAD never fired for the
    // run, so a kept options object would let Effect 2 fire a zombie
    // START_DOWNLOAD the moment isScraping falls.
    await pressAndInterrupt(controls, undefined);

    expect(handleStartDownload).not.toHaveBeenCalled();
    // …and it stays unfired across churn.
    act(() => controls.current!.switchTab(9, "https://nine.example/"));
    await flush();
    expect(handleStartDownload).not.toHaveBeenCalled();
    expect(createCallCount()).toBe(1); // only the press-run's own session

    unmount();
  });

  it("full restart without a session uses the options snapshot captured before the interrupt's clear", async () => {
    const { controls, unmount } = renderHost();

    await pressAndInterrupt(controls, undefined); // no session → straight to full restart
    scrollScript = [settledResponse(), settledResponse()];
    const createBeforeRestart = createCallCount();
    await act(async () => {
      await controls.current!.restart();
    });
    await flush();

    expect(createCallCount()).toBe(createBeforeRestart + 1); // the restart's own fresh session
    expect(handleStartDownload).toHaveBeenCalledTimes(1);

    unmount();
  });
});

// ---------------------------------------------------------------------------
// BITE — old resume flow (HEAD 97c5007) vs the D2 gate.
//
// The legacy host above replicates HEAD's wiring verbatim: the interrupt
// handler keeps downloadOptions, and the resume branch flips isScraping
// true → Effect 1's run-start branch resets the Fix A gate and calls
// scrape() → a NEW server session + continued scrolling + a zombie
// START_DOWNLOAD, racing the background's checkpoint replay (the
// double-flow incident). These tests pin the OLD rule's defect verdicts so
// a regression to it is caught; against a HEAD worktree the new-rule
// expectations in the describe above fail (the hook there has no resume
// gate), which is the bite demonstration.
// ---------------------------------------------------------------------------

describe("bite — old resume flow vs the single-flow gate", () => {
  it("OLD: resume creates a SECOND server session, keeps scrolling, and fires a zombie START_DOWNLOAD", async () => {
    const { controls, unmount } = renderHost(true); // legacy = HEAD wiring

    await pressAndInterrupt(controls, "sess-1");
    const before = {
      create: createCallCount(),
      scroll: vi.mocked(handleStartScroll).mock.calls.length,
      download: vi.mocked(handleStartDownload).mock.calls.length,
    };

    // Hold the RESUME_SERVER_DOWNLOAD answer open — like the real network
    // window — so the hijacked scrape has time to run its full pipeline
    // while the resume is pending.
    holdResume();
    scrollScript = [settledResponse(), settledResponse()];
    await act(async () => {
      void controls.current!.restart();
    });
    await flush(12);
    resumeDeferred!.resolve({ success: true });
    await flush(6);

    // The pinned DEFECT verdicts of the old rule:
    expect(resumeCallCount()).toBe(1); // the background resume DID run…
    expect(createCallCount()).toBe(before.create + 1); // …AND a new session was created
    expect(vi.mocked(handleStartScroll).mock.calls.length).toBeGreaterThan(
      before.scroll,
    ); // …AND the tab was scrolled
    expect(handleStartDownload).toHaveBeenCalledTimes(before.download + 1); // …AND a zombie START_DOWNLOAD fired

    unmount();
  });
});
