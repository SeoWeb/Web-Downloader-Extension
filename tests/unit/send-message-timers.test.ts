/**
 * Tests for per-call send timers in sendMessage (D4 / task 5.1).
 *
 * The old implementation used ONE module-level timer for every non-force
 * call: a second non-force send within the 1s window cleared the first
 * caller's pending send, whose promise then NEVER settled. All
 * download-listener terminal pushes (COMPLETE/CANCELLED/FAILED) are
 * non-force, so rapid terminal messages were silently dropped.
 *
 * Verifies:
 * - Two rapid non-force sends with different payloads are BOTH delivered
 *   (the bite test — pre-fix the second cancelled the first).
 * - Every non-force promise settles once the debounce window elapses.
 * - Forced sends still bypass debouncing unchanged: delivered immediately,
 *   never cancelled by pending debounced sends (and vice versa).
 */

import { sendMessage } from "../../src/common/chrome";

// The common/chrome module imports sendMessageToPanel from
// ../background/message, which pulls in the whole background graph.
// Mock it away — these tests only exercise sendMessage.
vi.mock("../../src/background/message", () => ({
  sendMessageToPanel: vi.fn().mockResolvedValue(undefined),
}));

const mockRuntimeSendMessage = vi.fn(
  async (payload: { target: string; message: { data: unknown } }) => ({
    ok: true,
    echoed: payload.message.data,
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  Object.defineProperty(globalThis, "chrome", {
    value: { runtime: { sendMessage: mockRuntimeSendMessage } },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const msg = (data: unknown) => ({ action: "PANEL_MESSAGE", data }) as any;

describe("sendMessage per-call debounce (task 5.1)", () => {
  it("delivers BOTH of two rapid non-force sends with different payloads", async () => {
    const p1 = sendMessage("side-panel", msg({ n: 1 }), false);
    const p2 = sendMessage("side-panel", msg({ n: 2 }), false);

    // Nothing sent yet — the debounce window is still running.
    expect(mockRuntimeSendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    // Pre-fix: only {n:2} went out — the second call cleared the first
    // caller's pending timer.
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(2);
    expect(
      mockRuntimeSendMessage.mock.calls.map((c) => c[0].message.data),
    ).toEqual([{ n: 1 }, { n: 2 }]);

    // Both promises settle (pre-fix p1's promise never settled).
    await expect(p1).resolves.toMatchObject({ ok: true, echoed: { n: 1 } });
    await expect(p2).resolves.toMatchObject({ ok: true, echoed: { n: 2 } });
  });

  it("keeps the 1s debounce window for non-force sends", async () => {
    const p = sendMessage("side-panel", msg({ n: 1 }), false);

    await vi.advanceTimersByTimeAsync(999);
    expect(mockRuntimeSendMessage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it("delivers rapid forced sends immediately, bypassing the debounce", async () => {
    const sends = [
      sendMessage("side-panel", msg({ n: 1 }), true),
      sendMessage("side-panel", msg({ n: 2 })), // force defaults to true
      sendMessage("side-panel", msg({ n: 3 }), true),
    ];

    await Promise.all(sends);

    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(3);
    expect(
      mockRuntimeSendMessage.mock.calls.map((c) => c[0].message.data),
    ).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("a forced send is not swallowed by a pending debounced send", async () => {
    const debounced = sendMessage(
      "side-panel",
      msg({ kind: "debounced" }),
      false,
    );
    const forced = sendMessage("side-panel", msg({ kind: "forced" }), true);

    // Forced goes out immediately, without waiting for the debounce window.
    await forced;
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRuntimeSendMessage.mock.calls[0][0].message.data).toEqual({
      kind: "forced",
    });

    // The pending debounced send is NOT cancelled by the forced one.
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(2);
    await expect(debounced).resolves.toMatchObject({ ok: true });
  });

  it("a debounced send still fires after a forced send", async () => {
    const forced = sendMessage("side-panel", msg({ kind: "forced" }), true);
    const debounced = sendMessage(
      "side-panel",
      msg({ kind: "debounced" }),
      false,
    );

    await forced;
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(mockRuntimeSendMessage).toHaveBeenCalledTimes(2);
    expect(mockRuntimeSendMessage.mock.calls[1][0].message.data).toEqual({
      kind: "debounced",
    });
    await expect(debounced).resolves.toMatchObject({ ok: true });
  });
});
