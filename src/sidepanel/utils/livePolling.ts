/**
 * (Round 9 — Fix B) Pure decision step for the panel's CHECK_DOWNLOAD_LIVE
 * polling loop. Extracted from sidepanel.tsx for unit testing (same pattern
 * as decideScrollStop in useScrapingDownloader).
 *
 * Terminal rule ("progress you can trust"):
 *   - live:true  → publish the snapshot as trusted progress.
 *   - live:false → only terminal-eligible once the download was actually
 *     SEEN live (sawLive) or START_DOWNLOAD has settled (downloadSettled).
 *     While the panel is merely scraping (session not yet marked live) a
 *     live:false is normal, never terminal.
 *   - (multipage-download-fixes 5.2 / design D3) Completion declarations
 *     require EVIDENCE — never absence of it:
 *       • A terminal server status (`ready`/`failed`/`expired`/
 *         `cancelled`, probed by the background when the session is not
 *         live) resolves the poll PROMPTLY — evidence-based completion is
 *         never delayed, and needs no confirmation poll.
 *         `ready` → complete; `failed`/`expired` → failure (recorded
 *         lastError or the unknown-error fallback); `cancelled` →
 *         stopTracking (a cancellation is not a completion — the
 *         status.cancelled push carries the real outcome).
 *       • A fresh persisted heartbeat proves the worker is ALIVE — it
 *         never completes anything; the poll keeps waiting for the run's
 *         own terminal outcome.
 *       • Lost/stale heartbeat + no terminal status is UNKNOWN: after the
 *         confirmation poll the poll KEEPS WAITING. The false-positive
 *         path (a service-worker restart wipes the in-memory liveness Set
 *         → live:false + sawLive → "Done!") is closed; a genuinely dead
 *         run is resolved by the interrupted path instead (startup-cleanup
 *         push / watchdog probe → DOWNLOAD_INTERRUPTED), and a finished
 *         run always leaves a terminal server status behind.
 *   - Failure still requires the background's lastError when no terminal
 *     status is available.
 */

import type {
  DownloadLiveEvidence,
  DownloadLiveSnapshot,
} from "../../background/download-state";

export type LivePollDecision =
  | { action: "progress"; snapshot: DownloadLiveSnapshot }
  | { action: "wait" }
  | { action: "armConfirm" }
  | { action: "finalizeFailure"; error: string }
  | { action: "finalizeComplete" }
  | { action: "stopTracking" };

export interface LivePollInput {
  /** Latest CHECK_DOWNLOAD_LIVE snapshot (with 5.1/5.2 evidence fields). */
  snapshot: DownloadLiveEvidence;
  /** A poll for this session has returned live:true at least once. */
  sawLive: boolean;
  /** The START_DOWNLOAD promise has settled (download phase over). */
  downloadSettled: boolean;
  /** A previous live:false already armed the confirmation poll. */
  confirmPending: boolean;
}

/** Server statuses that are terminal failure evidence (incl. TTL expiry). */
const FAILURE_STATUSES = new Set(["failed", "expired"]);

export function decideLivePollStep({
  snapshot,
  sawLive,
  downloadSettled,
  confirmPending,
}: LivePollInput): LivePollDecision {
  if (snapshot.live) {
    return { action: "progress", snapshot };
  }

  // Not terminal-eligible yet: still scrolling, or the run's download phase
  // has neither been observed live nor settled.
  if (!sawLive && !downloadSettled) {
    return { action: "wait" };
  }

  // (5.2) Evidence-based terminals resolve PROMPTLY — no confirmation
  // delay. The server status is authoritative, not a momentary gap.
  const serverStatus = snapshot.serverStatus ?? null;
  if (serverStatus === "ready") {
    return { action: "finalizeComplete" };
  }
  if (serverStatus && FAILURE_STATUSES.has(serverStatus)) {
    return {
      action: "finalizeFailure",
      error: snapshot.lastError ?? "",
    };
  }
  if (serverStatus === "cancelled") {
    // A cancelled session is not a completion — pushes (or the storage
    // fallback) carry the real cancelled outcome. Stop the poll.
    return { action: "stopTracking" };
  }

  // (5.2) One confirmation poll before any terminal decision (a momentary
  // live:false flap must not fake an outcome).
  if (!confirmPending) {
    return { action: "armConfirm" };
  }

  if (snapshot.lastError) {
    return { action: "finalizeFailure", error: snapshot.lastError };
  }

  // Settled without ever being live: the run surfaced its own outcome via
  // pushes already, or aborted pre-session. Stop polling and fake NOTHING
  // (this is not a completion — no terminal state is declared).
  if (!sawLive) {
    return { action: "stopTracking" };
  }

  // (5.2) No terminal evidence: silence + lost liveness are UNKNOWN.
  // A fresh heartbeat proves the worker is alive; a stale one proves
  // nothing. Either way the poll KEEPS WAITING instead of faking a
  // completion — the interrupted path resolves genuinely dead runs.
  return { action: "wait" };
}
