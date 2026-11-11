/**
 * (multipage-download-fixes 5.1) Persisted liveness record.
 *
 * DEFECT AT HEAD: session liveness lives ONLY in the in-memory
 * `liveServerSessionIds` Set (download-state.ts) — it dies with the service
 * worker, so the panel's decisions after a worker restart read "unknown"
 * as "gone" and the poll fakes a completion. The fix persists a liveness
 * record (session id + heartbeat timestamp) in `chrome.storage.session`,
 * written at markSessionLive, refreshed by poll-acks and heartbeats, and
 * cleared by markSessionNotLive. The panel reads freshness from the
 * RECORD, never from the Set.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// chrome.storage.session fake (setup.cjs provides only storage.local)
// ---------------------------------------------------------------------------

let store: Map<string, unknown>;

function installFakeChromeStorage(): void {
  const session = {
    get: async (
      keys?: string | string[] | null,
    ): Promise<Record<string, unknown>> => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    set: async (objs: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(objs)) store.set(k, v);
    },
    remove: async (keys: string | string[]): Promise<void> => {
      for (const k of typeof keys === "string" ? [keys] : keys) {
        store.delete(k);
      }
    },
  };
  (globalThis as any).chrome = {
    ...((globalThis as any).chrome ?? {}),
    storage: { ...((globalThis as any).chrome?.storage ?? {}), session },
  };
}

// serverClient is probed by buildLiveSnapshot for non-live sessions.
vi.mock("../../src/background/server-client", () => ({
  serverClient: {
    getSessionStatus: vi.fn(async () => ({ status: "uploading" })),
  },
  ServerUnavailableError: class extends Error {},
  AuthenticationError: class extends Error {},
}));

import {
  LIVENESS_STALE_MS,
  clearLivenessRecord,
  isLivenessFresh,
  readLivenessRecord,
  writeLivenessHeartbeat,
} from "../../src/background/download-liveness";
import {
  buildLiveSnapshot,
  markSessionLive,
  markSessionNotLive,
} from "../../src/background/download-state";
import { serverClient } from "../../src/background/server-client";

const SESSION = "sess-liveness";

beforeEach(() => {
  store = new Map();
  installFakeChromeStorage();
  markSessionNotLive(SESSION);
  vi.mocked(serverClient.getSessionStatus).mockClear();
});

describe("persisted liveness record (5.1)", () => {
  it("uses a 90 s staleness bound (6 × the 15 s heartbeat cadence, documented)", () => {
    expect(LIVENESS_STALE_MS).toBe(90_000);
  });

  it("markSessionLive persists { serverSessionId, heartbeatAt } in session storage", async () => {
    const before = Date.now();
    markSessionLive(SESSION);
    // markSessionLive's write is fire-and-forget — give it a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const record = await readLivenessRecord(SESSION);
    expect(record).not.toBeNull();
    expect(record!.serverSessionId).toBe(SESSION);
    expect(record!.heartbeatAt).toBeGreaterThanOrEqual(before);
  });

  it("writeLivenessHeartbeat refreshes the timestamp", async () => {
    markSessionLive(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = (await readLivenessRecord(SESSION))!.heartbeatAt;

    writeLivenessHeartbeat(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = (await readLivenessRecord(SESSION))!.heartbeatAt;

    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("markSessionNotLive clears the record — a finished run leaves no liveness", async () => {
    markSessionLive(SESSION);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await clearLivenessRecord(SESSION);
    expect(await readLivenessRecord(SESSION)).toBeNull();
    expect(await isLivenessFresh(SESSION)).toBe(false);
  });

  it("isLivenessFresh: true inside the bound, false beyond it", async () => {
    await chrome.storage.session.set({
      "downloadLiveness:fresh": {
        serverSessionId: "fresh",
        heartbeatAt: Date.now() - LIVENESS_STALE_MS + 5_000,
      },
      "downloadLiveness:stale": {
        serverSessionId: "stale",
        heartbeatAt: Date.now() - LIVENESS_STALE_MS - 1_000,
      },
    });
    expect(await isLivenessFresh("fresh")).toBe(true);
    expect(await isLivenessFresh("stale")).toBe(false);
  });
});

describe("buildLiveSnapshot — the CHECK_DOWNLOAD_LIVE answer carries evidence", () => {
  it("a live session reports heartbeatFresh:true and refreshes the record", async () => {
    markSessionLive(SESSION, { tabId: 3, phase: "uploading" });
    const before = Date.now();
    const snap = await buildLiveSnapshot(SESSION);

    expect(snap.live).toBe(true);
    expect(snap.heartbeatFresh).toBe(true);
    const record = await readLivenessRecord(SESSION);
    expect(record).not.toBeNull();
    expect(record!.heartbeatAt).toBeGreaterThanOrEqual(before);
  });

  it("a dead session with a stale record: heartbeatFresh:false + terminal status probe", async () => {
    // Restart semantics: the record exists but nothing refreshed it.
    await chrome.storage.session.set({
      [`downloadLiveness:${SESSION}`]: {
        serverSessionId: SESSION,
        heartbeatAt: Date.now() - LIVENESS_STALE_MS - 5_000,
      },
    });

    const snap = await buildLiveSnapshot(SESSION);
    expect(snap.live).toBe(false);
    expect(snap.heartbeatFresh).toBe(false);
    expect(snap.serverStatus).toBe("uploading"); // non-terminal → unknown
    expect(serverClient.getSessionStatus).toHaveBeenCalledWith(SESSION);
  });

  it("a probe failure degrades to serverStatus:null (unknown), never throws", async () => {
    // A distinct session id: the probe result cache (5 s) would otherwise
    // serve the previous test's answer.
    const probeFailSession = "sess-probe-fail";
    vi.mocked(serverClient.getSessionStatus).mockRejectedValue(
      new Error("server unreachable"),
    );
    const snap = await buildLiveSnapshot(probeFailSession);
    expect(snap.live).toBe(false);
    expect(snap.heartbeatFresh).toBe(false);
    expect(snap.serverStatus).toBeNull();
  });

  it("no session id → non-live, no evidence, no probe", async () => {
    const snap = await buildLiveSnapshot(undefined);
    expect(snap.live).toBe(false);
    expect(snap.heartbeatFresh).toBe(false);
    expect(snap.serverStatus).toBeNull();
    expect(serverClient.getSessionStatus).not.toHaveBeenCalled();
  });
});
