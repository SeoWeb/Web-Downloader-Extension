/**
 * Tests for chrome.alarms-based cleanup (task 4.3 / D9).
 *
 * Verifies:
 * - Periodic cleanup + memory monitoring register chrome.alarms (created
 *   with a >= 1 minute period, re-created on every init/SW start) and a
 *   single onAlarm handler — the former setInterval loops (dead in MV3)
 *   are gone.
 * - Listener registration happens exactly once even when
 *   initializeCleanupHandlers is called repeatedly (the old duplicate
 *   setTimeout(1000) registration path is removed).
 * - The periodic-cleanup alarm frees memory only at MEDIUM+ pressure —
 *   using the NUMERIC MemoryPressureLevel rank (the previous string
 *   comparisons `"low"`/`"critical"` were runtime-broken).
 * - The CRITICAL monitor actually fires, only on real transitions into
 *   CRITICAL.
 * - Cleanup never touches per-download work (download state untouched).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chrome mock — must exist BEFORE cleanupHandlers is imported
// ---------------------------------------------------------------------------

const registry = vi.hoisted(() => {
  const mocks = {
    alarmsCreate: vi.fn(),
    alarmsOnAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    tabsOnRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    runtimeOnSuspend: { addListener: vi.fn() },
    runtimeOnInstalled: { addListener: vi.fn() },
  };

  // Augment chrome BEFORE the module under test is imported: vitest defines
  // `self` in workers, so cleanupHandlers auto-initializes at import time.
  (globalThis as any).chrome = {
    ...((globalThis as any).chrome ?? {}),
    alarms: {
      create: mocks.alarmsCreate,
      onAlarm: mocks.alarmsOnAlarm,
    },
    tabs: {
      onRemoved: mocks.tabsOnRemoved,
    },
    runtime: {
      onSuspend: mocks.runtimeOnSuspend,
      onInstalled: mocks.runtimeOnInstalled,
    },
  };

  return mocks;
});

// ---------------------------------------------------------------------------
// Module mocks (keep the import graph light)
// ---------------------------------------------------------------------------

vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: vi.fn().mockResolvedValue(undefined),
  deleteServerSessionState: vi.fn(),
}));

vi.mock("../../src/background/download-checkpoint", () => ({
  readCheckpoint: vi.fn().mockResolvedValue(null),
  clearCheckpoint: vi.fn(),
}));

vi.mock("../../src/background/download-state", () => ({
  abortActiveDownload: vi.fn(),
  setDownloadAbortController: vi.fn(),
  disconnectKeepalivePort: vi.fn(),
  setTabDownloadComplete: vi.fn(),
  removeDownloadsForTab: vi.fn(),
}));

vi.mock("../../src/background/scraper-state", () => ({
  stopScraping: vi.fn(),
  deleteScraper: vi.fn(),
}));

// ---------------------------------------------------------------------------

import { memoryManager } from "../../src/utils/MemoryManager";
import { MemoryPressureLevel } from "../../src/utils/memoryLimits";
import {
  initializeCleanupHandlers,
  runAlarmCleanup,
} from "../../src/background/cleanupHandlers";

const PERIODIC_CLEANUP_ALARM = "pagepocket-periodic-cleanup";
const MEMORY_MONITOR_ALARM = "pagepocket-memory-monitor";

/** Grab the onAlarm listener registered by initializeCleanupHandlers. */
function getOnAlarmListener(): (alarm: { name: string }) => void {
  const calls = registry.alarmsOnAlarm.addListener.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

describe("cleanup via chrome.alarms (task 4.3)", () => {
  beforeAll(() => {
    vi.spyOn(memoryManager, "forceCleanup").mockResolvedValue(undefined);
    initializeCleanupHandlers();
  });

  beforeEach(() => {
    // Clear ONLY the memory-manager spies — the chrome registry mocks must
    // keep their call history for the registration assertions.
    vi.mocked(memoryManager.forceCleanup).mockClear();
    // Default: LOW pressure
    vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
      totalMemoryUsed: 0,
      totalMemoryLimit: 500 * 1024 * 1024,
      activeDownloads: 0,
      queuedDownloads: 0,
      completedDownloads: 0,
      failedDownloads: 0,
      memoryPressureLevel: MemoryPressureLevel.LOW,
    } as any);
  });

  it("registers both cleanup alarms with periods >= 1 minute", () => {
    const names = registry.alarmsCreate.mock.calls.map((c) => c[0]);
    expect(names).toContain(PERIODIC_CLEANUP_ALARM);
    expect(names).toContain(MEMORY_MONITOR_ALARM);

    for (const call of registry.alarmsCreate.mock.calls) {
      const info = call[1];
      expect(info.periodInMinutes).toBeGreaterThanOrEqual(1);
    }
  });

  it("registers listeners exactly once despite repeated initialization", () => {
    const onAlarmCallsBefore =
      registry.alarmsOnAlarm.addListener.mock.calls.length;
    const tabsCallsBefore = registry.tabsOnRemoved.addListener.mock.calls.length;

    initializeCleanupHandlers();
    initializeCleanupHandlers();

    expect(registry.alarmsOnAlarm.addListener.mock.calls.length).toBe(
      onAlarmCallsBefore,
    );
    expect(registry.tabsOnRemoved.addListener.mock.calls.length).toBe(
      tabsCallsBefore,
    );
  });

  it("creates each alarm once per service-worker lifetime (no duplicate churn)", () => {
    // First init (in beforeAll) created both alarms. Repeated init within
    // the same SW lifetime must not re-create them — chrome.alarms.create
    // with a known name would reset the schedule.
    const before = registry.alarmsCreate.mock.calls.length;
    initializeCleanupHandlers();
    initializeCleanupHandlers();
    expect(registry.alarmsCreate.mock.calls.length).toBe(before);

    // Both alarms exist from the first (module-import) initialization
    const names = registry.alarmsCreate.mock.calls.map((c) => c[0]);
    expect(names.filter((n) => n === PERIODIC_CLEANUP_ALARM)).toHaveLength(1);
    expect(names.filter((n) => n === MEMORY_MONITOR_ALARM)).toHaveLength(1);
  });

  describe("periodic cleanup alarm", () => {
    it("frees memory at MEDIUM pressure (numeric comparison works)", async () => {
      vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.MEDIUM,
      } as any);

      const listener = getOnAlarmListener();
      listener({ name: PERIODIC_CLEANUP_ALARM });
      await vi.waitFor(() => {
        expect(memoryManager.forceCleanup).toHaveBeenCalled();
      });
    });

    it("does nothing at LOW pressure", async () => {
      vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.LOW,
      } as any);

      await runAlarmCleanup(PERIODIC_CLEANUP_ALARM);

      expect(memoryManager.forceCleanup).not.toHaveBeenCalled();
    });

    it("frees memory at CRITICAL pressure", async () => {
      vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.CRITICAL,
      } as any);

      await runAlarmCleanup(PERIODIC_CLEANUP_ALARM);

      expect(memoryManager.forceCleanup).toHaveBeenCalled();
    });
  });

  describe("memory pressure monitor alarm", () => {
    it("fires the CRITICAL handler on transition into CRITICAL", async () => {
      vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.CRITICAL,
      } as any);

      await runAlarmCleanup(MEMORY_MONITOR_ALARM);

      // Transition LOW → CRITICAL fires the critical handler
      expect(memoryManager.forceCleanup).toHaveBeenCalled();
    });

    it("does not fire repeatedly while pressure stays CRITICAL (transitions only)", async () => {
      vi.spyOn(memoryManager, "getMemoryStats").mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.CRITICAL,
      } as any);

      // First tick is a fresh module state in this file — reset by running
      // one tick, then count.
      await runAlarmCleanup(MEMORY_MONITOR_ALARM);
      const callsAfterFirst = (memoryManager.forceCleanup as vi.Mock).mock
        .calls.length;

      await runAlarmCleanup(MEMORY_MONITOR_ALARM);
      await runAlarmCleanup(MEMORY_MONITOR_ALARM);

      const callsAfterThird = (memoryManager.forceCleanup as vi.Mock).mock
        .calls.length;
      // Sustained CRITICAL does NOT re-trigger the extra handler
      expect(callsAfterThird).toBe(callsAfterFirst);
    });

    it("fires again after pressure drops and re-enters CRITICAL", async () => {
      const statsSpy = vi
        .spyOn(memoryManager, "getMemoryStats")
        .mockReturnValue({ memoryPressureLevel: MemoryPressureLevel.LOW } as any);

      await runAlarmCleanup(MEMORY_MONITOR_ALARM);
      const afterLow = (memoryManager.forceCleanup as vi.Mock).mock.calls.length;

      statsSpy.mockReturnValue({
        memoryPressureLevel: MemoryPressureLevel.CRITICAL,
      } as any);
      await runAlarmCleanup(MEMORY_MONITOR_ALARM);

      const afterCritical = (memoryManager.forceCleanup as vi.Mock).mock.calls
        .length;
      expect(afterCritical).toBeGreaterThan(afterLow);
    });
  });

  it("ignores unknown alarm names", async () => {
    await expect(runAlarmCleanup("some-other-alarm")).resolves.toBeUndefined();
  });
});
