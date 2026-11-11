/**
 * (multipage-download-fixes 5.6 / design D2) Paused-card resume routing.
 *
 * Two pause flavors share one card:
 *   - HELD pause: the worker is alive; Resume goes through the existing
 *     SCRAPER_RESUME path (scraper-state.resumeScraping).
 *   - PARKED pause: the worker died while paused (phase-`paused`
 *     checkpoint + queue snapshot survived); Resume re-spawns the scraper
 *     from the snapshot via SCRAPER_RESUME_FROM_PARK.
 *
 * Stop needs no routing — the background's SCRAPER_STOP case already
 * detects a parked download when no live scraper exists and finalizes the
 * partial via the salvage path.
 *
 * Pure function — extracted for unit testing.
 */

export type PausedResumeAction = "resumeLive" | "resumeFromPark";

export function choosePausedResumeAction(parked: boolean): PausedResumeAction {
  return parked ? "resumeFromPark" : "resumeLive";
}
