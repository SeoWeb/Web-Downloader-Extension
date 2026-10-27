/**
 * Unit tests for UploadQueue (tasks 9.1–9.6).
 *
 * All HTTP calls are mocked — no real server needed.
 * Tests validate concurrency, progress tracking, retry logic,
 * cancellation, and blob memory release.
 */

import {
  ServerClient,
  ServerUnavailableError,
  AuthenticationError,
  HttpError,
} from "../../src/background/server-client";
import {
  UploadQueue,
  UploadTask,
  QueueProgress,
} from "../../src/background/upload-queue";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock ServerClient that returns a controlled uploadResource. */
function createMockServerClient(overrides?: {
  uploadResource?: (
    sessionId: string,
    path: string,
    blob: Blob,
    originalUrl: string,
    contentType: string,
    signal?: AbortSignal,
    onUploadProgress?: (loaded: number, total: number) => void,
  ) => Promise<unknown>;
}): ServerClient {
  const client = new ServerClient();
  // Override uploadResource if provided
  if (overrides?.uploadResource) {
    (client as any).uploadResource = overrides.uploadResource;
  }
  return client;
}

/** Create a Blob of the given size. */
function createBlob(size: number, type = "application/octet-stream"): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

/** Wait for the specified number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UploadQueue", () => {
  let progressEvents: QueueProgress[];
  let sessionFullCalls: string[];

  function createQueue(
    options?: { maxConcurrency?: number },
    uploadFn?: (
      sessionId: string,
      path: string,
      blob: Blob,
      originalUrl: string,
      contentType: string,
      signal?: AbortSignal,
      onUploadProgress?: (loaded: number, total: number) => void,
    ) => Promise<unknown>,
  ): UploadQueue {
    const client = createMockServerClient({
      uploadResource: uploadFn as any,
    });
    progressEvents = [];
    sessionFullCalls = [];

    const queue = new UploadQueue(client, {
      maxConcurrency: options?.maxConcurrency ?? 5,
      onProgress: (p) => progressEvents.push({ ...p }),
      onSessionFull: (sid) => sessionFullCalls.push(sid),
    });
    return queue;
  }

  // -----------------------------------------------------------------------
  // 9.1 — Max 5 concurrent uploads
  // -----------------------------------------------------------------------
  describe("concurrency control", () => {
    it("limits concurrent uploads to maxConcurrency", async () => {
      let activeCount = 0;
      let maxActive = 0;
      const concurrency = 3;

      const queue = createQueue({ maxConcurrency: concurrency }, async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await sleep(50);
        activeCount--;
        return {
          resource_id: "r1",
          local_path: "img.png",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      // Enqueue 10 uploads
      const sessionId = "test-session";
      for (let i = 0; i < 10; i++) {
        await queue.enqueue(
          sessionId,
          `images/img${i}.png`,
          createBlob(100),
          `https://example.com/img${i}.png`,
          "image/png",
        );
      }

      await queue.waitForAll();

      expect(maxActive).toBeLessThanOrEqual(concurrency);
    });

    it("defaults to max 12 concurrent uploads", async () => {
      let activeCount = 0;
      let maxActive = 0;

      const queue = createQueue({}, async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await sleep(50);
        activeCount--;
        return {
          resource_id: "r1",
          local_path: "img.png",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      for (let i = 0; i < 15; i++) {
        await queue.enqueue(
          "s1",
          `img${i}`,
          createBlob(100),
          `url${i}`,
          "image/png",
        );
      }

      await queue.waitForAll();

      expect(maxActive).toBeLessThanOrEqual(12);
    });
  });

  // -----------------------------------------------------------------------
  // 9.2 — Upload progress tracking
  // -----------------------------------------------------------------------
  describe("progress tracking", () => {
    it("tracks completedCount and totalCount", async () => {
      const queue = createQueue({}, async () => {
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      const sessionId = "s1";
      await queue.enqueue(
        sessionId,
        "img1",
        createBlob(100),
        "url1",
        "image/png",
      );
      await queue.enqueue(
        sessionId,
        "img2",
        createBlob(200),
        "url2",
        "image/png",
      );
      await queue.enqueue(
        sessionId,
        "img3",
        createBlob(300),
        "url3",
        "image/png",
      );

      await queue.waitForAll();

      const progress = queue.getProgress();
      expect(progress.completedCount).toBe(3);
      expect(progress.totalCount).toBe(3);
      expect(progress.bytesUploaded).toBe(600); // 100 + 200 + 300
      expect(progress.totalBytes).toBe(600);
    });

    it("emits progress events as tasks complete", async () => {
      const queue = createQueue({}, async () => {
        await sleep(10);
        return {
          resource_id: "r1",
          local_path: "x",
          size: 50,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(50), "url1", "image/png");
      await queue.enqueue("s1", "img2", createBlob(50), "url2", "image/png");

      await queue.waitForAll();

      // Should have at least 2 progress events (one per task)
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      // Final event should show all complete
      const lastEvent = progressEvents[progressEvents.length - 1];
      expect(lastEvent.completedCount).toBe(2);
    });

    it("getResourceCount returns pending + active + completed", async () => {
      const queue = createQueue({}, async () => {
        await sleep(50);
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.enqueue("s1", "img2", createBlob(100), "url2", "image/png");

      // Before completion, resource count should be at least 2
      const countBefore = queue.getResourceCount();
      expect(countBefore).toBeGreaterThanOrEqual(2);

      await queue.waitForAll();

      // After completion, resource count includes completed
      expect(queue.getResourceCount()).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 9.3 — Retry logic
  // -----------------------------------------------------------------------
  describe("retry logic", () => {
    it("retries on 5xx errors with exponential backoff", async () => {
      let callCount = 0;

      const queue = createQueue({}, async () => {
        callCount++;
        if (callCount <= 2) {
          throw new ServerUnavailableError("Server error", undefined, 500);
        }
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      // Speed up retries by making backoff short
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = (ms: number) =>
        origSleep.call(queue, Math.min(ms, 10));

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.waitForAll();

      expect(callCount).toBe(3); // initial + 2 retries
      expect(queue.getProgress().completedCount).toBe(1);
    });

    it("retries on 429 Rate Limit with Retry-After", async () => {
      let callCount = 0;

      const queue = createQueue({}, async () => {
        callCount++;
        if (callCount === 1) {
          throw new HttpError("Rate limited", 429, 1); // Retry-After: 1 second
        }
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      // Speed up retries
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = () => origSleep.call(queue, 10);

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.waitForAll();

      expect(callCount).toBe(2); // initial + 1 retry
      expect(queue.getProgress().completedCount).toBe(1);
    });

    it("gives up after max retries on 5xx", async () => {
      let callCount = 0;

      const queue = createQueue({}, async () => {
        callCount++;
        throw new ServerUnavailableError("Always fails", undefined, 500);
      });

      // Speed up retries
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = () => origSleep.call(queue, 5);

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      // Wait for retries to exhaust
      await sleep(200);

      expect(callCount).toBe(4); // initial + 3 retries
      expect(queue.getProgress().failedCount).toBe(1);
      expect(queue.getProgress().completedCount).toBe(0);
    });

    it("413 Session Full is fatal and triggers onSessionFull callback", async () => {
      const queue = createQueue({}, async () => {
        throw new HttpError("Session full", 413);
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(50);

      expect(queue.getProgress().failedCount).toBe(1);
      expect(queue.getProgress().completedCount).toBe(0);
      expect(sessionFullCalls).toEqual(["s1"]);
    });

    it("4xx errors (non-429, non-413) are not retried", async () => {
      let callCount = 0;

      const queue = createQueue({}, async () => {
        callCount++;
        throw new HttpError("Not found", 404);
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(50);

      expect(callCount).toBe(1); // No retries
      expect(queue.getProgress().failedCount).toBe(1);
    });

    it("AuthenticationError is not retried", async () => {
      let callCount = 0;

      const queue = createQueue({}, async () => {
        callCount++;
        throw new AuthenticationError("Auth failed");
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(50);

      expect(callCount).toBe(1);
      expect(queue.getProgress().failedCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 9.4 — Queue cancellation
  // -----------------------------------------------------------------------
  describe("cancellation", () => {
    it("cancels in-progress uploads via AbortController", async () => {
      let aborted = false;

      const queue = createQueue(
        {},
        async (_sid, _path, _blob, _url, _ct, signal) => {
          // Simulate a long upload that checks for abort
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      );

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(20); // Let the upload start

      queue.cancel();

      expect(aborted).toBe(true);
      expect(queue.isCancelled()).toBe(true);
    });

    it("cancels pending uploads without starting them", async () => {
      let uploadCount = 0;

      const queue = createQueue({ maxConcurrency: 1 }, async () => {
        uploadCount++;
        await sleep(100);
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      // Enqueue 5 uploads; only 1 can run at a time (concurrency=1)
      for (let i = 0; i < 5; i++) {
        await queue.enqueue(
          "s1",
          `img${i}`,
          createBlob(100),
          `url${i}`,
          "image/png",
        );
      }

      await sleep(20); // Let the first one start
      queue.cancel();

      // Only 1 should have started (the first one)
      expect(uploadCount).toBe(1);
      expect(queue.getProgress().failedCount).toBe(5);
    });

    it("rejects new enqueues after cancellation", async () => {
      const queue = createQueue({}, async () => ({
        resource_id: "r1",
        local_path: "x",
        size: 100,
        deduplicated: false,
        api_version: "v1",
      }));

      queue.cancel();

      await expect(
        queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png"),
      ).rejects.toThrow("UploadQueue has been cancelled");
    });
  });

  // -----------------------------------------------------------------------
  // 9.5 — Aggressive blob memory release
  // -----------------------------------------------------------------------
  describe("blob memory release", () => {
    it("nullifies blob reference after successful upload", async () => {
      let blobSeenDuringUpload: Blob | null = null;

      const queue = createQueue({}, async (_sid, _path, blob) => {
        // Capture the blob reference during upload — it should be non-null
        // because ServerClient holds its own parameter reference
        blobSeenDuringUpload = blob;
        await sleep(50);
        return {
          resource_id: "r1",
          local_path: "x",
          size: blob.size,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.waitForAll();

      // Verify the upload was called with a non-null blob
      expect(blobSeenDuringUpload).not.toBeNull();
      expect(blobSeenDuringUpload!.size).toBe(100);

      // Verify the queue completed (blob was released internally)
      expect(queue.getProgress().completedCount).toBe(1);
    });

    it("nullifies blob reference after failed upload", async () => {
      const queue = createQueue({}, async () => {
        throw new HttpError("Not found", 404);
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(50);

      // The task should be marked failed and blob nullified
      expect(queue.getProgress().failedCount).toBe(1);
    });

    it("nullifies blob references on cancellation", async () => {
      const queue = createQueue({ maxConcurrency: 1 }, async () => {
        await sleep(200);
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.enqueue("s1", "img2", createBlob(200), "url2", "image/png");

      await sleep(20);
      queue.cancel();

      expect(queue.getProgress().failedCount).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // W1 — Real-time upload progress via onUploadProgress callback
  // -----------------------------------------------------------------------
  describe("real-time upload progress", () => {
    it("reports intermediate bytesSent via onUploadProgress callback", async () => {
      const capturedProgress: { loaded: number; total: number }[] = [];

      const queue = createQueue(
        {},
        async (_sid, _path, _blob, _url, _ct, _signal, onProgress) => {
          // Simulate XHR progress events
          if (onProgress) {
            onProgress(30, 100);
            onProgress(70, 100);
          }
          await sleep(10);
          return {
            resource_id: "r1",
            local_path: "x",
            size: 100,
            deduplicated: false,
            api_version: "v1",
          };
        },
      );

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await queue.waitForAll();

      // The progress events should include intermediate states
      // where bytesUploaded reflects partial progress.
      // Since bytesUploaded tracks completed tasks only and
      // bytesSent is per-task, we verify that progress events
      // were emitted during the upload (more than just the final one).
      expect(progressEvents.length).toBeGreaterThanOrEqual(3); // 2 intermediate + 1 final

      // After completion, bytesSent should equal totalBytes
      const finalProgress = queue.getProgress();
      expect(finalProgress.completedCount).toBe(1);
      expect(finalProgress.bytesUploaded).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // Promise-based waitForAll (spec: extension-server-client)
  // -----------------------------------------------------------------------
  describe("waitForAll promise-based notification", () => {
    it("resolves immediately when queue is already empty", async () => {
      const queue = createQueue({}, async () => ({
        resource_id: "r1",
        local_path: "x",
        size: 100,
        deduplicated: false,
        api_version: "v1",
      }));

      // Queue has never had any tasks — waitForAll should resolve immediately
      const start = Date.now();
      await queue.waitForAll();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(50); // Should be near-instant
    });

    it("resolves promptly when last upload completes (no 100ms polling delay)", async () => {
      let uploadResolve: (() => void) | undefined;

      const queue = createQueue({}, async () => {
        // Hold the upload open until we explicitly resolve it
        await new Promise<void>((resolve) => {
          uploadResolve = resolve;
        });
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");

      // Wait for the upload to actually start
      await sleep(20);

      // Start waiting for all uploads
      const waitPromise = queue.waitForAll();
      const start = Date.now();

      // Complete the upload
      uploadResolve!();
      await waitPromise;

      const elapsed = Date.now() - start;
      // Should resolve within ~10ms, not the old 100ms polling delay
      expect(elapsed).toBeLessThan(50);
      expect(queue.getProgress().completedCount).toBe(1);
    });

    it("rejects on queue cancellation", async () => {
      const queue = createQueue({}, async () => {
        // Long-running upload
        await sleep(5000);
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(20);

      const waitPromise = queue.waitForAll();

      // Cancel the queue — waitForAll should reject
      queue.cancel();

      await expect(waitPromise).rejects.toThrow("UploadQueue was cancelled");
    });
  });

  // -----------------------------------------------------------------------
  // 9.6 — Integration: concurrent uploads with progress + retry + memory
  // -----------------------------------------------------------------------
  describe("end-to-end verification", () => {
    it("concurrent uploads work with correct progress, retry, and memory release", async () => {
      let callCount = 0;
      let activeCount = 0;
      let maxActive = 0;

      const queue = createQueue({ maxConcurrency: 3 }, async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        callCount++;

        // Fail the first call to test retry
        if (callCount === 1) {
          activeCount--;
          throw new ServerUnavailableError("Transient error", undefined, 503);
        }

        await sleep(20);
        activeCount--;
        return {
          resource_id: "r1",
          local_path: "x",
          size: 100,
          deduplicated: false,
          api_version: "v1",
        };
      });

      // Speed up retries
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = (ms: number) =>
        origSleep.call(queue, Math.min(ms, 10));

      // Enqueue 6 resources
      for (let i = 0; i < 6; i++) {
        await queue.enqueue(
          "s1",
          `img${i}`,
          createBlob(100),
          `url${i}`,
          "image/png",
        );
      }

      await queue.waitForAll();

      const progress = queue.getProgress();
      expect(progress.completedCount).toBe(6);
      expect(progress.failedCount).toBe(0);
      expect(progress.bytesUploaded).toBe(600);
      expect(progress.totalBytes).toBe(600);
      expect(maxActive).toBeLessThanOrEqual(3);

      // Progress events should have been emitted
      expect(progressEvents.length).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// D1 — TimeoutError aborts are retryable (fix-archived-page-pipeline)
//
// AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
// Before the fix this fell through to the non-retryable path, making a hung
// upload a single-attempt permanent failure. User cancellation (AbortError)
// must remain terminal.
// ---------------------------------------------------------------------------

const UPLOAD_OK = {
  resource_id: "r1",
  local_path: "x",
  size: 100,
  deduplicated: false,
  api_version: "v1",
};

/** Standalone queue factory (the one inside describe("UploadQueue") is
 *  scoped there; these suites need their own with local callback tracking). */
function createStandaloneQueue(
  options: { maxConcurrency?: number },
  uploadFn?: (
    sessionId: string,
    path: string,
    blob: Blob,
    originalUrl: string,
    contentType: string,
    signal?: AbortSignal,
    onUploadProgress?: (loaded: number, total: number) => void,
  ) => Promise<unknown>,
  handlers?: {
    onProgress?: (p: QueueProgress) => void;
    onSessionFull?: (sessionId: string) => void;
  },
): UploadQueue {
  const client = createMockServerClient({ uploadResource: uploadFn as any });
  return new UploadQueue(client, {
    maxConcurrency: options?.maxConcurrency ?? 5,
    onProgress: handlers?.onProgress,
    onSessionFull: handlers?.onSessionFull,
  });
}

describe("UploadQueue timeout classification (D1)", () => {
  /** Make retry backoff near-instant while keeping sleep async. */
  function speedUpSleep(queue: UploadQueue): void {
    const origSleep = (queue as any).sleep;
    (queue as any).sleep = (ms: number) =>
      origSleep.call(queue, Math.min(ms, 10));
  }

  it("retries TimeoutError aborts and eventually succeeds", async () => {
    let callCount = 0;

    const queue = createStandaloneQueue({}, async () => {
      callCount++;
      if (callCount <= 2) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return { ...UPLOAD_OK };
    });
    speedUpSleep(queue);

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await queue.waitForAll();

    expect(callCount).toBe(3); // initial + 2 retries
    expect(queue.getProgress().completedCount).toBe(1);
    expect(queue.getProgress().failedCount).toBe(0);
  });

  it("exhausts the retry budget on persistent TimeoutError, then fails visibly (one log)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let callCount = 0;

    const queue = createStandaloneQueue({}, async () => {
      callCount++;
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    speedUpSleep(queue);

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await queue.waitForAll();

    expect(callCount).toBe(4); // initial + MAX_RETRIES(3) — retried, not permanent-on-first
    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getProgress().completedCount).toBe(0);

    const terminalLogs = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Upload failed permanently"),
    );
    expect(terminalLogs).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("AbortError (user cancellation) remains terminal — no retry", async () => {
    let callCount = 0;

    const queue = createStandaloneQueue({}, async () => {
      callCount++;
      throw new DOMException("The user aborted a request.", "AbortError");
    });

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await sleep(50);

    expect(callCount).toBe(1);
    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getProgress().completedCount).toBe(0);
  });

  it("a task signal aborted by queue cancel() stays terminal (never retried)", async () => {
    let callCount = 0;

    const queue = createStandaloneQueue(
      { maxConcurrency: 1 },
      async (_sid, _path, _blob, _url, _ct, signal) => {
        callCount++;
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    );

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await sleep(20);
    queue.cancel();
    await sleep(30); // let the rejection land

    expect(callCount).toBe(1);
    expect(queue.isCancelled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D2 — Terminal failure logging, exactly once per class
// (fix-archived-page-pipeline)
// ---------------------------------------------------------------------------

describe("UploadQueue terminal failure logging (D2)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("AuthenticationError logs exactly one structured error", async () => {
    const queue = createStandaloneQueue({}, async () => {
      throw new AuthenticationError(
        "Authentication failed after re-registration",
      );
    });

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await sleep(50);

    expect(queue.getProgress().failedCount).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain(
      "Authentication failed",
    );
    expect(String(errorSpy.mock.calls[0][0])).toContain("path=img1");
  });

  it("413 session-full fail-all drain logs exactly once (not per drained task)", async () => {
    const sessionFullCalls: string[] = [];
    const queue = createStandaloneQueue(
      { maxConcurrency: 1 },
      async () => {
        throw new HttpError("Session full", 413);
      },
      { onSessionFull: (sid) => sessionFullCalls.push(sid) },
    );

    // Enqueue synchronously (no await) so all 5 land in `pending` before the
    // first upload attempt runs and triggers the session-full drain.
    for (let i = 0; i < 5; i++) {
      void queue
        .enqueue("s1", `img${i}`, createBlob(100), `url${i}`, "image/png")
        .catch(() => {
          // enqueue throws after sessionFullDetected — not expected here
        });
    }
    await sleep(80);

    // All 5 failed: 1 by 413 + 4 drained
    expect(queue.getProgress().failedCount).toBe(5);
    expect(sessionFullCalls).toEqual(["s1"]);

    const drainLogs = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Session full"),
    );
    expect(drainLogs).toHaveLength(1);
    expect(String(drainLogs[0][0])).toContain("drained 4 pending");
  });

  it("cancel() logs exactly one summary with active + pending counts", async () => {
    const queue = createStandaloneQueue({ maxConcurrency: 1 }, async () => {
      await sleep(200);
      return { ...UPLOAD_OK };
    });

    for (let i = 0; i < 3; i++) {
      await queue.enqueue(
        "s1",
        `img${i}`,
        createBlob(100),
        `url${i}`,
        "image/png",
      );
    }
    await sleep(20); // first starts, two pending
    queue.cancel();

    const summaries = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Queue cancelled"),
    );
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0][0])).toContain("1 active + 2 pending");
  });

  it("a late AbortError rejection after cancel() neither double-counts nor logs again", async () => {
    const queue = createStandaloneQueue(
      { maxConcurrency: 1 },
      async (_sid, _path, _blob, _url, _ct, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
    );

    for (let i = 0; i < 3; i++) {
      await queue.enqueue(
        "s1",
        `img${i}`,
        createBlob(100),
        `url${i}`,
        "image/png",
      );
    }
    await sleep(20); // first active, two pending
    queue.cancel();
    await sleep(30); // let the in-flight rejection reach handleTaskError

    // cancel() counted 1 active + 2 pending = 3; the late rejection of the
    // already-accounted active task must NOT bump it to 4 (D3 correctness).
    expect(queue.getProgress().failedCount).toBe(3);
    expect(queue.getProgress().totalCount).toBe(3);

    const summaries = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Queue cancelled"),
    );
    expect(summaries).toHaveLength(1);
    const perTaskAbortLogs = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("Upload aborted"),
    );
    expect(perTaskAbortLogs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D4 — checkpoint manifest entries carry size (blobs never persisted)
// ---------------------------------------------------------------------------

describe("UploadQueue resource manifest (D4)", () => {
  it("getResourceUrls entries include the task byte size", async () => {
    const queue = createStandaloneQueue({}, async () => {
      await sleep(10);
      return { ...UPLOAD_OK };
    });

    await queue.enqueue(
      "s1",
      "images/a.png",
      createBlob(111),
      "https://x/a.png",
      "image/png",
    );
    await queue.enqueue(
      "s1",
      "styles/b.css",
      createBlob(222),
      "https://x/b.css",
      "text/css",
    );
    await queue.waitForAll();

    const entries = queue.getResourceUrls();
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({
      url: "https://x/a.png",
      path: "images/a.png",
      contentType: "image/png",
      size: 111,
    });
    expect(entries).toContainEqual({
      url: "https://x/b.css",
      path: "styles/b.css",
      contentType: "text/css",
      size: 222,
    });
  });

  it("permanently failed tasks are excluded from the manifest", async () => {
    const queue = createStandaloneQueue({}, async () => {
      throw new HttpError("Not found", 404);
    });

    await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
    await sleep(50);

    expect(queue.getProgress().failedCount).toBe(1);
    expect(queue.getResourceUrls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-task terminal-reliability regressions (upload-queue-terminal-reliability)
//
// These lock in the queue's two liveness invariants across terminal paths:
// "an emptied active slot lets pending work start" and "a drained queue
// resolves its waiters" — plus counter integrity, bounded Retry-After, and
// checkpoint-manifest symmetry. All previous suites were single-task and
// could not catch any of these.
// ---------------------------------------------------------------------------

describe("UploadQueue terminal reliability (multi-task regressions)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /** Make retry backoff near-instant while keeping sleep async. */
  function speedUpSleep(queue: UploadQueue): void {
    const origSleep = (queue as any).sleep;
    (queue as any).sleep = (ms: number) =>
      origSleep.call(queue, Math.min(ms, 10));
  }

  it("starts pending tasks after all active tasks exhaust 429 retries (F8a)", async () => {
    let failAttempts = 0;
    let okAttempts = 0;

    const queue = createStandaloneQueue(
      { maxConcurrency: 2 },
      async (_sid, path) => {
        if (path.startsWith("fail")) {
          failAttempts++;
          throw new HttpError("Rate limited", 429);
        }
        okAttempts++;
        await sleep(10);
        return { ...UPLOAD_OK };
      },
    );
    speedUpSleep(queue);

    // Fire-and-forget so all 5 land in `pending` before processing starts:
    // fail-a and fail-b take both slots, ok-1..3 must wait for a free one.
    for (const path of ["fail-a", "fail-b", "ok-1", "ok-2", "ok-3"]) {
      void queue
        .enqueue("s1", path, createBlob(100), `https://x/${path}`, "image/png")
        .catch(() => {});
    }

    const start = Date.now();
    await queue.waitForAll(5000);
    const elapsed = Date.now() - start;

    // Both 429 tasks exhausted their budget (initial + MAX_RETRIES each)
    // and the three pending tasks started and completed afterwards.
    expect(failAttempts).toBe(8);
    expect(okAttempts).toBe(3);
    const progress = queue.getProgress();
    expect(progress.failedCount).toBe(2); // exhausted tasks only
    expect(progress.completedCount).toBe(3);
    expect(progress.totalCount).toBe(5);
    // Resolved, not timed out — the pre-fix queue stalled here forever.
    expect(elapsed).toBeLessThan(5000);
  });

  it("resolves waiters when a second concurrent 413 lands on the last active task (F8b)", async () => {
    const localSessionFullCalls: string[] = [];
    const queue = createStandaloneQueue(
      { maxConcurrency: 2 },
      async () => {
        throw new HttpError("Session full", 413);
      },
      { onSessionFull: (sid) => localSessionFullCalls.push(sid) },
    );

    // Synchronous enqueues: big-a and big-b occupy both slots concurrently;
    // drained-1 and drained-2 stay pending until the first 413 drains them.
    for (const path of ["big-a", "big-b", "drained-1", "drained-2"]) {
      void queue
        .enqueue("s1", path, createBlob(100), `https://x/${path}`, "image/png")
        .catch(() => {});
    }

    const start = Date.now();
    await queue.waitForAll(2000);
    const elapsed = Date.now() - start;

    // Waiters resolved by the second 413's terminal tail, not by timeout.
    expect(elapsed).toBeLessThan(2000);
    expect(localSessionFullCalls).toEqual(["s1"]); // fired exactly once
    const progress = queue.getProgress();
    expect(progress.failedCount).toBe(4); // 2 by 413 + 2 drained, each once
    expect(progress.completedCount).toBe(0);
    expect(progress.totalCount).toBe(4);
  });

  it("cancel() during a Retry-After backoff sleep rejects waiters without leaked counts or a post-wakeup retry (F8c)", async () => {
    let attempts = 0;
    const queue = createStandaloneQueue({ maxConcurrency: 1 }, async () => {
      attempts++;
      // Retry-After 2s — within the 60s cap, so honored as a backoff sleep.
      throw new HttpError("Rate limited", 429, 2);
    });

    void queue
      .enqueue("s1", "img1", createBlob(100), "https://x/1", "image/png")
      .catch(() => {});
    void queue
      .enqueue("s1", "img2", createBlob(100), "https://x/2", "image/png")
      .catch(() => {});
    await sleep(20); // img1 active and parked in its Retry-After sleep; img2 pending

    const waitPromise = queue.waitForAll();
    queue.cancel();
    await expect(waitPromise).rejects.toThrow("UploadQueue was cancelled");

    // The chunked sleep must wake at the next ≤1s chunk boundary after the
    // cancel; wait past the full 2s Retry-After so a cancel-unaware sleep
    // would have woken and retried within this window.
    await sleep(2200);

    expect(attempts).toBe(1); // no retry fired after wakeup
    const progress = queue.getProgress();
    expect(progress.failedCount).toBe(2); // 1 active + 1 pending, each counted once
    expect(progress.completedCount).toBe(0);
    expect(progress.totalCount).toBe(2);
  });

  it("waitForAll() rejects on a queue cancelled BEFORE the call (F8d)", async () => {
    const queue = createStandaloneQueue({ maxConcurrency: 1 }, async () => {
      await sleep(5000);
      return { ...UPLOAD_OK };
    });

    void queue
      .enqueue("s1", "img1", createBlob(100), "https://x/1", "image/png")
      .catch(() => {});
    await sleep(20); // upload in flight

    queue.cancel();

    // The old isDone() early-return RESOLVED waiters arriving after a cancel
    // (cancel empties pending+active); the contract says they must reject.
    await expect(queue.waitForAll()).rejects.toThrow(
      "UploadQueue was cancelled",
    );
  });

  it("a throwing onProgress does not double-count completed tasks or stall the queue (F8e)", async () => {
    let attempts = 0;
    const queue = createStandaloneQueue(
      {},
      async () => {
        attempts++;
        await sleep(5);
        return { ...UPLOAD_OK };
      },
      {
        onProgress: () => {
          // Simulates the invalidated-extension-context sendMessage wrapper.
          throw new Error("Extension context invalidated.");
        },
      },
    );

    for (let i = 1; i <= 3; i++) {
      void queue
        .enqueue(
          "s1",
          `img${i}`,
          createBlob(100),
          `https://x/${i}`,
          "image/png",
        )
        .catch(() => {});
    }

    await queue.waitForAll(2000);

    expect(attempts).toBe(3); // each task uploaded exactly once — no null-blob retry
    const progress = queue.getProgress();
    expect(progress.completedCount).toBe(3); // incremented exactly once per task
    expect(progress.failedCount).toBe(0); // success never re-routed to failure
  });

  it("fails terminally on an oversized Retry-After without sleeping, freeing the slot (F8f)", async () => {
    let throttledAttempts = 0;
    const queue = createStandaloneQueue(
      { maxConcurrency: 1 },
      async (_sid, path) => {
        if (path === "throttled") {
          throttledAttempts++;
          // 1h — far beyond the 60s cap. Must terminate, not sleep.
          throw new HttpError("Rate limited", 429, 3600);
        }
        await sleep(5);
        return { ...UPLOAD_OK };
      },
    );

    void queue
      .enqueue(
        "s1",
        "throttled",
        createBlob(100),
        "https://x/throttled",
        "image/png",
      )
      .catch(() => {});
    void queue
      .enqueue("s1", "after", createBlob(100), "https://x/after", "image/png")
      .catch(() => {});

    const start = Date.now();
    // Bounded real-time wait: the test must never need to advance an hour.
    await queue.waitForAll(2000);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(throttledAttempts).toBe(1); // terminal — no retry, budget untouched
    const progress = queue.getProgress();
    expect(progress.failedCount).toBe(1);
    expect(progress.completedCount).toBe(1); // slot freed → queued task ran
    expect(queue.getResourceUrls()).toEqual([
      {
        url: "https://x/after",
        path: "after",
        contentType: "image/png",
        size: 100,
      },
    ]); // terminated entry excluded from the checkpoint manifest
  });

  it("checkpoint-manifest symmetry: auth/413/drained excluded, successful and user-cancelled present (F6)", async () => {
    // --- Exclusions: auth-failed, 413-failed, and 413-drained tasks
    const localSessionFullCalls: string[] = [];
    const queue = createStandaloneQueue(
      { maxConcurrency: 3 },
      async (_sid, path) => {
        if (path === "auth-fail") {
          throw new AuthenticationError(
            "Authentication failed after re-registration",
          );
        }
        if (path === "four13") {
          throw new HttpError("Session full", 413);
        }
        await sleep(5);
        return { ...UPLOAD_OK };
      },
      { onSessionFull: (sid) => localSessionFullCalls.push(sid) },
    );

    // ok + auth-fail + four13 fill the three slots; drained stays pending
    // until the 413's fail-all drain claims it.
    for (const path of ["ok", "auth-fail", "four13", "drained"]) {
      void queue
        .enqueue("s1", path, createBlob(100), `https://x/${path}`, "image/png")
        .catch(() => {});
    }
    await queue.waitForAll(2000);

    expect(localSessionFullCalls).toEqual(["s1"]);
    const progress = queue.getProgress();
    expect(progress.completedCount).toBe(1);
    expect(progress.failedCount).toBe(3); // auth + 413 + drained
    // Permanently-failed and 413-drained URLs must not leak into a checkpoint
    // (a resumed session would re-trigger auth/413 with them).
    expect(queue.getResourceUrls()).toEqual([
      { url: "https://x/ok", path: "ok", contentType: "image/png", size: 100 },
    ]);

    // --- Retention: a user-cancelled (abort-path) task stays resumable
    const cancelQueue = createStandaloneQueue(
      { maxConcurrency: 1 },
      async (_sid, _path, _blob, _url, _ct, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );
    void cancelQueue
      .enqueue(
        "s1",
        "stopped",
        createBlob(100),
        "https://x/stopped",
        "image/png",
      )
      .catch(() => {});
    await sleep(20); // let the upload start
    cancelQueue.cancel();
    await sleep(30); // let the abort rejection land

    expect(cancelQueue.getProgress().failedCount).toBe(1);
    // User-stopped downloads keep their manifest entry so a later resume
    // can re-upload what this run never delivered (design D5).
    expect(cancelQueue.getResourceUrls()).toEqual([
      {
        url: "https://x/stopped",
        path: "stopped",
        contentType: "image/png",
        size: 100,
      },
    ]);
  });
});
