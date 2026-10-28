/**
 * @vitest-environment jsdom
 *
 * (Fix 3 — design D3) Dead-worker watchdog.
 *
 * Covers tasks 3.1–3.4:
 *   - shouldArmWatchdog: arms ONLY while a download is tracked AND the
 *     server-mode phase is uploading/assembling — never during
 *     scraping/ready/failed/timeout/idle, never without a tracked download.
 *   - shouldResetWatchdog / shouldWatchdogFire: which routing decisions
 *     restart the window; a terminal state wins over a concurrently
 *     expiring timer.
 *   - useDownloadWatchdog: the panel transitions to the interrupted state
 *     (onTimeout) after 45 s of silence during uploading/assembling; ANY
 *     tracked-download message resets the timer; disarming (terminal state,
 *     new download, idle) cancels the pending expiry.
 *
 * Harness: createRoot + act with fake timers (per
 * use-scraping-downloader-single-fire.test.tsx — no @testing-library/react
 * in this repo).
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  WATCHDOG_TIMEOUT_MS,
  shouldArmWatchdog,
  shouldResetWatchdog,
  shouldWatchdogFire,
} from "../../src/sidepanel/utils/downloadWatchdog";
import { useDownloadWatchdog } from "../../src/sidepanel/hooks/useDownloadWatchdog";
import type { ServerModePhase } from "../../src/sidepanel/utils/downloadWatchdog";

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Harness — drives the hook with controlled props (single-fire test pattern)
// ---------------------------------------------------------------------------

interface WatchdogControls {
  setArmed: (value: boolean) => void;
  reset: () => void;
}

function TestHost({
  controls,
  onTimeout,
}: {
  controls: React.RefObject<WatchdogControls | null>;
  onTimeout: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const { reset } = useDownloadWatchdog({ armed, onTimeout });
  controls.current = { setArmed, reset };
  return null;
}

function renderHost(onTimeout: () => void) {
  const controls: React.RefObject<WatchdogControls | null> = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(TestHost, { controls, onTimeout }));
  });
  return {
    controls,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

// ---------------------------------------------------------------------------
// Pure decisions (task 3.3)
// ---------------------------------------------------------------------------

describe("shouldArmWatchdog (task 3.3)", () => {
  it.each(["uploading", "assembling"] as const)(
    "arms during the %s phase when a download is tracked",
    (phase) => {
      expect(shouldArmWatchdog({ phase, downloadTracked: true })).toBe(true);
    },
  );

  it.each([
    "scraping",
    "ready",
    "failed",
    "timeout",
    null,
  ] as ServerModePhase[])(
    "never arms during the %j phase (scraping is panel-driven; the rest are terminal/idle)",
    (phase) => {
      expect(shouldArmWatchdog({ phase, downloadTracked: true })).toBe(false);
    },
  );

  it("never arms without a tracked download — even in a wait phase", () => {
    expect(
      shouldArmWatchdog({ phase: "uploading", downloadTracked: false }),
    ).toBe(false);
    expect(
      shouldArmWatchdog({ phase: "assembling", downloadTracked: false }),
    ).toBe(false);
  });
});

describe("shouldResetWatchdog (task 3.3)", () => {
  it("any routing decision accepted for the tracked download resets the window", () => {
    expect(shouldResetWatchdog("apply")).toBe(true);
    expect(shouldResetWatchdog("terminal-apply")).toBe(true);
  });

  it("cross-download traffic never resets the window", () => {
    expect(shouldResetWatchdog("ignore")).toBe(false);
    expect(shouldResetWatchdog("terminal-ignore")).toBe(false);
  });
});

describe("shouldWatchdogFire (task 3.3 — terminal wins)", () => {
  it("fires on timeout only while armed and unresolved", () => {
    expect(shouldWatchdogFire({ armed: true, terminalResolved: false })).toBe(
      true,
    );
    expect(shouldWatchdogFire({ armed: true, terminalResolved: true })).toBe(
      false,
    );
    expect(shouldWatchdogFire({ armed: false, terminalResolved: false })).toBe(
      false,
    );
  });

  it("the constant is three missed 15 s heartbeats (design D3)", () => {
    expect(WATCHDOG_TIMEOUT_MS).toBe(45_000);
  });
});

// ---------------------------------------------------------------------------
// Hook behavior with fake timers (tasks 3.1 + 3.2 + 3.4)
// ---------------------------------------------------------------------------

describe("useDownloadWatchdog", () => {
  it("transitions to the interrupted state after 45 s of silence while armed", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("does not fire before the full silence window", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1000);
    expect(onTimeout).not.toHaveBeenCalled();

    unmount();
  });

  it("any tracked-download message resets the timer (heartbeat scenario)", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    // Two heartbeats arrive at 15 s cadence — each restarts the window.
    vi.advanceTimersByTime(15_000);
    act(() => controls.current!.reset());
    vi.advanceTimersByTime(15_000);
    act(() => controls.current!.reset());
    // 30 s since the last reset — still inside the 45 s window.
    vi.advanceTimersByTime(30_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // The full window since the LAST message elapses → fires.
    vi.advanceTimersByTime(15_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("a message at the very boundary of the expiry restarts the window (no fire at the old slot)", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    // A message arrives 1 ms before expiry — same tick as the pending timer.
    act(() => controls.current!.reset());
    vi.advanceTimersByTime(1); // the OLD timer's slot comes and goes
    expect(onTimeout).not.toHaveBeenCalled();

    // The new window must run its FULL course: 1 ms already elapsed since
    // the reset, so 1 ms before the new expiry the timer is still pending.
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 2);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("disarming — a terminal state, new download, or idle — cancels the pending expiry", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(20_000);
    // Terminal appliers flip armed off via state (phase ready, poll stopped).
    act(() => controls.current!.setArmed(false));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS * 10);
    expect(onTimeout).not.toHaveBeenCalled();

    unmount();
  });

  it("re-arming after a disarm starts a fresh full window", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(44_000);
    act(() => controls.current!.setArmed(false)); // terminal resolved it
    act(() => controls.current!.setArmed(true)); // new download began
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1000);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("a terminal message at the concurrently expiring boundary wins (applier disarm)", () => {
    // The panel's terminal path disarms the watchdog: the appliers' state
    // transition (phase ready, poll/live session cleared, resolvedTerminal
    // marker) flips `armed` false, and the effect cleanup CANCELS the
    // already-scheduled expiry — so the interrupted card can never clobber
    // the terminal state, no matter how close the timer was to firing.
    // Defense-in-depth for a callback that was already dequeued is the
    // shouldWatchdogFire guard in sidepanel.tsx's onTimeout (covered in the
    // pure-decision describe above).
    const onTimeout = vi.fn();
    const { controls, unmount } = renderHost(onTimeout);

    act(() => controls.current!.setArmed(true));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS - 1);
    // The terminal message resolves the tracked download at the boundary.
    act(() => controls.current!.setArmed(false));
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS);
    expect(onTimeout).not.toHaveBeenCalled();

    unmount();
  });
});

// ---------------------------------------------------------------------------
// Panel-composed wiring — shouldArmWatchdog feeding the hook, exactly as
// sidepanel.tsx computes `armed` (task 3.4 scenarios)
// ---------------------------------------------------------------------------

interface PanelLikeControls {
  reset: () => void;
}

function PanelLikeHost({
  phase,
  tracked,
  controls,
  onTimeout,
}: {
  phase: ServerModePhase;
  tracked: boolean;
  controls: React.RefObject<PanelLikeControls | null>;
  onTimeout: () => void;
}) {
  const armed = shouldArmWatchdog({ phase, downloadTracked: tracked });
  const { reset } = useDownloadWatchdog({ armed, onTimeout });
  controls.current = { reset };
  return null;
}

function renderPanelLike(
  phase: ServerModePhase,
  tracked: boolean,
  onTimeout: () => void,
) {
  const controls: React.RefObject<PanelLikeControls | null> = { current: null };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(PanelLikeHost, { phase, tracked, controls, onTimeout }),
    );
  });
  return {
    controls,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

describe("panel wiring: phase + tracked feed the watchdog", () => {
  it("uploading + tracked: dead worker is detected within 45 s", () => {
    const onTimeout = vi.fn();
    const { controls, unmount } = renderPanelLike("uploading", true, onTimeout);

    // Heartbeats keep it alive for a while…
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(15_000);
      act(() => controls.current!.reset());
    }
    expect(onTimeout).not.toHaveBeenCalled();

    // …then silence: the interrupted transition fires within the window.
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("assembling + tracked: same bounded detection", () => {
    const onTimeout = vi.fn();
    const { unmount } = renderPanelLike("assembling", true, onTimeout);

    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("scraping or idle: the watchdog never fires, the UI is unchanged", () => {
    const onTimeout = vi.fn();
    const scraping = renderPanelLike("scraping", true, onTimeout);
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS * 5);
    expect(onTimeout).not.toHaveBeenCalled();
    scraping.unmount();

    const idle = renderPanelLike("uploading", false, onTimeout);
    vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS * 5);
    expect(onTimeout).not.toHaveBeenCalled();
    idle.unmount();
  });
});
