/**
 * @vitest-environment jsdom
 *
 * (Round 9 — Fix B/4) Hook-level tests for the new useScrapingDownloader
 * panel callbacks.
 *
 * - onDownloadStarted fires exactly once per run, with the run's server
 *   session id, when the download phase begins (START_DOWNLOAD about to
 *   fire) — the panel pins its CHECK_DOWNLOAD_LIVE polling to that session.
 * - onDownloadSettled fires when the START_DOWNLOAD promise settles.
 * - A response-carried failure ({success:false, error}) resets the run
 *   state (downloadResponse cleared) via the onFailure hook.
 *
 * Harness: react-dom/client createRoot + act() (same pattern as
 * use-scraping-downloader-single-fire.test.tsx).
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

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = { tabId: 1, tabUrl: "https://origin.example/page" };

const settledResponse = () => ({
  top: 400,
  height: 1000,
  viewportHeight: 600,
  html: "<html><body>settled</body></html>",
  heightChanged: false,
  hydrationElapsedMs: 5000,
  imagesPending: 0,
});

function installDefaultMocks() {
  vi.mocked(sendMessageToBackground).mockImplementation(
    async (action: string) => {
      if (action === messageActions.SERVER_CREATE_SESSION) {
        return { success: true, sessionId: "sess-round9" };
      }
      if (action === messageActions.SERVER_UPLOAD_HTML_CHUNK) {
        return { success: true };
      }
      return {};
    },
  );
  vi.mocked(handleStartScroll).mockResolvedValue(settledResponse());
  vi.mocked(handleStartDownload).mockResolvedValue([]);
}

interface HostControls {
  press: () => void;
  switchTab: (tabId: number, tabUrl: string) => void;
  downloadResponse: () => unknown;
}

function TestHost({
  controls,
  callbacks,
}: {
  controls: React.RefObject<HostControls | null>;
  callbacks: {
    onDownloadStarted: (serverSessionId: string | null) => void;
    onDownloadSettled: () => void;
  };
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
    onDownloadStarted: callbacks.onDownloadStarted,
    onDownloadSettled: callbacks.onDownloadSettled,
  });

  controls.current = {
    press: () => {
      setIsScraping(true);
      setDownloadOptions({ downloadHTML: true, singleFile: false });
    },
    switchTab: (nextTabId, nextTabUrl) => {
      setTabId(nextTabId);
      setTabUrl(nextTabUrl);
    },
    downloadResponse: () => hook.downloadResponse,
  };

  return null;
}

function renderHost(callbacks: {
  onDownloadStarted: (serverSessionId: string | null) => void;
  onDownloadSettled: () => void;
}) {
  const controls: React.RefObject<HostControls | null> = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TestHost controls={controls} callbacks={callbacks} />);
  });
  return {
    controls,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  installDefaultMocks();
});

describe("useScrapingDownloader — Round 9 panel callbacks", () => {
  it("fires onDownloadStarted once with the run's session id, then onDownloadSettled", async () => {
    const onDownloadStarted = vi.fn();
    const onDownloadSettled = vi.fn();
    const { controls, unmount } = renderHost({
      onDownloadStarted,
      onDownloadSettled,
    });

    act(() => controls.current!.press());
    await flush();

    expect(onDownloadStarted).toHaveBeenCalledTimes(1);
    expect(onDownloadStarted).toHaveBeenCalledWith("sess-round9");
    expect(onDownloadSettled).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not re-fire the callbacks on tab switches after the download fired", async () => {
    const onDownloadStarted = vi.fn();
    const onDownloadSettled = vi.fn();
    const { controls, unmount } = renderHost({
      onDownloadStarted,
      onDownloadSettled,
    });

    act(() => controls.current!.press());
    await flush();

    // Dependency churn (tab switch) must not re-fire anything — the
    // single-fire gate covers the callbacks too.
    act(() => controls.current!.switchTab(2, "https://tab2.example/"));
    await flush();

    expect(onDownloadStarted).toHaveBeenCalledTimes(1);
    expect(onDownloadSettled).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("clears downloadResponse when the START_DOWNLOAD response carries a failure", async () => {
    // The mocked handler mimics handleStartDownload's Round 9 contract:
    // invoke the onFailure hook, then resolve (the message channel resolves
    // background rejections instead of rejecting).
    vi.mocked(handleStartDownload).mockImplementation(
      async (...args: unknown[]) => {
        const onFailure = args[5] as (() => void) | undefined;
        onFailure?.();
        return undefined;
      },
    );

    const onDownloadStarted = vi.fn();
    const onDownloadSettled = vi.fn();
    const { controls, unmount } = renderHost({
      onDownloadStarted,
      onDownloadSettled,
    });

    act(() => controls.current!.press());
    await flush();

    // The run's state was reset — the panel must not sit on the
    // downloading card after a terminal failure.
    expect(controls.current!.downloadResponse()).toBeNull();
    expect(onDownloadSettled).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps downloadResponse on a successful settle (filter stays hidden)", async () => {
    const onDownloadStarted = vi.fn();
    const onDownloadSettled = vi.fn();
    const { controls, unmount } = renderHost({
      onDownloadStarted,
      onDownloadSettled,
    });

    act(() => controls.current!.press());
    await flush();

    expect(controls.current!.downloadResponse()).not.toBeNull();
    unmount();
  });
});
