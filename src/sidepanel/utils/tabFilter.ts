/**
 * (Round 9 — Fix 3) Push-acceptance filter for the side panel.
 *
 * Incident: every background push was stamped with the DOWNLOADING tab's id,
 * but the panel compared it against its CURRENTLY-FOCUSED tab. The moment
 * the user switched tabs, every push from the active download — progress
 * AND the terminal outcome — was silently dropped, freezing the card at
 * "Images progress: 1/353" while the server received all 351 images.
 *
 * New semantics: a push is accepted when it comes from
 *   - the tab the panel is currently focused on (unchanged), OR
 *   - the PINNED download tab — the press-time snapshot of the tab whose
 *     download this panel started (useScrapingDownloader's targetRef).
 *
 * Multi-tab semantics (deliberate choice): the panel pins at most ONE
 * download at a time — a newer press re-pins the snapshot — so once a newer
 * download starts, only the newest run's pushes are accepted. The panel
 * tracks the user's latest action; downloads from genuinely unrelated tabs
 * are still ignored exactly as before. A missing tabId means "broadcast"
 * and is always accepted (legacy behavior).
 *
 * Pure function — extracted for unit testing.
 */
export function isPushForPanel(
  senderTabId: number | undefined,
  focusedTabId: number,
  pinnedDownloadTabId: number | null | undefined,
): boolean {
  if (senderTabId === undefined) return true;
  return senderTabId === focusedTabId || senderTabId === pinnedDownloadTabId;
}
