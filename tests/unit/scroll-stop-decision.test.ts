/**
 * (Fix C — hydration window) Unit tests for the pure scroll early-stop
 * decision extracted from useScrapingDownloader.
 *
 * Incident: pressing download on a still-hydrating page produced an instant
 * "successful" 0-resource download — the pre-hydration skeleton DOM is
 * already "at bottom" with no growth, which the old settle logic read as
 * settled after a single 200ms step.
 *
 * New contract:
 * - the settled/stuck stops require a minimum elapsed time AND
 *   MIN_SETTLES_BEFORE_STOP consecutive no-growth settles AND no visible
 *   <img> still loading (bounded by a time cap),
 * - the max-scroll-attempts safety stop is NOT gated by the window,
 * - with the window disabled (minDurationMs 0 / minSettles 1) the decision
 *   matches the legacy behavior exactly.
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The pure decision lives in the hook module; mock the hook's side-effectful
// imports so loading it never pulls the real background/chrome graph
// (client/message → common/chrome → background/message → jobs → download,
// which touches chrome.downloads at module load).
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../src/sidepanel/utils/messageHandlers", () => ({
  handleStartScroll: vi.fn(),
  handleStartDownload: vi.fn(),
}));
vi.mock("../../src/client/message", () => ({
  sendMessageToBackground: vi.fn(),
}));

import {
  decideScrollStop,
  IMAGE_SETTLE_CAP_MS,
  MIN_SCRAPE_DURATION_MS,
  MIN_SETTLES_BEFORE_STOP,
  type ScrollingResponse,
} from "../../src/sidepanel/hooks/useScrapingDownloader";

/** A response that is "at bottom" (top + viewport >= height - 100). */
function settledResponse(
  overrides: Partial<ScrollingResponse> = {},
): ScrollingResponse {
  return {
    top: 400,
    height: 1000,
    viewportHeight: 600,
    html: "<html></html>",
    heightChanged: false,
    hydrationElapsedMs: MIN_SCRAPE_DURATION_MS + 1,
    imagesPending: 0,
    ...overrides,
  };
}

describe("decideScrollStop — hydration window (Fix C)", () => {
  it("does NOT stop on the first no-growth settle (needs consecutive settles)", () => {
    const decision = decideScrollStop({
      prev: null,
      response: settledResponse(),
      prevHeight: 1000,
      settleCount: 0,
      scrollAttempts: 5,
    });

    expect(decision.stop).toBe(false);
    expect(decision.nextSettleCount).toBe(1);
  });

  it("does NOT stop before the minimum elapsed duration even when settles accumulated", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({ hydrationElapsedMs: 200 }),
      prevHeight: 1000,
      settleCount: MIN_SETTLES_BEFORE_STOP - 1,
      scrollAttempts: 5,
    });

    // Second consecutive settle, but only 200ms elapsed → hydration window
    // not yet satisfied → keep scrolling.
    expect(decision.stop).toBe(false);
    expect(decision.nextSettleCount).toBe(MIN_SETTLES_BEFORE_STOP);
  });

  it("stops once duration + consecutive settles + no pending images are satisfied", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse(),
      prevHeight: 1000,
      settleCount: MIN_SETTLES_BEFORE_STOP - 1,
      scrollAttempts: 5,
    });

    expect(decision.stop).toBe(true);
    expect(decision.reason).toBe("settled");
  });

  it("does NOT stop while visible images are still loading (before the cap)", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({
        hydrationElapsedMs: 5000, // past the duration floor, before the cap
        imagesPending: 3,
      }),
      prevHeight: 1000,
      settleCount: MIN_SETTLES_BEFORE_STOP - 1,
      scrollAttempts: 5,
    });

    expect(decision.stop).toBe(false);
  });

  it("stops despite pending images once the image cap elapsed (no infinite stall)", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({
        hydrationElapsedMs: IMAGE_SETTLE_CAP_MS + 1,
        imagesPending: 3,
      }),
      prevHeight: 1000,
      settleCount: MIN_SETTLES_BEFORE_STOP - 1,
      scrollAttempts: 5,
    });

    expect(decision.stop).toBe(true);
    expect(decision.reason).toBe("settled");
  });

  it("gates the STUCK stop (short page, no scroll movement) behind the window", () => {
    // Short skeleton page: viewport taller than the page, position never
    // moves. This is exactly the pre-hydration incident shape.
    const short = { top: 0, height: 500, viewportHeight: 600 };

    // Too early → no stop (legacy stopped immediately here).
    const early = decideScrollStop({
      prev: { ...short },
      response: settledResponse({
        ...short,
        hydrationElapsedMs: 0,
      }),
      prevHeight: 500,
      settleCount: 0,
      scrollAttempts: 1,
    });
    expect(early.stop).toBe(false);

    // After the window → stuck stop.
    const after = decideScrollStop({
      prev: { ...short },
      response: settledResponse({ ...short }),
      prevHeight: 500,
      settleCount: 0,
      scrollAttempts: 3,
    });
    expect(after.stop).toBe(true);
    expect(after.reason).toBe("stuck");
  });

  it("NEVER gates the max-attempts safety stop behind the window", () => {
    const decision = decideScrollStop({
      prev: { top: 100, height: 5000, viewportHeight: 600 },
      response: settledResponse({
        top: 100, // not at bottom, images pending, elapsed 0
        height: 5000,
        hydrationElapsedMs: 0,
        imagesPending: 10,
        heightChanged: true,
      }),
      prevHeight: 5000,
      settleCount: 0,
      scrollAttempts: 500,
    });

    expect(decision.stop).toBe(true);
    expect(decision.reason).toBe("maxAttempts");
    expect(decision.maxScrollAttemptsReached).toBe(true);
  });

  it("keeps scrolling while the page grows or the position changes", () => {
    const growing = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({ height: 2000, heightChanged: true }),
      prevHeight: 1000,
      settleCount: 5,
      scrollAttempts: 5,
    });
    expect(growing.stop).toBe(false);
    expect(growing.nextSettleCount).toBe(0);

    const moving = decideScrollStop({
      prev: { top: 200, height: 1000, viewportHeight: 600 },
      response: settledResponse({ top: 400 }),
      prevHeight: 1000,
      settleCount: 5,
      scrollAttempts: 5,
    });
    expect(moving.stop).toBe(false);
    expect(moving.reason).toBeNull();
  });

  it("resets the settle counter when at bottom but the page grew", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({ height: 1500, heightChanged: true }),
      prevHeight: 1000,
      settleCount: 3,
      scrollAttempts: 5,
    });

    expect(decision.nextSettleCount).toBe(0);
    expect(decision.stop).toBe(false);
  });

  it("matches the LEGACY decision when the window is disabled (minDuration 0, minSettles 1)", () => {
    // Legacy: first no-growth settle at bottom → stop immediately.
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({ hydrationElapsedMs: 0 }),
      prevHeight: 1000,
      settleCount: 0,
      scrollAttempts: 5,
      minDurationMs: 0,
      minSettles: 1,
    });

    expect(decision.stop).toBe(true);
    expect(decision.reason).toBe("settled");
  });

  it("reports the new height baseline for the caller's prevHeightRef", () => {
    const decision = decideScrollStop({
      prev: { top: 400, height: 1000, viewportHeight: 600 },
      response: settledResponse({ height: 4321 }),
      prevHeight: 1000,
      settleCount: 0,
      scrollAttempts: 5,
    });

    expect(decision.nextPrevHeight).toBe(4321);
  });
});
