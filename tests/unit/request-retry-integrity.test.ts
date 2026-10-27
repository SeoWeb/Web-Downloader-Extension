/**
 * Unit tests for RequestQueue retry integrity.
 *
 * Covers OpenSpec section 6 of "request-queue-retry-integrity" (design D1–D5):
 * - D1: a retryable failure leaves the handler pending; the detached
 *   same-object retry settles it later — success via a single onComplete,
 *   exhaustion via exactly one onError after the FINAL attempt
 * - D1: terminal failures (404) settle onError exactly once, immediately
 * - D2: clear() settles every in-flight AND queued handler exactly once with
 *   a "cancelled" error, releases domain-limiter slots, and late abort
 *   rejections are no-ops
 * - D3: processQueue reschedules after an internal throw; a paused queue
 *   arms no timers and resume() restarts queued work
 * - D4: a pool-blocked domain schedules a real (~100ms) wait instead of the
 *   10ms minimum tick
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestQueue } from "../../src/utils/RequestQueue";
import { DomainLimiterFactory } from "../../src/utils/DomainLimiter";
import { ThrottlingManager } from "../../src/utils/ThrottlingManager";
import {
  RequestPriority,
  RequestQueueError,
  RequestResult,
  ResourceType,
} from "../../src/types/queue";

const ROBOTS_OK = "User-agent: *\nAllow: /\n";

/** Minimum tick the queue polls at when work is merely possible. */
const QUEUE_TICK_MS = 10;

type FetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

type TrackedOutcome =
  | { kind: "success"; result: RequestResult }
  | { kind: "failure"; error: Error };

interface TrackedAsset {
  id: Promise<string>;
  /** Resolves with the FIRST settlement only (like the handler promises). */
  outcome: Promise<TrackedOutcome>;
  onComplete: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  /** EVERY settlement callback invocation — length must stay at 1. */
  settlements: TrackedOutcome[];
}

describe("RequestQueue retry integrity", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const stubFetch = (handler: FetchHandler) => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) =>
        handler(String(url), (init ?? {}) as RequestInit),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const createQueue = (
    overrides: {
      requestTimeout?: number;
      maxRetries?: number;
      maxConcurrentRequests?: number;
    } = {},
  ): RequestQueue =>
    new RequestQueue({
      throttling: {
        requestTimeout: overrides.requestTimeout ?? 5000,
        maxRetries: overrides.maxRetries ?? 0,
        maxConcurrentRequests: overrides.maxConcurrentRequests ?? 4,
      },
    });

  /**
   * Enqueue one asset with settlement tracking: the spies record every
   * callback invocation while `outcome` resolves on the first one — so a
   * double settlement shows up as `settlements.length > 1`.
   */
  const enqueueTrackedAsset = (
    queue: RequestQueue,
    url: string,
    resourceType: ResourceType = ResourceType.IMAGE,
  ): TrackedAsset => {
    const settlements: TrackedOutcome[] = [];
    let resolveOutcome!: (outcome: TrackedOutcome) => void;
    const outcome = new Promise<TrackedOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const onComplete = vi.fn((result: RequestResult) => {
      settlements.push({ kind: "success", result });
      resolveOutcome({ kind: "success", result });
    });
    const onError = vi.fn((error: Error) => {
      settlements.push({ kind: "failure", error });
      resolveOutcome({ kind: "failure", error });
    });

    const id = queue.enqueue({
      url,
      resourceType,
      priority: RequestPriority.NORMAL,
      domain: "",
      dependencies: [],
      retryCount: 0,
      estimatedSize: 0,
      onComplete,
      onError,
    });

    return { id, outcome, onComplete, onError, settlements };
  };

  const outcomeError = (outcome: TrackedOutcome): Error => {
    expect(outcome.kind).toBe("failure");
    if (outcome.kind !== "failure") {
      throw new Error("Expected a failure outcome");
    }
    return outcome.error;
  };

  const outcomeResult = (outcome: TrackedOutcome): RequestResult => {
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") {
      throw new Error("Expected a success outcome");
    }
    return outcome.result;
  };

  const assetCallsOf = (
    fetchMock: ReturnType<typeof vi.fn>,
  ): Array<[string, RequestInit]> =>
    fetchMock.mock.calls.filter(
      (call: unknown[]) => !String(call[0]).includes("/robots.txt"),
    );

  beforeEach(() => {
    vi.useFakeTimers();
    DomainLimiterFactory.resetAll();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    DomainLimiterFactory.resetAll();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Task 6.1 — transient 5xx retry settles the handler as ONE success
  // -------------------------------------------------------------------------

  it("settles a transient-5xx retry as a single success and never fires onError", async () => {
    let attempts = 0;
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      attempts++;
      if (attempts === 1) {
        return new Response("boom", { status: 500 });
      }
      return new Response("RECOVERED", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    });

    const queue = createQueue({ maxRetries: 2 });
    const asset = enqueueTrackedAsset(queue, "https://flaky.test/a.png");
    await asset.id;

    // First attempt fails and schedules the detached retry (~1s backoff).
    // The handler must stay PENDING — failure is not terminal yet.
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toBe(1);
    expect(asset.settlements).toHaveLength(0);

    // Retry fires, re-enqueues the SAME request, and succeeds.
    await vi.advanceTimersByTimeAsync(1500);

    const result = outcomeResult(await asset.outcome);
    await expect(result.response.text()).resolves.toBe("RECOVERED");

    // Exactly one success settlement; the failure callback never fired.
    expect(asset.onComplete).toHaveBeenCalledTimes(1);
    expect(asset.onError).not.toHaveBeenCalled();
    expect(asset.settlements).toHaveLength(1);

    // Exactly one fetch sequence: initial attempt + scheduled retry.
    expect(assetCallsOf(fetchMock)).toHaveLength(2);

    // No duplicate fetch or late callback after settlement.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(assetCallsOf(fetchMock)).toHaveLength(2);
    expect(asset.onComplete).toHaveBeenCalledTimes(1);
    expect(asset.onError).not.toHaveBeenCalled();
    expect(asset.settlements).toHaveLength(1);
    expect(queue.getStats().completed).toBe(1);
    // Note: scheduler-level `failed` stats are per-attempt bookkeeping (the
    // id stays in the failedRequests set even after retry success) — the
    // handler-level outcome above is what D1 pins.
  });

  // -------------------------------------------------------------------------
  // Task 6.2 — retry exhaustion: N+1 attempts, onError once, after the last
  // -------------------------------------------------------------------------

  it("fires onError exactly once after the final attempt when retries are exhausted", async () => {
    let attempts = 0;
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      attempts++;
      return new Response("boom", { status: 500 });
    });

    const maxRetries = 2;
    const queue = createQueue({ maxRetries });
    const asset = enqueueTrackedAsset(queue, "https://broken.test/a.png");
    await asset.id;

    // Attempt 1 fails (retryable) — handler stays pending.
    await vi.advanceTimersByTimeAsync(50);
    expect(attempts).toBe(1);
    expect(asset.settlements).toHaveLength(0);

    // Attempt 2 (retry 1) fails — still pending. (The attempt's microtask
    // chain — fetch → body read → failRequest — completes at the end of the
    // previous advance window, so the 1s backoff timer fires ~1050ms in;
    // the +150ms margin covers it plus the next processing cycle.)
    await vi.advanceTimersByTimeAsync(1150);
    expect(attempts).toBe(2);
    expect(asset.settlements).toHaveLength(0);

    // Attempt 3 (retry 2) fails — retries exhausted, NOW the handler settles.
    await vi.advanceTimersByTimeAsync(2150);
    const error = outcomeError(await asset.outcome);
    expect(error).toBeInstanceOf(RequestQueueError);
    expect((error as RequestQueueError).category).toBe("http");
    expect((error as RequestQueueError).status).toBe(500);

    // Exactly N+1 fetch attempts and exactly ONE error settlement, fired
    // after the final attempt (attempts was still 2 with zero settlements).
    expect(attempts).toBe(maxRetries + 1);
    expect(assetCallsOf(fetchMock)).toHaveLength(maxRetries + 1);
    expect(asset.onError).toHaveBeenCalledTimes(1);
    expect(asset.onComplete).not.toHaveBeenCalled();
    expect(asset.settlements).toHaveLength(1);
    expect(queue.getStats().failed).toBe(1);

    // Terminal: no phantom retry re-fetches after the settlement.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(assetCallsOf(fetchMock)).toHaveLength(maxRetries + 1);
  });

  // -------------------------------------------------------------------------
  // Task 6.3 — non-retryable 404: immediate single onError, no retry
  // -------------------------------------------------------------------------

  it("fails a 404 immediately with a single onError and no retry fetch", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const queue = createQueue({ maxRetries: 3 });
    const asset = enqueueTrackedAsset(queue, "https://missing.test/a.png");
    await asset.id;

    await vi.advanceTimersByTimeAsync(50);
    const error = outcomeError(await asset.outcome);
    expect(error).toBeInstanceOf(RequestQueueError);
    expect((error as RequestQueueError).category).toBe("http");
    expect((error as RequestQueueError).status).toBe(404);

    // Immediate single settlement on the first attempt.
    expect(asset.onError).toHaveBeenCalledTimes(1);
    expect(asset.onComplete).not.toHaveBeenCalled();
    expect(asset.settlements).toHaveLength(1);

    // One attempt = credentialed fetch + cookieless 4xx retry only.
    expect(assetCallsOf(fetchMock)).toHaveLength(2);

    // No detached retry: sweeping every backoff window adds no fetches.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(assetCallsOf(fetchMock)).toHaveLength(2);
    expect(asset.onError).toHaveBeenCalledTimes(1);
    expect(asset.settlements).toHaveLength(1);
    expect(queue.getStats().failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Task 6.4 — clear(): settle-before-drop, no double settlement, no leaks
  // -------------------------------------------------------------------------

  it("clear() settles in-flight and queued handlers exactly once and leaks no limiter slot", async () => {
    let rejectInflight!: (error: unknown) => void;
    const fetchMock = stubFetch((url, init) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      // The fetch ignores the abort signal; its rejection is delivered
      // manually AFTER clear() returns — the late-rejection race this test
      // pins against the settle-before-drop teardown.
      void init;
      return new Promise<Response>((_resolve, reject) => {
        rejectInflight = reject;
      });
    });

    // Saturate queued.test (1 req/s) so its request is still queued.
    DomainLimiterFactory.getLimiter("queued.test", 1).startRequest();

    const queue = createQueue({ maxRetries: 0 });
    const inflight = enqueueTrackedAsset(queue, "https://hung.test/a.png");
    const queued = enqueueTrackedAsset(queue, "https://queued.test/b.png");
    await inflight.id;
    await queued.id;

    await vi.advanceTimersByTimeAsync(50);
    expect(queue.getActiveRequests()).toHaveLength(1);
    expect(queue.getQueuedRequests()).toHaveLength(1);
    const hungLimiter = DomainLimiterFactory.getLimiter("hung.test");
    expect(hungLimiter.activeConnections).toBe(1);

    queue.clear();

    // Every handler settled exactly once with a cancelled-category error.
    const [inflightOutcome, queuedOutcome] = await Promise.all([
      inflight.outcome,
      queued.outcome,
    ]);
    for (const outcome of [inflightOutcome, queuedOutcome]) {
      const error = outcomeError(outcome);
      expect(error).toBeInstanceOf(RequestQueueError);
      expect((error as RequestQueueError).category).toBe("cancelled");
      expect(error.message).toContain("cleared");
    }
    expect(inflight.settlements).toHaveLength(1);
    expect(queued.settlements).toHaveLength(1);

    // The teardown itself released the in-flight limiter slot.
    expect(hungLimiter.activeConnections).toBe(0);

    // The aborted fetch's late rejection arrives after the map entry is
    // gone — it must be a no-op: no second settlement, no slot re-release.
    rejectInflight(new TypeError("Failed to fetch"));
    await vi.advanceTimersByTimeAsync(50);
    expect(inflight.settlements).toHaveLength(1);
    expect(hungLimiter.activeConnections).toBe(0);

    // No further fetch is started (retry timers cancelled, nothing requeued).
    const fetchesAfterClear = assetCallsOf(fetchMock).length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(assetCallsOf(fetchMock)).toHaveLength(fetchesAfterClear);
    expect(queue.getActiveRequests()).toHaveLength(0);
    expect(queue.getQueuedRequests()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Task 6.5 — processQueue reschedules after an internal throw (D3)
  // -------------------------------------------------------------------------

  it("recovers and processes queued work after an internal processQueue throw", async () => {
    stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    const queue = createQueue();
    const throttlingManager = (
      queue as unknown as { throttlingManager: ThrottlingManager }
    ).throttlingManager;
    const concurrencySpy = vi
      .spyOn(throttlingManager, "getAdaptiveConcurrency")
      .mockImplementationOnce(() => {
        throw new Error("boom");
      });

    const a = enqueueTrackedAsset(queue, "https://ok.test/1.png");
    const b = enqueueTrackedAsset(queue, "https://ok.test/2.png");
    await a.id;
    await b.id;

    await vi.advanceTimersByTimeAsync(100);

    // The throw was logged and did NOT strand the queue: a recovery cycle
    // ran (second getAdaptiveConcurrency call) and both requests completed.
    expect(warnSpy).toHaveBeenCalledWith(
      "RequestQueue: processing cycle failed",
      expect.any(Error),
    );
    expect(concurrencySpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    const [aOutcome, bOutcome] = await Promise.all([a.outcome, b.outcome]);
    expect(outcomeResult(aOutcome).response).toBeDefined();
    expect(outcomeResult(bOutcome).response).toBeDefined();
    expect(a.settlements).toHaveLength(1);
    expect(b.settlements).toHaveLength(1);
    expect(queue.getStats().completed).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Task 6.6 — paused scheduler quiescence (D3)
  // -------------------------------------------------------------------------

  it("arms no timers while paused and processes queued work on resume", async () => {
    stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    // Rate-limit the domain so both requests stay queued.
    DomainLimiterFactory.getLimiter("pause.test", 1).startRequest();

    const queue = createQueue();
    const a = enqueueTrackedAsset(queue, "https://pause.test/1.png");
    const b = enqueueTrackedAsset(queue, "https://pause.test/2.png");
    await a.id;
    await b.id;

    await vi.advanceTimersByTimeAsync(100);
    expect(queue.getQueuedRequests()).toHaveLength(2);

    queue.pause();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await vi.advanceTimersByTimeAsync(200);
    // Zero scheduler timer callbacks (~1ms delay) in the observation window.
    const schedulerTicks = setTimeoutSpy.mock.calls.filter(
      (call) => Number(call[1]) === 1,
    );
    expect(schedulerTicks).toHaveLength(0);
    setTimeoutSpy.mockRestore();

    // Work is preserved across the pause.
    expect(queue.getQueuedRequests()).toHaveLength(2);

    queue.resume();
    // Covers the rate-limit cooldown AND the second request's in-start
    // domain wait (it observes the first request's rate-window timestamp).
    await vi.advanceTimersByTimeAsync(3000);

    expect(outcomeResult(await a.outcome)).toBeDefined();
    expect(outcomeResult(await b.outcome)).toBeDefined();
    expect(queue.getStats().completed).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Task 6.7 — pool saturation schedules a real wait (D4), queue level
  // -------------------------------------------------------------------------

  it("waits ~100ms instead of the 10ms tick while the connection pool is saturated", async () => {
    stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    const limiter = DomainLimiterFactory.getLimiter("pool.test");
    limiter.connectionPoolSize = 1;
    limiter.activeConnections = 1; // pool saturated

    const queue = createQueue({ maxConcurrentRequests: 4 });
    const asset = enqueueTrackedAsset(queue, "https://pool.test/a.png");
    await asset.id;

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await vi.advanceTimersByTimeAsync(50);

    // A limiter-availability wait above the minimum tick was armed (~100ms).
    const waits = setTimeoutSpy.mock.calls
      .map((call) => Number(call[1]))
      .filter((delay) => delay > QUEUE_TICK_MS);
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.min(...waits)).toBeLessThanOrEqual(100);

    // Pool-blocked: the request has not started.
    expect(queue.getQueuedRequests()).toHaveLength(1);
    setTimeoutSpy.mockRestore();

    // A freed pool slot lets the scheduled wait fire and the request run.
    limiter.completeRequest();
    await vi.advanceTimersByTimeAsync(300);
    expect(outcomeResult(await asset.outcome)).toBeDefined();
    expect(asset.settlements).toHaveLength(1);
    expect(limiter.activeConnections).toBe(0);
  });
});
