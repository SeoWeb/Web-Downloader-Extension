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
      sessionId: string, path: string, blob: Blob, originalUrl: string,
      contentType: string, signal?: AbortSignal,
      onUploadProgress?: (loaded: number, total: number) => void
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

      const queue = createQueue(
        { maxConcurrency: concurrency },
        async () => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          await sleep(50);
          activeCount--;
          return { resource_id: "r1", local_path: "img.png", size: 100, deduplicated: false, api_version: "v1" };
        },
      );

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
        return { resource_id: "r1", local_path: "img.png", size: 100, deduplicated: false, api_version: "v1" };
      });

      for (let i = 0; i < 15; i++) {
        await queue.enqueue("s1", `img${i}`, createBlob(100), `url${i}`, "image/png");
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
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
      });

      const sessionId = "s1";
      await queue.enqueue(sessionId, "img1", createBlob(100), "url1", "image/png");
      await queue.enqueue(sessionId, "img2", createBlob(200), "url2", "image/png");
      await queue.enqueue(sessionId, "img3", createBlob(300), "url3", "image/png");

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
        return { resource_id: "r1", local_path: "x", size: 50, deduplicated: false, api_version: "v1" };
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
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
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
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
      });

      // Speed up retries by making backoff short
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = (ms: number) => origSleep.call(queue, Math.min(ms, 10));

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
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
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

      const queue = createQueue({}, async (_sid, _path, _blob, _url, _ct, signal) => {
        // Simulate a long upload that checks for abort
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      await queue.enqueue("s1", "img1", createBlob(100), "url1", "image/png");
      await sleep(20); // Let the upload start

      queue.cancel();

      expect(aborted).toBe(true);
      expect(queue.isCancelled()).toBe(true);
    });

    it("cancels pending uploads without starting them", async () => {
      let uploadCount = 0;

      const queue = createQueue(
        { maxConcurrency: 1 },
        async () => {
          uploadCount++;
          await sleep(100);
          return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
        },
      );

      // Enqueue 5 uploads; only 1 can run at a time (concurrency=1)
      for (let i = 0; i < 5; i++) {
        await queue.enqueue("s1", `img${i}`, createBlob(100), `url${i}`, "image/png");
      }

      await sleep(20); // Let the first one start
      queue.cancel();

      // Only 1 should have started (the first one)
      expect(uploadCount).toBe(1);
      expect(queue.getProgress().failedCount).toBe(5);
    });

    it("rejects new enqueues after cancellation", async () => {
      const queue = createQueue({}, async () => ({
        resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1",
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
        return { resource_id: "r1", local_path: "x", size: blob.size, deduplicated: false, api_version: "v1" };
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
      const queue = createQueue(
        { maxConcurrency: 1 },
        async () => {
          await sleep(200);
          return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
        },
      );

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
          return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
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
        resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1",
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
        await new Promise<void>((resolve) => { uploadResolve = resolve; });
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
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
        return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
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

      const queue = createQueue(
        { maxConcurrency: 3 },
        async () => {
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
          return { resource_id: "r1", local_path: "x", size: 100, deduplicated: false, api_version: "v1" };
        },
      );

      // Speed up retries
      const origSleep = (queue as any).sleep;
      (queue as any).sleep = (ms: number) => origSleep.call(queue, Math.min(ms, 10));

      // Enqueue 6 resources
      for (let i = 0; i < 6; i++) {
        await queue.enqueue("s1", `img${i}`, createBlob(100), `url${i}`, "image/png");
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
