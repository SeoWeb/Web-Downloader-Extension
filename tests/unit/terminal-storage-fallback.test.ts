/**
 * Terminal-message storage fallback (D4).
 *
 * Writer side (tasks 5.3): download-listener.ts mirrors the pre-existing
 * `downloadComplete` record for ALL terminal states — written BEFORE the
 * fire-and-forget panel push, guarded by
 * `chrome.storage && chrome.storage.local` exactly like the
 * downloadComplete writer:
 *
 *   chrome.storage.local.set({
 *     downloadCancelled: { downloadId, tabId, timestamp }, // onChanged AND onErased paths
 *     downloadFailed:    { downloadId, error, tabId, timestamp },
 *   })
 *
 * Panel side (task 5.5): the panel's chrome.storage.onChanged consumer
 * (sidepanel.tsx) applies each record to EXACTLY the live message's state
 * (the shared terminal appliers), exactly once — a record is skipped when a
 * live terminal message already resolved the tracked download
 * (resolvedTerminalRef guard, same dedup idea as downloadComplete's
 * actionRef check) — and is removed after consumption in EVERY branch.
 * Records route by the PINNED download identity (classifyTerminalRecord),
 * never the live tab.
 *
 * Harness note: the consumer body is not importable (sidepanel.tsx mounts
 * at module scope), so the "panel" describe below mirrors it LINE FOR LINE
 * around the REAL classifyTerminalRecord routing; the mirrored block cites
 * the sidepanel.tsx section. Verified BY READING: the real handler applies
 * the same guards in the same order and calls the same appliers.
 */

import { initializeDownloadListener } from "../../src/background/download-listener";
import { activeDownloads } from "../../src/background/download-state";
import { sendMessageToPanel } from "../../src/background/message";
import {
  classifyTerminalRecord,
  type DownloadIdentity,
} from "../../src/sidepanel/utils/downloadRouting";

// download-listener only needs sendMessageToPanel from the background
// message module — mock away the rest of the graph.
vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: vi.fn().mockResolvedValue(undefined),
}));

const storageSet = vi.fn(async () => {});
const downloadsSearch = vi.fn(async () => [{}]);

type OnChangedListener = (delta: any) => Promise<void>;
type OnErasedListener = (downloadId: number) => Promise<void>;

const onChangedListeners: OnChangedListener[] = [];
const onErasedListeners: OnErasedListener[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps mockResolvedValue implementations — restore the
  // default (no error ⇒ cancellation branch) after the FAILED test.
  downloadsSearch.mockResolvedValue([{}]);
  activeDownloads.clear();
  onChangedListeners.length = 0;
  onErasedListeners.length = 0;
  Object.defineProperty(globalThis, "chrome", {
    value: {
      downloads: {
        onChanged: {
          addListener: (fn: OnChangedListener) => onChangedListeners.push(fn),
        },
        onErased: {
          addListener: (fn: OnErasedListener) => onErasedListeners.push(fn),
        },
        search: downloadsSearch,
      },
      storage: {
        local: {
          set: storageSet,
          get: vi.fn(async () => ({ downloads: {} })),
        },
      },
    },
    configurable: true,
  });
  initializeDownloadListener();
});

describe("terminal storage fallback — writer side (task 5.3)", () => {
  it("writes downloadCancelled before the push when a tracked download is cancelled (onChanged)", async () => {
    // error === undefined ⇒ save-dialog cancellation (scenario 1);
    // "USER_CANCELED" hits the same branch.
    downloadsSearch.mockResolvedValue([{ error: undefined }]);
    activeDownloads.set(5, { tabId: 7, filename: "page.pdf" });

    await onChangedListeners[0]({ id: 5, state: { current: "interrupted" } });

    expect(storageSet).toHaveBeenCalledWith({
      downloadCancelled: {
        downloadId: 5,
        tabId: 7,
        timestamp: expect.any(Number),
      },
    });
    expect(sendMessageToPanel).toHaveBeenCalledWith(
      "DOWNLOAD_CANCELLED",
      { downloadId: 5 },
      false,
      7,
    );
    // Storage write precedes the fire-and-forget push (mirror of
    // downloadComplete's write-then-push ordering).
    expect(storageSet.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendMessageToPanel).mock.invocationCallOrder[0],
    );
    // Tracking cleanup still runs.
    expect(activeDownloads.has(5)).toBe(false);
  });

  it("writes downloadFailed with the error before the push (onChanged)", async () => {
    downloadsSearch.mockResolvedValue([{ error: "NETWORK_FAILED" }]);
    activeDownloads.set(6, { tabId: 8, filename: "page.pdf" });

    await onChangedListeners[0]({ id: 6, state: { current: "interrupted" } });

    expect(storageSet).toHaveBeenCalledWith({
      downloadFailed: {
        downloadId: 6,
        error: "NETWORK_FAILED",
        tabId: 8,
        timestamp: expect.any(Number),
      },
    });
    expect(sendMessageToPanel).toHaveBeenCalledWith(
      "DOWNLOAD_FAILED",
      { downloadId: 6, error: "NETWORK_FAILED" },
      false,
      8,
    );
    expect(activeDownloads.has(6)).toBe(false);
  });

  it("writes downloadCancelled on the onErased path (save-dialog cancel)", async () => {
    activeDownloads.set(9, { tabId: 3, filename: "page.pdf" });

    await onErasedListeners[0](9);

    expect(storageSet).toHaveBeenCalledWith({
      downloadCancelled: {
        downloadId: 9,
        tabId: 3,
        timestamp: expect.any(Number),
      },
    });
    expect(sendMessageToPanel).toHaveBeenCalledWith(
      "DOWNLOAD_CANCELLED",
      { downloadId: 9 },
      false,
      3,
    );
    expect(activeDownloads.has(9)).toBe(false);
  });

  it("skips the fallback write but still pushes when chrome.storage.local is unavailable", async () => {
    Object.defineProperty(globalThis, "chrome", {
      value: {
        downloads: {
          onChanged: {
            addListener: (fn: OnChangedListener) => onChangedListeners.push(fn),
          },
          onErased: {
            addListener: (fn: OnErasedListener) => onErasedListeners.push(fn),
          },
          search: downloadsSearch,
        },
        storage: undefined,
      },
      configurable: true,
    });
    onChangedListeners.length = 0;
    initializeDownloadListener();

    activeDownloads.set(4, { tabId: 2, filename: "page.pdf" });

    await onChangedListeners[0]({ id: 4, state: { current: "interrupted" } });

    expect(storageSet).not.toHaveBeenCalled();
    expect(sendMessageToPanel).toHaveBeenCalledWith(
      "DOWNLOAD_CANCELLED",
      { downloadId: 4 },
      false,
      2,
    );
  });

  it("keeps writing the pre-existing downloadComplete record (mirror reference)", async () => {
    activeDownloads.set(11, { tabId: 21, filename: "page.pdf" });

    await onChangedListeners[0]({ id: 11, state: { current: "complete" } });

    expect(storageSet).toHaveBeenCalledWith({
      downloadComplete: {
        downloadId: 11,
        filename: "page.pdf",
        tabId: 21,
        timestamp: expect.any(Number),
      },
    });
    expect(sendMessageToPanel).toHaveBeenCalledWith(
      "DOWNLOAD_COMPLETE",
      { downloadId: 11, filename: "page.pdf" },
      false,
      21,
    );
  });
});

// ---------------------------------------------------------------------------
// Panel side (task 5.5) — the panel's chrome.storage.onChanged consumer.
//
// The harness below mirrors sidepanel.tsx's handleStorageChange verbatim
// (the CANCELLED / FAILED record blocks) around the REAL
// classifyTerminalRecord, with the panel state it reads replaced by
// explicit variables: actionRef→actionDone (DOWNLOAD_DONE marker),
// resolvedTerminalRef→resolvedTerminal, the appliers→applyXState mocks that
// set the same markers the real appliers set.
// ---------------------------------------------------------------------------

type StorageDelta = { [key: string]: chrome.storage.StorageChange };

function createPanelStorageConsumer(identity: DownloadIdentity) {
  // Mirrors sidepanel.tsx state (actionRef / resolvedTerminalRef) and the
  // terminal appliers' marker updates.
  let actionDone = false;
  let resolvedTerminal: string | null = null;
  const applied: Array<"complete" | "cancelled" | "failed"> = [];
  const removals: string[] = [];

  const appliers = {
    complete: () => {
      resolvedTerminal = "complete";
      actionDone = true;
      applied.push("complete");
    },
    cancelled: () => {
      resolvedTerminal = "cancelled";
      applied.push("cancelled");
    },
    failed: () => {
      resolvedTerminal = "failed";
      applied.push("failed");
    },
  };

  // The LIVE message path: messageWorker's terminal cases run the appliers
  // unconditionally when the routing accepts the message.
  const receiveLiveTerminal = (kind: "complete" | "cancelled" | "failed") => {
    appliers[kind]();
  };

  const handleStorageChange = (changes: StorageDelta, areaName: string) => {
    if (areaName !== "local") return;

    if (changes.downloadComplete) {
      const record = changes.downloadComplete.newValue;
      if (
        record &&
        classifyTerminalRecord(identity, record) !== "terminal-ignore"
      ) {
        // Guard: skip if already handled via DOWNLOAD_COMPLETE message
        if (actionDone) {
          removals.push("downloadComplete");
        } else {
          appliers.complete();
          removals.push("downloadComplete");
        }
      }
    }

    if (changes.downloadCancelled) {
      const record = changes.downloadCancelled.newValue;
      if (
        record &&
        classifyTerminalRecord(identity, record) !== "terminal-ignore"
      ) {
        // Guard: skip when a live terminal message already resolved the
        // tracked download (same dedup pattern as downloadComplete).
        if (resolvedTerminal !== null) {
          removals.push("downloadCancelled");
        } else {
          appliers.cancelled();
          removals.push("downloadCancelled");
        }
      }
    }

    if (changes.downloadFailed) {
      const record = changes.downloadFailed.newValue;
      if (
        record &&
        classifyTerminalRecord(identity, record) !== "terminal-ignore"
      ) {
        // Guard: skip when a live terminal message already resolved the
        // tracked download (same dedup pattern as downloadComplete).
        if (resolvedTerminal !== null) {
          removals.push("downloadFailed");
        } else {
          appliers.failed();
          removals.push("downloadFailed");
        }
      }
    }
  };

  return {
    handleStorageChange,
    receiveLiveTerminal,
    applied,
    removals,
    resolvedTerminal: () => resolvedTerminal,
  };
}

const TRACKED_IDENTITY: DownloadIdentity = {
  originTabId: 9,
  serverSessionId: "sess-1",
};

describe("terminal storage fallback — panel side (task 5.5)", () => {
  it.each([
    ["downloadCancelled", { downloadId: 5, tabId: 9, timestamp: 1 }],
    [
      "downloadFailed",
      { downloadId: 6, error: "NETWORK_FAILED", tabId: 9, timestamp: 1 },
    ],
  ] as const)(
    "applies a %s record exactly once when the push and the storage event both arrive",
    (key, record) => {
      const panel = createPanelStorageConsumer(TRACKED_IDENTITY);

      // The record is observed twice (storage event + the close-in-time
      // arrival window with the push) — the handler applies it ONCE.
      panel.handleStorageChange({ [key]: { newValue: record } }, "local");
      panel.handleStorageChange({ [key]: { newValue: record } }, "local");

      const kind = key === "downloadCancelled" ? "cancelled" : "failed";
      expect(panel.applied).toEqual([kind]);
      expect(panel.resolvedTerminal()).toBe(kind);
      // Cleaned up after consumption — on every invocation.
      expect(panel.removals).toEqual([key, key]);
    },
  );

  it.each([
    ["downloadCancelled", { downloadId: 5, tabId: 9, timestamp: 1 }],
    [
      "downloadFailed",
      { downloadId: 6, error: "NETWORK_FAILED", tabId: 9, timestamp: 1 },
    ],
  ] as const)(
    "skips a %s record when the live message already resolved the state (resolvedTerminalRef guard), but still cleans up",
    (key, record) => {
      const panel = createPanelStorageConsumer(TRACKED_IDENTITY);
      // The live push arrived first: the message handler already resolved
      // the tracked download.
      panel.receiveLiveTerminal(
        key === "downloadCancelled" ? "cancelled" : "failed",
      );
      const applicationsBefore = panel.applied.length;

      panel.handleStorageChange({ [key]: { newValue: record } }, "local");

      // No second application — the storage record is only cleaned up.
      expect(panel.applied.length).toBe(applicationsBefore);
      expect(panel.removals).toEqual([key]);
    },
  );

  it("ignores a downloadCancelled record that provably belongs to a different download (identity routing)", () => {
    const panel = createPanelStorageConsumer(TRACKED_IDENTITY);

    panel.handleStorageChange(
      {
        downloadCancelled: {
          newValue: { downloadId: 5, tabId: 42, timestamp: 1 },
        },
      },
      "local",
    );

    expect(panel.applied).toEqual([]);
    expect(panel.removals).toEqual([]);
    expect(panel.resolvedTerminal()).toBeNull();
  });

  it("ignores a downloadFailed record that provably belongs to a different download (identity routing)", () => {
    const panel = createPanelStorageConsumer(TRACKED_IDENTITY);

    panel.handleStorageChange(
      {
        downloadFailed: {
          newValue: { downloadId: 6, error: "X", tabId: 42, timestamp: 1 },
        },
      },
      "local",
    );

    expect(panel.applied).toEqual([]);
    expect(panel.removals).toEqual([]);
    expect(panel.resolvedTerminal()).toBeNull();
  });
});
