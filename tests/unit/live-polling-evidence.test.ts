/**
 * (multipage-download-fixes 5.2 / design D3) Completion declarations require
 * liveness or terminal evidence.
 *
 * DEFECT AT HEAD: decideLivePollStep declares finalizeComplete from
 * `live:false + sawLive:true + no lastError` alone. A service-worker restart
 * mid-run wipes the in-memory liveServerSessionIds Set, so the panel's
 * 2.5 s poll observes live:false with no error → false "Done!" headline
 * (livePolling.ts) while subpages are still pending server-side.
 *
 * NEW CONTRACT: completion requires EVIDENCE —
 *   - terminal server status (`ready` → complete, `failed`/`expired` →
 *     failure, `cancelled` → stop tracking), declared PROMPTLY (no
 *     confirmation poll delay), or
 *   - nothing else: a lost/stale heartbeat and silence are UNKNOWN, and the
 *     poll keeps waiting ("wait"/"armConfirm" posture). A fresh heartbeat
 *     only proves the worker is alive — it never completes the download.
 */

import { describe, expect, it } from "vitest";
import {
  decideLivePollStep,
  type LivePollInput,
} from "../../src/sidepanel/utils/livePolling";
import type { DownloadLiveSnapshot } from "../../src/background/download-state";

/** Snapshot extended with the (5.1)/(5.2) evidence fields. */
const snapshot = (
  overrides: Partial<DownloadLiveSnapshot> & {
    heartbeatFresh?: boolean;
    serverStatus?: string | null;
  } = {},
) => ({
  live: false,
  phase: null,
  completed: null,
  total: null,
  tabId: null,
  serverSessionId: "sess-restart",
  heartbeatFresh: false,
  serverStatus: null as string | null,
  ...overrides,
});

const input = (
  overrides: Partial<LivePollInput> & {
    snapshot?: ReturnType<typeof snapshot>;
  } = {},
): LivePollInput =>
  ({
    snapshot: snapshot(),
    sawLive: false,
    downloadSettled: false,
    confirmPending: false,
    ...overrides,
  }) as LivePollInput;

describe("decideLivePollStep — completion requires evidence (5.2 / D3)", () => {
  it("SW restart mid-run (record lost, checkpoint exists, sawLive, no error) does NOT complete — keeps waiting", () => {
    // Restart semantics: a prior record proved liveness once (sawLive),
    // the new storage read shows NO heartbeat (stale record) and the
    // server session is not terminal (still scraping/uploading).
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ heartbeatFresh: false, serverStatus: null }),
      }),
    );
    expect(decision).toEqual({ action: "wait" });
  });

  it("a FRESH heartbeat without terminal status never completes — the worker is alive", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ heartbeatFresh: true, serverStatus: null }),
      }),
    );
    expect(decision).toEqual({ action: "wait" });
  });

  it("arms the confirmation poll on the first evidence-less live:false (unchanged posture)", () => {
    const decision = decideLivePollStep(input({ sawLive: true }));
    expect(decision).toEqual({ action: "armConfirm" });
  });

  it("terminal server status `ready` completes PROMPTLY — no confirmation delay", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: false,
        snapshot: snapshot({ serverStatus: "ready" }),
      }),
    );
    expect(decision).toEqual({ action: "finalizeComplete" });
  });

  it("terminal `ready` completes even without a heartbeat and without prior liveness", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: false,
        downloadSettled: true,
        confirmPending: false,
        snapshot: snapshot({ heartbeatFresh: false, serverStatus: "ready" }),
      }),
    );
    expect(decision).toEqual({ action: "finalizeComplete" });
  });

  it("terminal `failed` finalizes as failure with the recorded error", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: false,
        snapshot: snapshot({
          serverStatus: "failed",
          lastError: "Assembly failed",
        }),
      }),
    );
    expect(decision).toEqual({
      action: "finalizeFailure",
      error: "Assembly failed",
    });
  });

  it("terminal `expired` (server TTL) finalizes as failure, not a wait", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ serverStatus: "expired" }),
      }),
    );
    expect(decision.action).toBe("finalizeFailure");
  });

  it("terminal `cancelled` stops tracking — a cancellation is never a completion", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: false,
        snapshot: snapshot({ serverStatus: "cancelled" }),
      }),
    );
    expect(decision).toEqual({ action: "stopTracking" });
  });

  it("still waits while the download phase was never observed (unchanged)", () => {
    const decision = decideLivePollStep(input());
    expect(decision).toEqual({ action: "wait" });
  });

  it("live:true still publishes trusted progress (unchanged)", () => {
    const decision = decideLivePollStep(
      input({
        snapshot: snapshot({ live: true, completed: 3, total: 9 }),
      }),
    );
    expect(decision).toEqual({
      action: "progress",
      snapshot: snapshot({ live: true, completed: 3, total: 9 }),
    });
  });

  it("lastError on the confirming poll still finalizes as failure (unchanged)", () => {
    const decision = decideLivePollStep(
      input({
        sawLive: true,
        confirmPending: true,
        snapshot: snapshot({ lastError: "Session expired" }),
      }),
    );
    expect(decision).toEqual({
      action: "finalizeFailure",
      error: "Session expired",
    });
  });
});
