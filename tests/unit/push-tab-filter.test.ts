/**
 * (Round 9 — Fix 3) Push-acceptance filter semantics.
 *
 * Incident: pushes were stamped with the DOWNLOADING tab's id but compared
 * against the panel's CURRENTLY-FOCUSED tab — every push from an active
 * download (progress and terminal outcome alike) was dropped after a tab
 * switch. The fix accepts pushes for the focused tab OR the pinned
 * download tab (press-time snapshot), and still ignores unrelated tabs.
 */

import { describe, expect, it } from "vitest";
import { isPushForPanel } from "../../src/sidepanel/utils/tabFilter";

describe("isPushForPanel (Round 9 Fix 3)", () => {
  it("accepts a push from the focused tab (unchanged behavior)", () => {
    expect(isPushForPanel(5, 5, 9)).toBe(true);
  });

  it("accepts a push from the PINNED download tab even when another tab is focused (the fix)", () => {
    // User started the download on tab 9, then focused tab 5.
    expect(isPushForPanel(9, 5, 9)).toBe(true);
  });

  it("still rejects pushes from genuinely unrelated tabs", () => {
    // Download pinned to tab 9, user focused tab 5, push from tab 42.
    expect(isPushForPanel(42, 5, 9)).toBe(false);
  });

  it("rejects unrelated tabs when nothing is pinned", () => {
    expect(isPushForPanel(42, 5, null)).toBe(false);
    expect(isPushForPanel(42, 5, 0)).toBe(false);
  });

  it("accepts a broadcast push without a tabId (legacy behavior)", () => {
    expect(isPushForPanel(undefined, 5, null)).toBe(true);
    expect(isPushForPanel(undefined, 5, 9)).toBe(true);
  });

  it("stops accepting the OLD download's pushes once a newer press re-pins", () => {
    // Download A pinned to tab 9; a newer press pinned tab 3. While the
    // user focuses neither, tab 9's late pushes are no longer accepted —
    // the panel tracks the user's latest action.
    expect(isPushForPanel(9, 42, 3)).toBe(false);
    expect(isPushForPanel(3, 42, 3)).toBe(true);
  });
});
