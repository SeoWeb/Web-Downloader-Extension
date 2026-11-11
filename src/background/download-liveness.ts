/**
 * (multipage-download-fixes 5.1 / design D3) Persisted download liveness.
 *
 * DEFECT: session liveness lived only in the in-memory
 * `liveServerSessionIds` Set (download-state.ts). The Set dies with the
 * service worker — a worker restart mid-run wiped it, and the panel's poll
 * read "unknown" as "gone", faking a completion.
 *
 * This module owns a `chrome.storage.session` liveness record per server
 * session: { serverSessionId, heartbeatAt }. Written at markSessionLive,
 * refreshed by the 15 s upload heartbeat, the assembly heartbeat (5.4) and
 * every CHECK_DOWNLOAD_LIVE poll-ack, and cleared by markSessionNotLive.
 * The PANEL's decisions read the RECORD's freshness — the record survives
 * worker restarts, the Set does not.
 *
 * Storage conventions mirror download-checkpoint.ts: one namespaced key per
 * download, session-scoped (cleared on browser close), tiny metadata only.
 */

import { serverClient } from "./server-client";

export const LIVENESS_KEY_PREFIX = "downloadLiveness";

/**
 * (5.2) Staleness bound for a persisted heartbeat.
 *
 * A live run refreshes its record at least every 15 s (upload heartbeat /
 * assembly heartbeat) and typically every ~2.5 s (panel poll-acks). 90 s
 * tolerates six missed heartbeat cadences and comfortably exceeds the ~30 s
 * MV3 idle kill — a heartbeat older than this proves nothing, one fresher
 * than it proves a worker answered recently.
 */
export const LIVENESS_STALE_MS = 90_000;

function livenessKey(serverSessionId: string): string {
  return `${LIVENESS_KEY_PREFIX}:${serverSessionId}`;
}

export interface DownloadLivenessRecord {
  serverSessionId: string;
  /** Epoch ms of the last heartbeat write. */
  heartbeatAt: number;
}

/** True for any liveness-record storage key. */
export function isLivenessKey(key: string): boolean {
  return key.startsWith(`${LIVENESS_KEY_PREFIX}:`);
}

/** Read the liveness record for a session (null when absent/corrupt). */
export async function readLivenessRecord(
  serverSessionId: string,
): Promise<DownloadLivenessRecord | null> {
  try {
    if (!chrome.storage?.session) return null;
    const key = livenessKey(serverSessionId);
    const result = await chrome.storage.session.get(key);
    const value = result[key] as DownloadLivenessRecord | undefined;
    if (
      value &&
      typeof value === "object" &&
      typeof value.heartbeatAt === "number"
    ) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write/refresh the liveness record. Fire-and-forget safe — callers in
 * hot paths use `void writeLivenessHeartbeat(...)`; the promise is still
 * returned for callers that want to await a settled write.
 */
export async function writeLivenessHeartbeat(
  serverSessionId: string,
): Promise<void> {
  try {
    if (!chrome.storage?.session) return;
    await chrome.storage.session.set({
      [livenessKey(serverSessionId)]: {
        serverSessionId,
        heartbeatAt: Date.now(),
      } satisfies DownloadLivenessRecord,
    });
  } catch (err) {
    // A heartbeat write failure must never break the download flow — and
    // the whole body is guarded so a vanished `chrome` global (tests,
    // teardown races) can never reject the fire-and-forget promise.
    console.debug(
      "[Liveness] heartbeat write failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Clear the record — the run is over (completion, failure, abort). */
export async function clearLivenessRecord(
  serverSessionId: string,
): Promise<void> {
  try {
    if (!chrome.storage?.session) return;
    await chrome.storage.session.remove([livenessKey(serverSessionId)]);
  } catch {
    // ignore
  }
}

/**
 * Freshness decision (5.2/5.3): the record exists AND its heartbeat is
 * inside LIVENESS_STALE_MS. Unknown (no record, no storage) is NOT fresh.
 */
export async function isLivenessFresh(
  serverSessionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const record = await readLivenessRecord(serverSessionId);
  return record !== null && now - record.heartbeatAt < LIVENESS_STALE_MS;
}

// ---------------------------------------------------------------------------
// (5.2) Terminal server-status probe for the panel's poll.
//
// When the session is NOT live in this worker (run finished or worker
// restarted) the poll needs server-side evidence: a terminal status
// (ready/failed/expired/cancelled) is authoritative and always resolves the
// poll promptly. Probes are cached briefly so the 2.5 s poll cadence cannot
// hammer the server while it waits.
// ---------------------------------------------------------------------------

export const SERVER_STATUS_PROBE_MIN_INTERVAL_MS = 5_000;

const lastStatusProbeBySession = new Map<
  string,
  { at: number; status: string | null }
>();

/**
 * Probe the server session's status. Returns the raw status string
 * ("scraping"/"uploading"/"assembling"/"ready"/"failed"/"expired"/
 * "cancelled"), or null when the probe fails or the session is unknown —
 * null means UNKNOWN, never dead. Cached for
 * SERVER_STATUS_PROBE_MIN_INTERVAL_MS per session.
 */
export async function probeServerSessionStatus(
  serverSessionId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const cached = lastStatusProbeBySession.get(serverSessionId);
  if (cached && now - cached.at < SERVER_STATUS_PROBE_MIN_INTERVAL_MS) {
    return cached.status;
  }
  try {
    const status = await serverClient.getSessionStatus(serverSessionId);
    const value = (status?.status as string | undefined) ?? null;
    lastStatusProbeBySession.set(serverSessionId, { at: now, status: value });
    return value;
  } catch {
    // Probe failure — unknown. Cache briefly so a dead server doesn't get
    // hammered by the poll loop either.
    lastStatusProbeBySession.set(serverSessionId, { at: now, status: null });
    return null;
  }
}
