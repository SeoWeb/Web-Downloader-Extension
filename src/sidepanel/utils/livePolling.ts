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
 *   - A terminal-eligible live:false is confirmed by ONE more poll (the
 *     caller keeps confirmPending) before driving the terminal state —
 *     a momentary gap must not fake an outcome.
 *   - Failure requires the background's lastError. Completion is declared
 *     ONLY when the download was seen live; a run that settled without ever
 *     being live either surfaced its own failure already or aborted early —
 *     the caller stops tracking without faking a completion card.
 */

import type { DownloadLiveSnapshot } from "../../background/download-state";

export type LivePollDecision =
  | { action: "progress"; snapshot: DownloadLiveSnapshot }
  | { action: "wait" }
  | { action: "armConfirm" }
  | { action: "finalizeFailure"; error: string }
  | { action: "finalizeComplete" }
  | { action: "stopTracking" };

export interface LivePollInput {
  /** Latest CHECK_DOWNLOAD_LIVE snapshot. */
  snapshot: DownloadLiveSnapshot;
  /** A poll for this session has returned live:true at least once. */
  sawLive: boolean;
  /** The START_DOWNLOAD promise has settled (download phase over). */
  downloadSettled: boolean;
  /** A previous live:false already armed the confirmation poll. */
  confirmPending: boolean;
}

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

  // One final poll before driving the terminal state.
  if (!confirmPending) {
    return { action: "armConfirm" };
  }

  if (snapshot.lastError) {
    return { action: "finalizeFailure", error: snapshot.lastError };
  }
  if (sawLive) {
    return { action: "finalizeComplete" };
  }
  // Settled without ever being live: the run surfaced its own outcome via
  // pushes (or aborted pre-session) — stop polling, fake nothing.
  return { action: "stopTracking" };
}
