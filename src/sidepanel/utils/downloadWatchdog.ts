/**
 * (Fix 3 — design D3) Dead-worker watchdog decision logic.
 *
 * Incident: download-core.ts emits a `status.uploadProgress` heartbeat every
 * 15 s during the upload wait "so the UI can detect a dead worker" — but no
 * panel code consumed it. An MV3 service worker killed mid-wait left the
 * panel frozen on the last progress frame forever.
 *
 * Contract: while the panel tracks a server-mode download whose phase is
 * `uploading` or `assembling`, a watchdog is armed. ANY message belonging to
 * the tracked download (progress push, heartbeat, assembly progress,
 * terminal) resets the timer. 45 s of silence — three missed 15 s heartbeats,
 * comfortably above the ~30 s MV3 idle kill — transitions the panel to the
 * interrupted-download state (same card as `DOWNLOAD_INTERRUPTED`).
 *
 * Pure functions — extracted so the arm/reset/timeout decisions are
 * unit-testable without React (same pattern as downloadRouting/livePolling).
 */

import type { RoutingDecision } from "./downloadRouting";

/**
 * Silence budget before the panel declares the service worker dead:
 * 3 missed 15 s heartbeats (design D3) — tolerates two lost pushes and
 * exceeds the ~30 s MV3 idle kill, so it cannot false-positive on a single
 * dropped frame.
 */
export const WATCHDOG_TIMEOUT_MS = 45_000;

/** Inputs for the arming decision. */
export interface WatchdogArmInput {
  /** Current `serverModeState.phase` (null = idle). */
  phase: ServerModePhase;
  /** A download is tracked (live session, active poll, press-run, or resume). */
  downloadTracked: boolean;
}

/** The server-mode phases the panel can be in (ServerModeState["phase"]). */
export type ServerModePhase =
  | "scraping"
  | "uploading"
  | "assembling"
  | "ready"
  | "failed"
  | "timeout"
  | null;

/**
 * Arm decision: the watchdog exists ONLY for the server-side wait phases,
 * where the panel is otherwise a passive receiver of pushes. During
 * `scraping` the panel drives the scroll loop itself and notices silence
 * there; `ready`/`failed`/`timeout` are already terminal; a null phase is
 * idle. The watchdog never arms in those states, and not without a tracked
 * download.
 */
export function shouldArmWatchdog({
  phase,
  downloadTracked,
}: WatchdogArmInput): boolean {
  return downloadTracked && (phase === "uploading" || phase === "assembling");
}

/**
 * Reset decision: a message restarts the watchdog only when the routing
 * accepted it FOR the tracked download (progress "apply" or terminal
 * "terminal-apply"). Cross-download traffic ("ignore"/"terminal-ignore")
 * must not keep a dead worker alive.
 */
export function shouldResetWatchdog(decision: RoutingDecision): boolean {
  return decision === "apply" || decision === "terminal-apply";
}

/** Inputs for the timeout-transition guard. */
export interface WatchdogTimeoutInput {
  /** The watchdog was armed when the timer fired. */
  armed: boolean;
  /** A terminal state already resolved the tracked download. */
  terminalResolved: boolean;
}

/**
 * Timeout-transition guard: a terminal message that arrived for the tracked
 * download ALWAYS wins over a concurrently expiring watchdog — the timer
 * callback re-checks this before transitioning so an already-queued expiry
 * can never clobber a freshly resolved terminal state.
 */
export function shouldWatchdogFire({
  armed,
  terminalResolved,
}: WatchdogTimeoutInput): boolean {
  return armed && !terminalResolved;
}
