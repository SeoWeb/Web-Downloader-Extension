/**
 * @vitest-environment jsdom
 *
 * (multipage-download-fixes 5.3a / design D3) The 45 s panel watchdog must
 * PROVE liveness before declaring "service was restarted".
 *
 * DEFECT AT HEAD: onTimeout applies the interrupted state from silence
 * alone — a long silent server merge (zip_assembler merge phase) matches
 * the silence pattern and produces the false interrupted card.
 *
 * NEW CONTRACT: the timeout first probes liveness (CHECK_DOWNLOAD_LIVE —
 * the background's live flag AND the persisted heartbeat's freshness).
 * A probe answering live resets the watchdog instead of declaring. Only a
 * probe that answers dead (or fails outright — fail-safe) declares.
 */

import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  WATCHDOG_TIMEOUT_MS,
  shouldWatchdogDeclareInterrupted,
} from "../../src/sidepanel/utils/downloadWatchdog";
import { useDownloadWatchdog } from "../../src/sidepanel/hooks/useDownloadWatchdog";
import type { WatchdogLivenessProbe } from "../../src/sidepanel/utils/downloadWatchdog";

// React 19 requires this flag for act() outside its own test renderer.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Pure decision (5.3a)
// ---------------------------------------------------------------------------

describe("shouldWatchdogDeclareInterrupted (5.3a)", () => {
  const probe = (overrides: Partial<WatchdogLivenessProbe> = {}) => ({
    live: false,
    heartbeatFresh: false,
    ...overrides,
  });

  it("declares when the probe answers dead (no liveness, no fresh heartbeat)", () => {
    expect(shouldWatchdogDeclareInterrupted(probe())).toBe(true);
  });

  it("does NOT declare when the probe answers live — the worker is alive", () => {
    expect(shouldWatchdogDeclareInterrupted(probe({ live: true }))).toBe(false);
  });

  it("does NOT declare when the persisted heartbeat is fresh (long silent merge)", () => {
    expect(
      shouldWatchdogDeclareInterrupted(probe({ heartbeatFresh: true })),
    ).toBe(false);
  });

  it("declares when the probe itself fails (null) — fail-safe to the old behavior", () => {
    expect(shouldWatchdogDeclareInterrupted(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Panel-composed glue — the watchdog's timeout consults the probe BEFORE
// applying the interrupted state, exactly as sidepanel.tsx wires it.
// ---------------------------------------------------------------------------

interface ProbeHostControls {
  setArmed: (value: boolean) => void;
  reset: () => void;
}

interface ProbeHostEvents {
  declared: number;
  probes: number;
  resetScheduled: boolean;
}

function ProbeHost({
  probeFn,
  controls,
  events,
}: {
  probeFn: () => Promise<WatchdogLivenessProbe | null>;
  controls: React.RefObject<ProbeHostControls | null>;
  events: React.RefObject<ProbeHostEvents>;
}) {
  const [armed, setArmed] = useState(false);
  const { reset } = useDownloadWatchdog({
    armed,
    // Mirrors sidepanel.tsx's onTimeout: guard → probe → declare-or-reset.
    // The hook's OWN reset restarts the silence window when the probe
    // proves liveness (exactly what the panel wires).
    onTimeout: async () => {
      events.current.probes++;
      const probe = await probeFn();
      if (!shouldWatchdogDeclareInterrupted(probe)) {
        reset(); // proven live — restart the silence window
        return;
      }
      events.current.declared++;
    },
  });
  controls.current = { setArmed, reset };
  return null;
}

function renderProbeHost(probeFn: () => Promise<WatchdogLivenessProbe | null>) {
  const controls: React.RefObject<ProbeHostControls | null> = { current: null };
  const events: React.RefObject<ProbeHostEvents> = {
    current: { declared: 0, probes: 0, resetScheduled: false },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(ProbeHost, { probeFn, controls, events }));
  });
  /** Drive ONE full silence window inside act (the async onTimeout — probe
   *  microtasks + the reset's re-render — must flush for the reset to
   *  re-arm the timer). */
  const expire = async () => {
    await act(async () => {
      vi.advanceTimersByTime(WATCHDOG_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
  };
  return {
    controls,
    events,
    expire,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

describe("watchdog glue: probe before declaring (5.3a)", () => {
  it("45 s of silence with a probe answering LIVE resets instead of declaring", async () => {
    const probeFn = vi.fn(async () => ({ live: true, heartbeatFresh: true }));
    const host = renderProbeHost(probeFn);

    act(() => host.controls.current!.setArmed(true));
    await host.expire();

    expect(host.events.current.declared).toBe(0);
    expect(host.events.current.probes).toBe(1);

    host.unmount();
  });

  it("a probe answering DEAD still declares the interrupted state (genuinely dead worker)", async () => {
    const probeFn = vi.fn(async () => ({ live: false, heartbeatFresh: false }));
    const host = renderProbeHost(probeFn);

    act(() => host.controls.current!.setArmed(true));
    await host.expire();

    expect(host.events.current.declared).toBe(1);

    host.unmount();
  });

  it("a failing probe (background unreachable) declares — dead workers must not freeze the card", async () => {
    const probeFn = vi.fn(async () => null);
    const host = renderProbeHost(probeFn);

    act(() => host.controls.current!.setArmed(true));
    await host.expire();

    expect(host.events.current.declared).toBe(1);

    host.unmount();
  });

  it("a proven-live probe resets the window; a later silence with a dead probe declares", async () => {
    // 5.4's assembly heartbeat ticks keep the window reset while the worker
    // lives (probes answer live); when the worker genuinely dies the next
    // expiry probes dead and the card finally appears.
    let alive = true;
    const probeFn = vi.fn(async () =>
      alive
        ? { live: true, heartbeatFresh: true }
        : { live: false, heartbeatFresh: false },
    );
    const host = renderProbeHost(probeFn);

    act(() => host.controls.current!.setArmed(true));

    // First window: worker alive (heartbeat traffic) — expiry probes live,
    // window resets, nothing declared.
    await host.expire();
    expect(host.events.current.declared).toBe(0);
    expect(host.events.current.probes).toBe(1);

    // Second window: the worker died mid-merge (no more heartbeats) — the
    // expiry probe answers dead and the interrupted state is declared.
    alive = false;
    await host.expire();
    expect(host.events.current.declared).toBe(1);
    expect(host.events.current.probes).toBe(2);

    host.unmount();
  });
});
