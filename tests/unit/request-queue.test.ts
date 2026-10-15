/**
 * Unit tests for RequestQueue fetch hardening.
 *
 * Covers OpenSpec tasks 2.1–2.5 of "stabilize-extension-downloads-and-ux":
 * - 2.1: dedup cache stores a readable snapshot; two consumers both succeed;
 *   bodies above 5MB bypass the cache and re-fetch
 * - 2.2: requestTimeout enforced via composite abort; timeouts categorized;
 *   download-cancel aborts immediately
 * - 2.3: primary fetch uses credentials "include"; one cookieless retry on 4xx
 * - 2.4 (foundation): opaque responses flagged on the result, body never read
 * - 2.5: fair scheduling across rate-limited domains; availability wait
 *   instead of a 10ms busy-spin
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestQueue } from "../../src/utils/RequestQueue";
import { DomainLimiterFactory } from "../../src/utils/DomainLimiter";
import { memoryManager } from "../../src/utils/MemoryManager";
import {
  MAX_DEDUP_CACHE_BODY_SIZE,
  RequestPriority,
  RequestQueueError,
  RequestResult,
  ResourceType,
} from "../../src/types/queue";

const ROBOTS_OK = "User-agent: *\nAllow: /\n";

type FetchHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>;

describe("RequestQueue", () => {
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

  const enqueueAsset = (
    queue: RequestQueue,
    url: string,
    resourceType: ResourceType = ResourceType.IMAGE,
  ): {
    result: Promise<RequestResult>;
    failure: Promise<Error>;
    id: Promise<string>;
  } => {
    let resolveResult!: (result: RequestResult) => void;
    let resolveFailure!: (error: Error) => void;
    const result = new Promise<RequestResult>((resolve) => {
      resolveResult = resolve;
    });
    const failure = new Promise<Error>((resolve) => {
      resolveFailure = resolve;
    });

    const id = queue.enqueue({
      url,
      resourceType,
      priority: RequestPriority.NORMAL,
      domain: "",
      dependencies: [],
      retryCount: 0,
      estimatedSize: 0,
      onComplete: (completed) => resolveResult(completed),
      onError: (error) => resolveFailure(error),
    });

    return { result, failure, id };
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
  // Task 2.1 — consumable dedup cache
  // -------------------------------------------------------------------------

  it("serves two consumers of the same URL with independently readable bodies", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("PNG-BYTES", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    });

    const queue = createQueue();
    const first = enqueueAsset(queue, "https://cdn.test/img.png");
    await first.id;
    await vi.advanceTimersByTimeAsync(50);
    const r1 = await first.result;

    // Second reference within the TTL is served from the cached snapshot.
    const second = enqueueAsset(queue, "https://cdn.test/img.png");
    await second.id;
    const r2 = await second.result;

    // Both consumers read the body independently — with the old cache
    // (sharing one Response) the second read threw "body already consumed".
    await expect(r1.response.text()).resolves.toBe("PNG-BYTES");
    await expect(r2.response.text()).resolves.toBe("PNG-BYTES");

    expect(Array.from(r1.snapshot.bytes!)).toEqual(
      Array.from(r2.snapshot.bytes!),
    );
    expect(r1.snapshot.contentType).toBe("image/png");
    expect(r1.response.headers.get("Content-Type")).toBe("image/png");
    expect(typeof r1.type).toBe("string");

    // Exactly one network fetch for the asset (robots.txt excluded).
    expect(assetCallsOf(fetchMock)).toHaveLength(1);
  });

  it("bypasses the dedup cache and re-fetches bodies above 5MB", async () => {
    const big = new Uint8Array(MAX_DEDUP_CACHE_BODY_SIZE + 1);
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response(big, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    });

    const queue = createQueue();

    const first = enqueueAsset(queue, "https://cdn.test/big.bin");
    await vi.advanceTimersByTimeAsync(100);
    const r1 = await first.result;
    expect(r1.size).toBe(big.byteLength);

    const second = enqueueAsset(queue, "https://cdn.test/big.bin");
    await second.id;
    await vi.advanceTimersByTimeAsync(100);
    const r2 = await second.result;

    // Not cached → the URL was fetched twice; both results are complete.
    expect(assetCallsOf(fetchMock)).toHaveLength(2);
    expect(r2.size).toBe(big.byteLength);
    expect(queue.getStats().completed).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Task 2.2 — fetch timeout enforcement
  // -------------------------------------------------------------------------

  const hungFetchHandler: FetchHandler = (url, init) => {
    if (url.includes("/robots.txt")) {
      return new Response(ROBOTS_OK, { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () =>
          reject(signal.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  };

  it("aborts a hung fetch after requestTimeout and releases the queue slot", async () => {
    stubFetch(hungFetchHandler);
    const releaseSpy = vi.spyOn(memoryManager, "releaseResource");

    const queue = createQueue({ requestTimeout: 1000 });
    const { result, failure, id } = enqueueAsset(queue, "https://hung.test/a.png");
    const requestId = await id;

    await vi.advanceTimersByTimeAsync(50);
    expect(queue.getActiveRequests()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);

    const error = await failure;
    expect(error).toBeInstanceOf(RequestQueueError);
    expect((error as RequestQueueError).category).toBe("timeout");
    expect(error.message).toContain("timed out");

    // Slot released, failure recorded, allocation released in `finally`.
    expect(queue.getActiveRequests()).toHaveLength(0);
    expect(queue.getStats().failed).toBe(1);
    expect(releaseSpy).toHaveBeenCalledWith(requestId);

    // No phantom retry after the failure (maxRetries: 0).
    await vi.advanceTimersByTimeAsync(5000);
    expect(queue.getStats().failed).toBe(1);
  });

  it("aborts immediately on download cancel, independent of the timeout", async () => {
    stubFetch(hungFetchHandler);

    const queue = createQueue({ requestTimeout: 10_000 });
    const { failure, id } = enqueueAsset(queue, "https://hung.test/b.png");
    const requestId = await id;

    await vi.advanceTimersByTimeAsync(50);
    expect(queue.getActiveRequests()).toHaveLength(1);

    expect(queue.cancelRequest(requestId)).toBe(true);

    // Settles via the abort signal — without advancing to the 10s timeout.
    const error = await failure;
    expect(error).toBeInstanceOf(RequestQueueError);
    expect((error as RequestQueueError).category).toBe("cancelled");
    expect(queue.getActiveRequests()).toHaveLength(0);

    // The timeout timer was cleaned up — no late second failure.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(queue.getStats().failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Task 2.3 — credentialed fetches
  // -------------------------------------------------------------------------

  it("fetches with credentials include and retries once with omit on 4xx", async () => {
    let assetCalls = 0;
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      assetCalls++;
      if (assetCalls === 1) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response("SECRET-ASSET", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    });

    const queue = createQueue();
    const { result } = enqueueAsset(queue, "https://private.test/asset.png");
    await vi.advanceTimersByTimeAsync(50);
    const completed = await result;

    await expect(completed.response.text()).resolves.toBe("SECRET-ASSET");

    const calls = assetCallsOf(fetchMock);
    expect(calls).toHaveLength(2);
    expect(calls[0][1].credentials).toBe("include");
    expect(calls[1][1].credentials).toBe("omit");
    expect(calls[0][1].method).toBe("GET");
    expect(calls[1][0]).toBe(calls[0][0]);
  });

  it("uses a single credentialed request when the first fetch succeeds", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    const queue = createQueue();
    const { result } = enqueueAsset(queue, "https://ok.test/asset.png");
    await vi.advanceTimersByTimeAsync(50);
    await result;

    const calls = assetCallsOf(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].credentials).toBe("include");
  });

  it("does not cookieless-retry non-4xx failures", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("nope", { status: 500 });
    });

    const queue = createQueue();
    // Documents get no fallback at all — isolates the cookieless-retry rule.
    const { failure } = enqueueAsset(
      queue,
      "https://broken.test/asset.pdf",
      ResourceType.DOCUMENT,
    );
    await vi.advanceTimersByTimeAsync(50);

    const error = await failure;
    expect((error as RequestQueueError).category).toBe("http");
    expect((error as RequestQueueError).status).toBe(500);
    expect(assetCallsOf(fetchMock)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Task 2.4 (foundation) — opaque response flag
  // -------------------------------------------------------------------------

  it("flags opaque no-cors responses instead of reading their bodies", async () => {
    stubFetch((url, init) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      if (init.mode === "no-cors") {
        // Simulated opaque response: status 0, unreadable body.
        return {
          type: "opaque",
          status: 0,
          ok: false,
          headers: new Headers(),
          arrayBuffer: async () => {
            throw new TypeError("Failed to fetch");
          },
        } as unknown as Response;
      }
      // Credentialed CORS attempt fails at the network level.
      throw new TypeError("Failed to fetch");
    });

    const queue = createQueue();
    const { result } = enqueueAsset(
      queue,
      "https://cross.test/pic.png",
      ResourceType.IMAGE,
    );
    await vi.advanceTimersByTimeAsync(50);

    const completed = await result;
    expect(completed.type).toBe("opaque");
    expect(completed.snapshot.type).toBe("opaque");
    expect(completed.snapshot.bytes).toBeNull();
    expect(completed.size).toBe(0);
  });

  it("does not attempt the no-cors fallback for text resources", async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      throw new TypeError("Failed to fetch");
    });

    const queue = createQueue();
    const { failure } = enqueueAsset(
      queue,
      "https://cross.test/style.css",
      ResourceType.CSS,
    );
    await vi.advanceTimersByTimeAsync(50);

    const error = await failure;
    expect((error as RequestQueueError).category).toBe("network");
    expect(assetCallsOf(fetchMock)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Task 2.5 — fair scheduling across rate-limited domains
  // -------------------------------------------------------------------------

  it("starts ready requests from other domains while the head domain is rate-limited", async () => {
    stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    // Saturate the slow domain's 1 req/s budget before queueing.
    const slowLimiter = DomainLimiterFactory.getLimiter("slow.test", 1);
    slowLimiter.startRequest();

    const queue = createQueue({ maxConcurrentRequests: 4 });
    const slow = enqueueAsset(queue, "https://slow.test/a.png");
    const fast = enqueueAsset(queue, "https://fast.test/b.png");
    const slowId = await slow.id;
    await fast.id;

    await vi.advanceTimersByTimeAsync(100);

    // The fast-domain request completed while the slow domain cools down.
    const fastResult = await fast.result;
    expect(fastResult.snapshot.status).toBe(200);

    // The slow-domain request has not started yet.
    expect(queue.getQueuedRequests().map((r) => r.id)).toContain(slowId);
    expect(queue.getStats().completed).toBe(1);

    // Once the cooldown expires, the slow request starts and completes too.
    await vi.advanceTimersByTimeAsync(1200);
    const slowResult = await slow.result;
    expect(slowResult.snapshot.status).toBe(200);
    expect(queue.getQueuedRequests().map((r) => r.id)).not.toContain(slowId);
  });

  it("waits on the nearest limiter availability instead of busy-spinning", async () => {
    stubFetch((url) => {
      if (url.includes("/robots.txt")) {
        return new Response(ROBOTS_OK, { status: 200 });
      }
      return new Response("DATA", { status: 200 });
    });

    const slowLimiter = DomainLimiterFactory.getLimiter("slow.test", 1);
    slowLimiter.startRequest();

    const queue = createQueue({ maxConcurrentRequests: 4 });
    const a = enqueueAsset(queue, "https://slow.test/1.png");
    const b = enqueueAsset(queue, "https://slow.test/2.png");
    await a.id;
    await b.id;

    // Initial settle: both requests are limiter-blocked, one long wait is armed.
    await vi.advanceTimersByTimeAsync(100);

    const processSpy = vi.fn();
    const originalProcess = (
      queue as unknown as { processQueue: () => Promise<void> }
    ).processQueue.bind(queue);
    (
      queue as unknown as { processQueue: () => Promise<void> }
    ).processQueue = () => {
      processSpy();
      return originalProcess();
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Inside the cooldown window the queue must stay idle: no 10ms polling.
    await vi.advanceTimersByTimeAsync(800);
    expect(processSpy).not.toHaveBeenCalled();
    const tickCalls = setTimeoutSpy.mock.calls.filter(
      (call) => Number(call[1]) === 10,
    );
    expect(tickCalls).toHaveLength(0);

    // Availability fires, both requests start and complete.
    await vi.advanceTimersByTimeAsync(1500);
    await a.result;
    await b.result;
    expect(processSpy).toHaveBeenCalled();
    expect(queue.getStats().completed).toBe(2);

    setTimeoutSpy.mockRestore();
  });
});
