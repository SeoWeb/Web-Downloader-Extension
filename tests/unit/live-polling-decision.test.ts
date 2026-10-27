/**
 * (Round 9 — Fix B) Pure decision step for the panel's CHECK_DOWNLOAD_LIVE
 * polling loop.
 *
 * Terminal rules under test:
 * - live:true always publishes trusted progress (and re-arms confirmation).
 * - live:false is NOT terminal while the download phase was neither seen
 *   live nor settled (panel may merely be scraping).
 * - A terminal-eligible live:false needs ONE confirmation poll.
 * - lastError → finalizeFailure (works for sawLive and settled-only runs).
 * - No lastError + seen live → finalizeComplete.
 * - No lastError + settled-only → stopTracking (never fake a completion).
 */

import { describe, expect, it } from "vitest";
import {
  decideLivePollStep,
  type LivePollInput,
} from "../../src/sidepanel/utils/livePolling";
import type { DownloadLiveSnapshot } from "../../src/background/download-state";

const snapshot = (overrides: Partial<DownloadLiveSnapshot> = {}) => ({
  live: false,
  phase: null,
  completed: null,
  total: null,
  tabId: null,
  serverSessionId: "sess-poll",
  ...overrides,
});

const input = (overrides: Partial<LivePollInput> = {}): LivePollInput => ({
  snapshot: snapshot(),
  sawLive: false,
  downloadSettled: false,
  confirmPending: false,
  ...overrides,
});

describe("decideLivePollStep (Round 9 Fix B)", () => {
  it("publishes progress while the download is live", () => {
    const decision = decideLivePollStep(
      input({ snapshot: snapshot({ live: true, completed: 3, total: 9 }) }),
    );
    expect(decision).toEqual({
      action: "progress",
      snapshot: snapshot({ live: true, completed: 3, total: 9 }),
    });
  });

  it("keeps waiting when the download phase was never observed", () => {
    // Scrolling phase: session exists but is not marked live yet.
    const decision = decideLivePollStep(input());
    expect(decision).toEqual({ action: "wait" });
  });

  it("waits while settled is false even after a previous non-eligible state", () => {
    const decision = decideLivePollStep(input({ downloadSettled: false }));
    expect(decision).toEqual({ action: "wait" });
  });

  it("arms the confirmation poll on the first terminal-eligible live:false", () => {
    const decision = decideLivePollStep(input({ sawLive: true }));
    expect(decision).toEqual({ action: "armConfirm" });
  });

  it("arms confirmation for a settled-only run too", () => {
    const decision = decideLivePollStep(input({ downloadSettled: true }));
    expect(decision).toEqual({ action: "armConfirm" });
  });

  it("finalizes as FAILURE on the confirming poll when lastError is present", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ lastError: "Assembly timed out" }),
      }),
    );
    expect(decision).toEqual({
      action: "finalizeFailure",
      error: "Assembly timed out",
    });
  });

  it("finalizes as FAILURE for settled-only runs when lastError is present", () => {
    const decision = decideLivePollStep(
      input({
        downloadSettled: true,
        confirmPending: true,
        snapshot: snapshot({ lastError: "Session expired" }),
      }),
    );
    expect(decision).toEqual({
      action: "finalizeFailure",
      error: "Session expired",
    });
  });

  it("finalizes as COMPLETE only when the download was seen live", () => {
    const decision = decideLivePollStep(
      input({ sawLive: true, confirmPending: true }),
    );
    expect(decision).toEqual({ action: "finalizeComplete" });
  });

  it("never fakes a completion for a run that settled without being live", () => {
    const decision = decideLivePollStep(
      input({ downloadSettled: true, confirmPending: true }),
    );
    expect(decision).toEqual({ action: "stopTracking" });
  });

  it("treats a resurrected live:true as progress, not as a confirmed terminal", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ live: true, completed: 40, total: 99 }),
      }),
    );
    expect(decision.action).toBe("progress");
  });
});
