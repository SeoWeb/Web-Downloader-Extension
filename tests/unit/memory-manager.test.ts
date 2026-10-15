/**
 * Unit tests for MemoryManager accounting and pressure transitions.
 *
 * Covers OpenSpec tasks 1.1–1.3 of "stabilize-extension-downloads-and-ux":
 * - 1.1: accounting tests that reproduce the download stall
 * - 1.2: usage tracks actual allocations, forceCleanup recomputes from live state
 * - 1.3: MemoryPressureLevel compares by numeric rank, callbacks fire once per transition
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryManager } from "../../src/utils/MemoryManager";
import { MemoryPressureLevel } from "../../src/utils/memoryLimits";

/** Small limits so pressure thresholds can be driven deterministically. */
const SMALL_LIMITS = {
  MAX_TOTAL_MEMORY_USAGE: 1000,
  MAX_CONCURRENT_REQUESTS: 4,
  MEMORY_CHECK_INTERVAL: 3_600_000,
  GC_HINT_INTERVAL: 3_600_000,
};

describe("MemoryManager", () => {
  let managers: MemoryManager[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const createManager = (overrides = {}): MemoryManager => {
    const manager = new MemoryManager({ ...SMALL_LIMITS, ...overrides });
    managers.push(manager);
    return manager;
  };

  beforeEach(() => {
    managers = [];
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const manager of managers) {
      await manager.shutdown();
    }
    managers = [];
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Task 1.1/1.2 — accounting that reproduces the stall
  // -------------------------------------------------------------------------

  it("returns usage to baseline after sequential downloads (stall regression)", () => {
    const manager = createManager();

    // Six 300-byte responses: 1800 bytes cumulative through a 1000-byte
    // budget. The old accounting only ever grew (queueResource records were
    // shifted out before releaseResource could find them), permanently
    // tripping critical pressure after ~425MB.
    for (let i = 0; i < 6; i++) {
      manager.queueResource({
        id: `r${i}`,
        url: `https://cdn.test/${i}.png`,
        type: "IMAGE",
        size: 300,
        status: "downloading",
      });
      manager.trackResourceAllocation(`r${i}`, 300);
      expect(manager.getMemoryStats().totalMemoryUsed).toBe(300);
      expect(manager.getMemoryStats().activeDownloads).toBe(1);

      manager.releaseResource(`r${i}`);
      expect(manager.getMemoryStats().totalMemoryUsed).toBe(0);
      expect(manager.getMemoryStats().activeDownloads).toBe(0);
    }

    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.LOW,
    );
    expect(manager.checkMemoryAvailability(300)).toBe(true);
  });

  it("consumes the pending queueResource record when tracking the allocation", () => {
    const manager = createManager();

    manager.queueResource({
      id: "pending",
      url: "https://cdn.test/a.png",
      type: "IMAGE",
      size: 0,
      status: "downloading",
    });
    expect(manager.getMemoryStats().queuedDownloads).toBe(1);

    manager.trackResourceAllocation("pending", 250, {
      url: "https://cdn.test/a.png",
      type: "IMAGE",
    });

    const stats = manager.getMemoryStats();
    expect(stats.totalMemoryUsed).toBe(250);
    expect(stats.queuedDownloads).toBe(0);
    expect(stats.activeDownloads).toBe(1);
  });

  it("re-tracking an active allocation adjusts usage by the delta", () => {
    const manager = createManager();

    manager.trackResourceAllocation("a", 100);
    manager.trackResourceAllocation("a", 350);

    expect(manager.getMemoryStats().totalMemoryUsed).toBe(350);

    manager.releaseResource("a");
    expect(manager.getMemoryStats().totalMemoryUsed).toBe(0);
  });

  it("releasing an unknown record is a no-op that logs a warning", () => {
    const manager = createManager();
    manager.trackResourceAllocation("real", 400);

    manager.releaseResource("ghost");

    expect(manager.getMemoryStats().totalMemoryUsed).toBe(400);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown allocation: ghost"),
    );
  });

  it("double release does not corrupt usage", () => {
    const manager = createManager();
    manager.trackResourceAllocation("a", 500);

    manager.releaseResource("a");
    manager.releaseResource("a");

    expect(manager.getMemoryStats().totalMemoryUsed).toBe(0);
    expect(manager.getMemoryStats().activeDownloads).toBe(0);
  });

  it("markResourceFailed releases the allocation", () => {
    const manager = createManager();
    manager.trackResourceAllocation("a", 500);

    manager.markResourceFailed("a");

    const stats = manager.getMemoryStats();
    expect(stats.totalMemoryUsed).toBe(0);
    expect(stats.failedDownloads).toBe(1);
  });

  it("forceCleanup recomputes usage from live allocations (stale high-water regression)", async () => {
    const manager = createManager();
    manager.trackResourceAllocation("a", 100);
    manager.trackResourceAllocation("b", 200);
    expect(manager.getMemoryStats().totalMemoryUsed).toBe(300);

    // Simulate the stale cumulative counter the old accounting left behind.
    (manager as unknown as { currentUsage: number }).currentUsage =
      425 * 1024 * 1024;

    await manager.forceCleanup();

    // Recomputed from the two live allocations, not left at the stale mark.
    expect(manager.getMemoryStats().totalMemoryUsed).toBe(300);
  });

  it("forceCleanup drops usage when nothing is in flight", async () => {
    const manager = createManager();
    manager.trackResourceAllocation("a", 700);
    manager.releaseResource("a");
    (manager as unknown as { currentUsage: number }).currentUsage = 999_999;

    await manager.forceCleanup();

    expect(manager.getMemoryStats().totalMemoryUsed).toBe(0);
  });

  it("back-to-back downloads are not blocked by stale usage", async () => {
    const manager = createManager();

    // First "download" runs to completion
    manager.trackResourceAllocation("first", 800);
    manager.releaseResource("first");

    // Second download must see a fresh gate
    expect(manager.checkMemoryAvailability(800)).toBe(true);
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.LOW,
    );

    await manager.forceCleanup();
    expect(manager.checkMemoryAvailability(800)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Task 1.3 — numeric rank ordering of MemoryPressureLevel
  // -------------------------------------------------------------------------

  it("compares levels by numeric rank (low < medium < high < critical)", () => {
    expect(MemoryPressureLevel.LOW).toBe(0);
    expect(MemoryPressureLevel.MEDIUM).toBe(1);
    expect(MemoryPressureLevel.HIGH).toBe(2);
    expect(MemoryPressureLevel.CRITICAL).toBe(3);

    // The old lexicographic comparison got these exactly backwards.
    expect(MemoryPressureLevel.LOW < MemoryPressureLevel.HIGH).toBe(true);
    expect(MemoryPressureLevel.CRITICAL >= MemoryPressureLevel.HIGH).toBe(true);
    expect(MemoryPressureLevel.MEDIUM >= MemoryPressureLevel.HIGH).toBe(false);
  });

  it("maps usage ratios to the ranked levels", () => {
    const manager = createManager();

    manager.trackResourceAllocation("low", 100); // 10%
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.LOW,
    );

    manager.trackResourceAllocation("medium", 500); // 60%
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.MEDIUM,
    );

    manager.trackResourceAllocation("high", 200); // 80%
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.HIGH,
    );

    manager.trackResourceAllocation("critical", 100); // 90%
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.CRITICAL,
    );
  });

  it("never fires pressure handlers while pressure is low", () => {
    const manager = createManager();
    const pressureCb = vi.fn();
    manager.registerMemoryPressureCallback(pressureCb);

    manager.trackResourceAllocation("a", 100); // 10% low
    manager.trackResourceAllocation("b", 300); // 40% low
    manager.trackResourceAllocation("c", 200); // 60% medium
    manager.releaseResource("c"); // 40% low

    expect(pressureCb).not.toHaveBeenCalled();
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.LOW,
    );
  });

  it("always triggers cleanup and the callback when pressure reaches critical", async () => {
    const manager = createManager();
    const pressureCb = vi.fn();
    const cleanupCb = vi.fn(async () => {});
    manager.registerMemoryPressureCallback(pressureCb);
    manager.registerCleanupCallback(cleanupCb);

    manager.trackResourceAllocation("a", 900); // 90% → critical

    expect(pressureCb).toHaveBeenCalledTimes(1);
    expect(pressureCb).toHaveBeenCalledWith(MemoryPressureLevel.CRITICAL);

    // Critical pressure runs forceCleanup (registered cleanup callbacks run).
    await vi.waitFor(() => expect(cleanupCb).toHaveBeenCalledTimes(1));
  });

  it("fires the pressure callback exactly once per transition", () => {
    const manager = createManager();
    const levels: MemoryPressureLevel[] = [];
    manager.registerMemoryPressureCallback((level) => levels.push(level));

    manager.trackResourceAllocation("a", 100); // 10% low — silent
    manager.trackResourceAllocation("b", 700); // 80% high → notify HIGH
    manager.trackResourceAllocation("c", 100); // 90% critical → notify CRITICAL
    manager.trackResourceAllocation("d", 50); // 95% still critical — silent

    expect(levels).toEqual([
      MemoryPressureLevel.HIGH,
      MemoryPressureLevel.CRITICAL,
    ]);

    manager.releaseResource("d"); // 90% still critical — silent
    manager.releaseResource("c"); // 80% high → notify HIGH (recovery)
    manager.releaseResource("b"); // 10% low, leaves high zone → notify LOW
    manager.releaseResource("a"); // 0% low — silent

    expect(levels).toEqual([
      MemoryPressureLevel.HIGH,
      MemoryPressureLevel.CRITICAL,
      MemoryPressureLevel.HIGH,
      MemoryPressureLevel.LOW,
    ]);
    expect(manager.getMemoryStats().memoryPressureLevel).toBe(
      MemoryPressureLevel.LOW,
    );
  });

  it("recovers the queue resume path after critical pressure clears", async () => {
    const manager = createManager();
    const levels: MemoryPressureLevel[] = [];
    manager.registerMemoryPressureCallback((level) => levels.push(level));

    // Simulate: pause at critical …
    manager.trackResourceAllocation("a", 900);
    expect(levels).toEqual([MemoryPressureLevel.CRITICAL]);

    // … allocations released → resume on LOW.
    manager.releaseResource("a");
    expect(levels).toEqual([MemoryPressureLevel.CRITICAL, MemoryPressureLevel.LOW]);
    expect(manager.getMemoryStats().totalMemoryUsed).toBe(0);
  });
});
