import { useCallback, useEffect, useRef, useState } from "react";
import { WATCHDOG_TIMEOUT_MS } from "../utils/downloadWatchdog";

export interface UseDownloadWatchdogOptions {
  /**
   * Whether the watchdog is armed — computed per render with
   * shouldArmWatchdog() (phase uploading/assembling + download tracked).
   * Flipping this to false disarms (clears the pending timer).
   */
  armed: boolean;
  /** Called once when the silence budget expires while armed. */
  onTimeout: () => void;
  /** Silence budget — 45 s (3 missed 15 s heartbeats, design D3). */
  timeoutMs?: number;
}

/**
 * (Fix 3 — design D3) Dead-worker watchdog.
 *
 * Arms a timer while `armed` holds; every call to `reset()` — wired at the
 * panel's message-routing application path so ANY message belonging to the
 * tracked download reaches it — restarts the window. When the timer fires,
 * `onTimeout` transitions the panel to the interrupted-download state.
 *
 * The effect re-runs on `armed`/`timeoutMs`/`resetCount` changes: each reset
 * tears the previous timer down and schedules a fresh one, so the panel only
 * fires after a FULL silence window with no tracked-download traffic.
 */
export function useDownloadWatchdog({
  armed,
  onTimeout,
  timeoutMs = WATCHDOG_TIMEOUT_MS,
}: UseDownloadWatchdogOptions) {
  // Bumped by reset(); a change re-runs the effect below (fresh window).
  const [resetCount, setResetCount] = useState(0);
  // Render-time mirrors so the timer callback and reset() always observe the
  // current values without re-subscribing (actionRef pattern).
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => onTimeoutRef.current(), timeoutMs);
    return () => clearTimeout(timer);
  }, [armed, timeoutMs, resetCount]);

  const reset = useCallback(() => {
    // (D3) Any message belonging to the tracked download restarts the
    // window. No-op while disarmed: traffic for an untracked download must
    // not churn panel state.
    if (armedRef.current) {
      setResetCount((count) => count + 1);
    }
  }, []);

  return { reset };
}
