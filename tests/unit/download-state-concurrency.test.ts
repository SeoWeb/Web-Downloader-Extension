/**
 * Unit tests for the active-downloads tracking used to scope teardown
 * (concurrent-downloads spec / design D7).
 *
 * `isOtherDownloadActive` is the gate download-core consults in its finally
 * block: only the LAST finishing download may run the global cleanup
 * (`requestQueue.clear()` + `memoryManager.forceCleanup()`). While a peer
 * download is still active, teardown must stay scoped.
 */

import { describe, expect, it } from "vitest";
import {
  setTabDownloadActive,
  setTabDownloadComplete,
  isAnyDownloadInProgress,
  isOtherDownloadActive,
} from "../../src/background/download-state";

// tests/setup.cjs provides the chrome.storage.local mock these helpers use.

describe("download-state concurrent-download tracking", () => {
  it("reports a peer active after one of two downloads finishes", async () => {
    await setTabDownloadActive(101);
    await setTabDownloadActive(202);
    expect(isAnyDownloadInProgress()).toBe(true);

    // Tab 101 finishes first — tab 202 is still running.
    await setTabDownloadComplete(101);
    expect(isAnyDownloadInProgress()).toBe(true);
    expect(isOtherDownloadActive(101)).toBe(true);
    // Global teardown must NOT run while the peer holds state.
    expect(isOtherDownloadActive(undefined)).toBe(true);

    // Last download finishes — full teardown becomes safe.
    await setTabDownloadComplete(202);
    expect(isAnyDownloadInProgress()).toBe(false);
    expect(isOtherDownloadActive(202)).toBe(false);
    expect(isOtherDownloadActive(undefined)).toBe(false);
  });

  it("excludes the still-registered download itself (catch-phase guard)", async () => {
    await setTabDownloadActive(7);
    // A lone download must not consider itself a peer — during the catch
    // phase it is still registered under its own tab.
    expect(isOtherDownloadActive(7)).toBe(false);
    // A different tab's id (or an unknown tab) does see it as a peer.
    expect(isOtherDownloadActive(8)).toBe(true);
    expect(isOtherDownloadActive(undefined)).toBe(true);

    await setTabDownloadComplete(7);
    expect(isOtherDownloadActive(7)).toBe(false);
    expect(isOtherDownloadActive(undefined)).toBe(false);
  });

  it("handles downloads without a tab id (undefined never matches)", async () => {
    await setTabDownloadActive(9);
    // A tab-less flow must not mistake the tabbed download for itself.
    expect(isOtherDownloadActive(undefined)).toBe(true);
    await setTabDownloadComplete(9);
    expect(isOtherDownloadActive(undefined)).toBe(false);
  });
});
