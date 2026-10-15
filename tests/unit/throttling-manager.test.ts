/**
 * Unit tests for ThrottlingManager congestion derivation and dedup cache.
 *
 * Covers OpenSpec tasks 2.7 and 2.1 (cache cap) of
 * "stabilize-extension-downloads-and-ux":
 * - no third-party congestion probe (the old google.com favicon ping)
 * - congestion derived from the download's own request outcomes
 * - dedup cache skips bodies above the 5MB cap
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ThrottlingManager } from "../../src/utils/ThrottlingManager";
import {
  MAX_DEDUP_CACHE_BODY_SIZE,
  NetworkCondition,
} from "../../src/types/queue";

describe("ThrottlingManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("never sends third-party congestion probes", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const manager = new ThrottlingManager({ enableNetworkMonitoring: true });
    vi.advanceTimersByTime(65_000); // old probe fired every 10s

    expect(fetchMock).not.toHaveBeenCalled();
    manager.shutdown();
  });

  it("derives congestion from its own request outcomes", () => {
    vi.useFakeTimers();
    const manager = new ThrottlingManager({ enableNetworkMonitoring: true });
    const events: NetworkCondition[] = [];
    manager.setEventListeners({
      onNetworkChange: (condition) => events.push(condition),
    });

    // Slow + failing requests → congested
    for (let i = 0; i < 6; i++) {
      manager.recordRequest(20_000, false);
      vi.advanceTimersByTime(100);
    }

    const condition = manager.getNetworkCondition();
    expect(condition.congested).toBe(true);
    expect(condition.quality).toBe("slow");
    expect(condition.latency).toBe(20_000);

    // The congested transition fired the change event exactly once
    expect(events.filter((event) => event.congested)).toHaveLength(1);

    // More failing requests do not re-fire the change event
    manager.recordRequest(30_000, false);
    expect(events).toHaveLength(1);

    manager.shutdown();
  });

  it("clears congestion once recent outcomes are fast and successful", () => {
    vi.useFakeTimers();
    const manager = new ThrottlingManager({ enableNetworkMonitoring: true });
    const events: NetworkCondition[] = [];
    manager.setEventListeners({
      onNetworkChange: (condition) => events.push(condition),
    });

    for (let i = 0; i < 6; i++) {
      manager.recordRequest(20_000, false);
      vi.advanceTimersByTime(100);
    }
    expect(manager.getNetworkCondition().congested).toBe(true);

    // Slide the 60s outcome window past the failures, then succeed fast.
    vi.advanceTimersByTime(61_000);
    for (let i = 0; i < 6; i++) {
      manager.recordRequest(50, true);
      vi.advanceTimersByTime(100);
    }

    const condition = manager.getNetworkCondition();
    expect(condition.congested).toBe(false);
    expect(condition.quality).toBe("fast");
    expect(events.some((event) => !event.congested)).toBe(true);

    manager.shutdown();
  });

  it("does not derive congestion from too little data", () => {
    vi.useFakeTimers();
    const manager = new ThrottlingManager({ enableNetworkMonitoring: true });

    for (let i = 0; i < 4; i++) {
      manager.recordRequest(30_000, false);
    }

    // Fewer than 5 recent outcomes — no verdict yet.
    expect(manager.getNetworkCondition().congested).toBe(false);
    manager.shutdown();
  });

  it("does not cache dedup results for bodies above the 5MB cap", () => {
    vi.useFakeTimers();
    const manager = new ThrottlingManager({ enableDeduplication: true });

    const largeResult = {
      requestId: "big",
      url: "https://cdn.test/big.bin",
      size: MAX_DEDUP_CACHE_BODY_SIZE + 1,
      snapshot: { bytes: null },
    };
    manager.cacheRequestResult(largeResult.url, largeResult);

    expect(manager.isDuplicateRequest(largeResult.url)).toBe(false);
    expect(manager.getCachedResult(largeResult.url)).toBeNull();

    const smallResult = {
      requestId: "small",
      url: "https://cdn.test/small.bin",
      size: 1024,
      snapshot: { bytes: new Uint8Array(1024) },
    };
    manager.cacheRequestResult(smallResult.url, smallResult);

    expect(manager.isDuplicateRequest(smallResult.url)).toBe(true);
    expect(manager.getCachedResult(smallResult.url)).toBe(smallResult);

    manager.shutdown();
  });
});
