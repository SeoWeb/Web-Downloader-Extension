/**
 * (multipage-download-fixes 5.3c / design D3 + D2) Interrupted-payload
 * routing.
 *
 * A checkpoint or DOWNLOAD_INTERRUPTED payload whose phase is `paused` is a
 * PARKED pause (the worker died while a pause was held) — it routes to the
 * Paused card (Resume/Stop), NEVER to the interrupted card. Every path that
 * surfaces an interruption (the startup push's payload, the panel's
 * CHECK_INTERRUPTED_DOWNLOAD pull, the watchdog's applier) routes through
 * this decision so the wording can never drift.
 *
 * Pure function — extracted for unit testing (livePolling/downloadRouting
 * pattern).
 */

export type InterruptPresentation = "paused" | "interrupted";

/** The phase a parked pause carries in its checkpoint. */
export const PAUSED_PHASE = "paused";

export function interruptedPresentation(
  data:
    | {
        phase?: string;
      }
    | null
    | undefined,
): InterruptPresentation {
  return data?.phase === PAUSED_PHASE ? "paused" : "interrupted";
}
