/**
 * UploadQueue — manages concurrent resource uploads to the server microservice.
 *
 * Tasks 9.1–9.5 of the server-side-microservice migration.
 *
 * Key features:
 * - Max 12 concurrent uploads (task 9.1, optimized from 5)
 * - Per-task and aggregate upload progress tracking (task 9.2)
 * - Retry logic with 429/413 handling (task 9.3)
 * - Queue cancellation via AbortController (task 9.4)
 * - Aggressive blob memory release (task 9.5)
 */

import {
  ServerClient,
  ServerUnavailableError,
  AuthenticationError,
  HttpError,
} from "./server-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UploadTask {
  /** Unique task identifier. */
  id: string;
  /** Server session ID this upload belongs to. */
  sessionId: string;
  /** Local path for the resource (e.g. "images/photo.jpg"). */
  path: string;
  /**
   * Blob data to upload; nullified after successful upload (task 9.5)
   * or final failure to release memory.
   */
  blob: Blob | null;
  /** Original URL of the resource. */
  originalUrl: string;
  /** MIME type of the resource. */
  contentType: string;
  /** Total size of the original blob in bytes. */
  totalBytes: number;
  /** Bytes sent so far (0 until complete, then equals totalBytes). */
  bytesSent: number;
  /** Current status of the task. */
  status: "pending" | "uploading" | "completed" | "failed";
  /** AbortController for cancelling this specific upload. */
  abortController: AbortController;
  /** Number of retry attempts made so far. */
  retries: number;
}

export interface QueueProgress {
  /** Number of completed uploads. */
  completedCount: number;
  /** Number of failed uploads. */
  failedCount: number;
  /** Total number of enqueued uploads (including completed and failed). */
  totalCount: number;
  /** Total bytes uploaded across all completed tasks. */
  bytesUploaded: number;
  /** Total bytes across all tasks. */
  totalBytes: number;
}

export type ProgressCallback = (progress: QueueProgress) => void;
export type SessionFullCallback = (sessionId: string) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 12;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s
const MAX_BACKOFF_MS = 8000;
/**
 * (D2) Upper bound on a server-requested `Retry-After` wait we are willing
 * to honor. Values within the cap are slept out; values beyond it fail the
 * task terminally instead of parking a concurrency slot for minutes/hours
 * (resume re-fetches the URL later — see design D5).
 */
const MAX_RETRY_AFTER_MS = 60_000;
/** (D2) Max duration of a single `setTimeout` slice in `sleep()` — long
 *  waits are chunked so cancellation stays responsive and an MV3 worker
 *  reap cannot silently drop one far-future timer. */
const MAX_SLEEP_CHUNK_MS = 1000;

// ---------------------------------------------------------------------------
// UploadQueue
// ---------------------------------------------------------------------------

export class UploadQueue {
  private readonly serverClient: ServerClient;
  private readonly maxConcurrency: number;

  /** Pending uploads waiting to be started. */
  private readonly pending: UploadTask[] = [];

  /** Currently in-progress uploads keyed by task ID. */
  private readonly active: Map<string, UploadTask> = new Map();

  /** Number of completed uploads. */
  private completedCount = 0;

  /** Number of failed uploads. */
  private failedCount = 0;

  /** Running total of bytes uploaded (completed tasks only). */
  private bytesUploaded = 0;

  /** Running total of bytes for all tasks. */
  private totalBytes = 0;

  /**
   * Parent AbortController — aborting cancels all in-progress and
   * pending uploads. A new controller is created after cancellation
   * so the queue can be reused if needed.
   */
  private parentAbortController: AbortController;

  /** Whether the queue has been cancelled. */
  private cancelled = false;

  /** Whether a 413 session-full error has been detected. Once true,
   *  subsequent pending uploads are fast-failed without hitting the server. */
  private sessionFullDetected = false;

  /** Task ID counter. */
  private taskIdCounter = 0;

  /** Whether the processing loop is currently scheduled/running. */
  private processing = false;

  /** Resolvers for waitForAll() promises, resolved when queue empties. */
  private doneWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  // -----------------------------------------------------------------------
  // Callbacks
  // -----------------------------------------------------------------------

  /** Called with updated progress after each task state change. */
  onProgress?: ProgressCallback;

  /**
   * Called when a 413 Session Full error is received.
   * Should trigger the server-failure handling path (task 12.9).
   */
  onSessionFull?: SessionFullCallback;

  constructor(
    serverClient: ServerClient,
    options?: {
      maxConcurrency?: number;
      onProgress?: ProgressCallback;
      onSessionFull?: SessionFullCallback;
    },
  ) {
    this.serverClient = serverClient;
    this.maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.onProgress = options?.onProgress;
    this.onSessionFull = options?.onSessionFull;
    this.parentAbortController = new AbortController();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * (9.1) Enqueue a resource upload.
   * Returns a unique task ID.
   */
  async enqueue(
    sessionId: string,
    path: string,
    blob: Blob,
    originalUrl: string,
    contentType: string,
  ): Promise<string> {
    if (this.cancelled) {
      throw new Error("UploadQueue has been cancelled");
    }

    if (this.sessionFullDetected) {
      throw new Error("Session size limit reached");
    }

    const id = this.generateTaskId();
    const task: UploadTask = {
      id,
      sessionId,
      path,
      blob,
      originalUrl,
      contentType,
      totalBytes: blob.size,
      bytesSent: 0,
      status: "pending",
      abortController: this.createChildAbortController(),
      retries: 0,
    };

    this.pending.push(task);
    this.totalBytes += blob.size;
    this.resourceUrlMap.set(id, {
      url: originalUrl,
      path,
      contentType,
      size: blob.size,
    });

    // Start processing if not already running
    this.scheduleProcessing();

    return id;
  }

  /**
   * (9.4) Cancel all uploads: abort in-progress fetches and cancel
   * pending uploads using AbortController.
   */
  cancel(): void {
    // Idempotent — a second cancel() has nothing left to abort and must not
    // emit a duplicate summary log (design D4.2: one log per terminal class).
    if (this.cancelled) return;

    const activeCount = this.active.size;
    const pendingCount = this.pending.length;
    this.cancelled = true;

    // Abort all in-progress uploads
    for (const task of this.active.values()) {
      task.abortController.abort();
      task.status = "failed";
      task.blob = null; // release memory
    }
    this.failedCount += this.active.size;
    this.active.clear();

    // Cancel all pending uploads
    for (const task of this.pending) {
      task.blob = null; // release memory
      task.status = "failed";
    }
    this.failedCount += this.pending.length;
    this.pending.length = 0;

    // Abort the parent controller (catches any stragglers)
    this.parentAbortController.abort();
    this.parentAbortController = new AbortController();

    // Reject any waitForAll() waiters
    const cancelError = new Error("UploadQueue was cancelled");
    for (const { reject } of this.doneWaiters) {
      reject(cancelError);
    }
    this.doneWaiters.length = 0;

    // (D6) Terminal-failure log — the queue-wide cancel is a terminal outcome
    // for every active+pending task; summarize once instead of logging each.
    // (D6.2) Only when something was actually aborted: cancelling an
    // already-drained queue (e.g. the caller's safety-net cancel after a
    // clean finish) stays silent.
    if (activeCount + pendingCount > 0) {
      console.warn(
        `[UploadQueue] Queue cancelled: ${activeCount} active + ${pendingCount} pending uploads aborted` +
          ` (${this.completedCount} had completed successfully)`,
      );
    }

    this.notifyProgress();
  }

  /**
   * Get the total number of resources submitted to the queue
   * (pending + in-progress + completed).
   * Used by ServerStorageAdapter.getResourceCount() (task 10.3a).
   */
  getResourceCount(): number {
    return this.pending.length + this.active.size + this.completedCount;
  }

  /**
   * Get all resource URL entries for completed or in-progress tasks,
   * excluding permanently failed tasks. Used for checkpoint persistence so
   * resume can re-upload resources that the server may not have received
   * (the server deduplicates by URL hash, so re-uploading is harmless).
   * Each entry carries the task's byte size — metadata only, blobs are
   * never persisted (design D4.4).
   */
  private readonly resourceUrlMap: Map<
    string,
    { url: string; path: string; contentType: string; size: number }
  > = new Map();

  getResourceUrls(): Array<{
    url: string;
    path: string;
    contentType: string;
    size: number;
  }> {
    return Array.from(this.resourceUrlMap.values());
  }

  /**
   * (9.2) Get current aggregate upload progress.
   */
  getProgress(): QueueProgress {
    return {
      completedCount: this.completedCount,
      failedCount: this.failedCount,
      totalCount:
        this.completedCount +
        this.failedCount +
        this.pending.length +
        this.active.size,
      bytesUploaded: this.bytesUploaded,
      totalBytes: this.totalBytes,
    };
  }

  /** Check if the queue has been cancelled. */
  isCancelled(): boolean {
    return this.cancelled;
  }

  /** Check if a 413 session-full error has been detected.
   *  When true, the caller should stop scraping and proceed to finalize. */
  isSessionFull(): boolean {
    return this.sessionFullDetected;
  }

  /** Check if all enqueued tasks have completed (or failed).
   *  Also returns true when the queue is empty (0 tasks) — there's
   *  nothing to wait for. */
  isDone(): boolean {
    return this.pending.length === 0 && this.active.size === 0;
  }

  /**
   * Wait for all currently enqueued tasks to complete.
   * Resolves when the queue is empty and all tasks are finished.
   * Rejects if the queue is cancelled, or if timeoutMs elapses.
   */
  async waitForAll(timeoutMs?: number): Promise<void> {
    // (D3) Cancelled check MUST run first: cancel() empties pending + active,
    // so a waiter arriving after a cancel would otherwise resolve "successfully"
    // via the isDone() early-return instead of rejecting per this method's
    // documented contract. Already-registered waiters are rejected by
    // cancel() itself (see below) — together both registration orders reject.
    if (this.cancelled) {
      throw new Error("UploadQueue was cancelled");
    }
    if (this.isDone()) return;

    return new Promise<void>((resolve, reject) => {
      const waiter: { resolve: () => void; reject: (err: Error) => void } = {
        resolve,
        reject,
      };
      this.doneWaiters.push(waiter);

      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {
          const idx = this.doneWaiters.indexOf(waiter);
          if (idx >= 0) this.doneWaiters.splice(idx, 1);
          const p = this.getProgress();
          reject(
            new Error(
              `UploadQueue.waitForAll timed out after ${timeoutMs / 1000}s. ` +
                `Completed: ${p.completedCount}/${p.totalCount}`,
            ),
          );
        }, timeoutMs);

        const originalResolve = waiter.resolve;
        waiter.resolve = () => {
          clearTimeout(timer);
          originalResolve();
        };
      }
    });
  }

  // -----------------------------------------------------------------------
  // Processing loop
  // -----------------------------------------------------------------------

  private scheduleProcessing(): void {
    if (this.processing) return;
    this.processing = true;
    // Use microtask to allow multiple enqueues to batch before processing
    Promise.resolve().then(() => this.processQueue());
  }

  private async processQueue(): Promise<void> {
    while (
      !this.cancelled &&
      this.pending.length > 0 &&
      this.active.size < this.maxConcurrency
    ) {
      const task = this.pending.shift()!;
      this.active.set(task.id, task);
      task.status = "uploading";

      // Start the upload without awaiting (concurrent)
      this.executeTask(task).catch(() => {
        // Errors are handled inside executeTask
      });
    }

    this.processing = false;

    // If there are still pending tasks and capacity, schedule more processing
    if (
      !this.cancelled &&
      this.pending.length > 0 &&
      this.active.size < this.maxConcurrency
    ) {
      this.scheduleProcessing();
    }
  }

  // -----------------------------------------------------------------------
  // Task execution with retry logic (9.3)
  // -----------------------------------------------------------------------

  private async executeTask(task: UploadTask): Promise<void> {
    try {
      // Ensure we have a blob reference
      if (!task.blob) {
        throw new Error(`Upload task ${task.id}: blob reference is null`);
      }

      console.log(
        `[UploadQueue] Uploading: session=${task.sessionId} path=${task.path} size=${task.totalBytes} type=${task.contentType}`,
      );

      // (W1) Real-time progress callback: update task.bytesSent as XHR
      // reports upload progress, and notify listeners.
      // NOTE: XMLHttpRequest is NOT available in Chrome MV3 service workers,
      // so ServerClient.uploadResource() internally decides whether to use
      // XHR (when available, for real-time progress) or fetch() (service
      // worker fallback, no progress events). The callback is always passed
      // so that when XHR is available, progress events flow through.
      const onUploadProgress = (loaded: number, _total: number): void => {
        task.bytesSent = loaded;
        this.notifyProgress();
      };

      // Delegate to ServerClient for the actual upload.
      // ServerClient handles gzip compression, auth, and 401 re-registration.
      // When onUploadProgress is provided, ServerClient uses XHR internally
      // for real-time progress tracking.
      await this.serverClient.uploadResource(
        task.sessionId,
        task.path,
        task.blob,
        task.originalUrl,
        task.contentType,
        task.abortController.signal,
        onUploadProgress,
      );

      // (9.5 / S1) Aggressive blob memory release: nullify immediately after
      // successful upload so the browser's GC can reclaim the memory.
      // NOTE: We cannot nullify before awaiting the upload because retries
      // re-enter executeTask and need the blob reference. The blob must
      // remain alive until the upload succeeds or fails permanently.
      task.blob = null;
      task.bytesSent = task.totalBytes;
      task.status = "completed";
      this.completedCount++;
      this.bytesUploaded += task.totalBytes;
      this.active.delete(task.id);

      // (D1) All state mutation completes BEFORE the notification so the
      // progress snapshot the callback sees is already consistent (D4).
      this.settleActiveTask();
    } catch (err) {
      await this.handleTaskError(task, err);
    }
  }

  /**
   * (9.3) Handle upload errors with proper retry logic.
   *
   * - 5xx / network errors → retry with exponential backoff (max 3 retries)
   * - 429 Rate Limit → retry with Retry-After or exponential backoff
   *   (Retry-After honored only up to MAX_RETRY_AFTER_MS — beyond the cap
   *   the task fails terminally without consuming retry budget, D2)
   * - 413 Session Full → fatal, trigger onSessionFull callback
   * - Other 4xx → no retry
   * - AuthenticationError → no retry (ServerClient handles re-registration)
   * - AbortError → no retry (user cancelled)
   * - TimeoutError (AbortSignal.timeout) → retryable (design D4.1)
   */
  private async handleTaskError(task: UploadTask, err: unknown): Promise<void> {
    // Check for abort (user cancellation)
    if (isAbortError(err) || task.abortController.signal.aborted) {
      // cancel() already failed and accounted for every active+pending task;
      // a late AbortError rejection from an in-flight upload must not
      // double-count failedCount or duplicate the cancel summary log (D3/D2).
      if (this.wasFailedByQueueCancel(task)) {
        return;
      }
      task.status = "failed";
      task.blob = null; // release memory
      this.failedCount++;
      this.active.delete(task.id);
      // (D5) The abort path intentionally KEEPS its resourceUrlMap entry:
      // a per-task abort is only reachable via queue-wide cancel(), and
      // user-stopped downloads must stay resumable — the checkpoint's URL
      // list is what lets a later resume re-upload what this run never
      // delivered.
      // (D2) Abort is terminal for this task — log it once.
      console.warn(
        `[UploadQueue] Upload aborted (cancelled): path=${task.path} url=${task.originalUrl}`,
      );
      this.settleActiveTask();
      return;
    }

    // AuthenticationError → no retry (ServerClient already tried re-registration)
    if (err instanceof AuthenticationError) {
      task.status = "failed";
      task.blob = null;
      this.failedCount++;
      this.active.delete(task.id);
      this.resourceUrlMap.delete(task.id); // (D5) exclude from checkpoint
      // (D2) Terminal-failure log — auth failures were silent before.
      console.error(
        `[UploadQueue] Authentication failed after re-registration attempts — ` +
          `upload permanently failed: path=${task.path} session=${task.sessionId} ` +
          `error=${err.message}`,
      );
      this.settleActiveTask();
      return;
    }

    // (9.3) 413 Session Full → stop scraping, fast-fail pending, finalize with partial data.
    if (is413Error(err)) {
      task.status = "failed";
      task.blob = null;
      this.failedCount++;
      this.active.delete(task.id);
      // (D5) 413 is terminal — exclude from checkpoint so a resumed session
      // cannot re-trigger 413 with a URL that was already drained.
      this.resourceUrlMap.delete(task.id);

      // Only drain pending and fire callback on the first 413 — subsequent
      // 413s from concurrent uploads just mark their own task as failed.
      if (!this.sessionFullDetected) {
        this.sessionFullDetected = true;

        // Fast-fail all remaining pending tasks — they would 413 anyway.
        let drained = 0;
        while (this.pending.length > 0) {
          const pendingTask = this.pending.shift()!;
          pendingTask.status = "failed";
          pendingTask.blob = null;
          this.failedCount++;
          // (D5) Drained pending tasks will never upload — exclude them from
          // the checkpoint so resume doesn't re-attempt (and re-413) them.
          this.resourceUrlMap.delete(pendingTask.id);
          drained++;
        }

        // (D2) One log for the whole fail-all drain — not per drained task.
        console.warn(
          `[UploadQueue] 413 Session full (session=${task.sessionId}): ` +
            `drained ${drained} pending uploads, finalizing with partial data`,
        );

        this.onSessionFull?.(task.sessionId);
      }

      // (D1) Shared terminal tail — the SECOND concurrent 413 must also
      // notify (resolving doneWaiters) and resume pending processing, not
      // just the first one.
      this.settleActiveTask();
      return;
    }

    // (9.3) 429 Rate Limit → retryable with Retry-After or exponential backoff
    if (is429Error(err)) {
      const retryAfterMs = getRetryAfterFromError(err);

      // (D2) Honor server Retry-After only up to MAX_RETRY_AFTER_MS. Beyond
      // the cap the task fails terminally — same accounting/logging as
      // 429-retries-exhaustion, but WITHOUT consuming retry budget — instead
      // of monopolizing a concurrency slot with a far-future sleep. Resume
      // retries the URL later (it is excluded from the checkpoint, D5),
      // which is exactly what the server is asking for.
      if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
        this.failTaskPermanently(task, err);
        return;
      }

      if (task.retries < MAX_RETRIES) {
        task.retries++;
        const backoffMs = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, task.retries - 1),
          MAX_BACKOFF_MS,
        );
        const delay = retryAfterMs ?? backoffMs;

        await this.sleep(delay);

        // Check if cancelled during sleep — cancel() already accounted for
        // this task while it slept; don't double-count (D3).
        if (this.wasFailedByQueueCancel(task)) {
          return;
        }

        // Retry the upload
        this.executeTask(task).catch(() => {});
        return;
      }
      // Exhausted retries for 429 — terminal (D2).
      this.failTaskPermanently(task, err);
      return;
    }

    // (9.3) 5xx / ServerUnavailableError / network errors / timeout aborts → retryable
    if (isRetryableError(err)) {
      if (task.retries < MAX_RETRIES) {
        task.retries++;
        const delay = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, task.retries - 1),
          MAX_BACKOFF_MS,
        );

        await this.sleep(delay);

        // Check if cancelled during sleep — cancel() already accounted for
        // this task while it slept; don't double-count (D3).
        if (this.wasFailedByQueueCancel(task)) {
          return;
        }

        // Retry the upload
        this.executeTask(task).catch(() => {});
        return;
      }
    }

    // Non-retryable error or exhausted retries — terminal. Accounting,
    // logging, manifest exclusion, and the (D1) exit tail are shared with
    // the 429 terminal paths via failTaskPermanently().
    this.failTaskPermanently(task, err);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private generateTaskId(): string {
    return `upload-${Date.now()}-${++this.taskIdCounter}`;
  }

  /**
   * True when cancel() has already failed and accounted for this task
   * (it was active/pending when the queue-wide cancel cleared the maps).
   * A late rejection or retry-sleep wakeup must not double-count it in
   * failedCount or log it again (design D4.2/D4.3).
   */
  private wasFailedByQueueCancel(task: UploadTask): boolean {
    return this.cancelled && !this.active.has(task.id);
  }

  /**
   * (D1 — terminal-exit tail) The single exit contract for every path that
   * removes a task from `active`: after all cleanup and logging, notify
   * progress (which also resolves waitForAll() waiters once the queue
   * empties) and resume processing so pending uploads always start.
   * Routing success AND every terminal branch of handleTaskError through
   * this tail makes the queue's liveness invariants structural — no exit
   * can strand waiters or leave pending work unscheduled. Safe to call from
   * every branch: scheduleProcessing() is idempotent via the `processing`
   * flag, and after a queue-wide cancel() `pending` is empty (no reschedule).
   */
  private settleActiveTask(): void {
    this.notifyProgress();

    // Continue processing if there are pending tasks
    if (this.pending.length > 0) {
      this.scheduleProcessing();
    }
  }

  /**
   * (D2/D5) Terminal task failure shared by 429-retries-exhausted, over-cap
   * Retry-After, and generic non-retryable/exhausted failures, so all three
   * produce identical accounting (status, blob release, failedCount, active
   * slot, checkpoint-manifest exclusion) and the same one-line error log,
   * then exit through the (D1) settle tail.
   */
  private failTaskPermanently(task: UploadTask, err: unknown): void {
    task.status = "failed";
    task.blob = null; // release memory even on failure
    this.failedCount++;
    this.active.delete(task.id);
    this.resourceUrlMap.delete(task.id); // exclude from checkpoint
    console.error(
      `[UploadQueue] Upload failed permanently: path=${task.path} retries=${task.retries} ` +
        `error=${err instanceof Error ? err.message : err}`,
    );
    this.settleActiveTask();
  }

  /**
   * Create an AbortController that is also aborted when the parent
   * controller is aborted, linking individual task cancellation to
   * the queue-level cancellation.
   */
  private createChildAbortController(): AbortController {
    const child = new AbortController();
    const parent = this.parentAbortController;

    // If parent is already aborted, abort child immediately
    if (parent.signal.aborted) {
      child.abort();
      return child;
    }

    // Listen for parent abort
    const onParentAbort = () => child.abort();
    parent.signal.addEventListener("abort", onParentAbort, { once: true });

    return child;
  }

  private notifyProgress(): void {
    // (D4) A throwing onProgress (e.g. the invalidated-extension-context
    // sendMessage wrapper in download-core) must never kill an upload, push
    // a completed task back through handleTaskError (double-counting it as
    // failed), or skip the reschedule tail — log once and swallow. All task
    // state mutation happens BEFORE this call, so the snapshot is consistent.
    try {
      this.onProgress?.(this.getProgress());
    } catch (err) {
      console.warn(
        `[UploadQueue] onProgress callback threw (ignored): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }

    // Resolve waitForAll() waiters when the queue empties — kept OUTSIDE the
    // try so a throwing callback can never skip waiter resolution.
    if (this.isDone() && this.doneWaiters.length > 0) {
      const waiters = this.doneWaiters.splice(0);
      for (const { resolve } of waiters) {
        resolve();
      }
    }
  }

  /**
   * (D2) Chunked sleep: waits in slices of ≤ MAX_SLEEP_CHUNK_MS, re-checking
   * `this.cancelled` between chunks. Cancellation during backoff is honored
   * promptly, and a long wait (e.g. an honored Retry-After) never depends on
   * a single far-future timer that an MV3 worker reap would silently drop.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = ms;
      const tick = (): void => {
        if (this.cancelled || remaining <= 0) {
          resolve();
          return;
        }
        const slice = Math.min(remaining, MAX_SLEEP_CHUNK_MS);
        remaining -= slice;
        setTimeout(tick, slice);
      };
      tick();
    });
  }
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/** Check if the error is an AbortError (user cancelled). */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  // Some environments throw a generic Error with "aborted" in the message
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

/**
 * Check if the error is a 413 Session Full error.
 * Uses HttpError.statusCode when available, falls back to message parsing.
 */
function is413Error(err: unknown): boolean {
  if (err instanceof HttpError && err.statusCode === 413) {
    return true;
  }
  // Fallback for errors that might not be HttpError instances
  if (err instanceof Error && "statusCode" in err) {
    return (err as unknown as { statusCode: number }).statusCode === 413;
  }
  return false;
}

/**
 * Check if the error is a 429 Rate Limit error.
 * Uses HttpError.statusCode when available, falls back to message parsing.
 */
function is429Error(err: unknown): boolean {
  if (err instanceof HttpError && err.statusCode === 429) {
    return true;
  }
  if (err instanceof Error && "statusCode" in err) {
    return (err as unknown as { statusCode: number }).statusCode === 429;
  }
  return false;
}

/**
 * Get Retry-After delay from a 429 error, in milliseconds.
 * Returns undefined if no valid Retry-After value is available.
 */
function getRetryAfterFromError(err: unknown): number | undefined {
  if (err instanceof HttpError && typeof err.retryAfter === "number") {
    return err.retryAfter * 1000; // Convert seconds to milliseconds
  }
  return undefined;
}

/**
 * Check if the error is retryable (5xx, network error, ServerUnavailableError,
 * or a timeout abort). Non-retryable: 4xx client errors (except 429 handled
 * separately) and user cancellation (AbortError — see isAbortError).
 *
 * (S2 fix) Removed regex-based HTTP status fallback — all custom error
 * classes carry a `statusCode` property for structured detection.
 *
 * (D1 fix) `AbortSignal.timeout()` rejects with a DOMException named
 * "TimeoutError" — a hung upload, NOT a user cancellation. It must be
 * classified retryable so a stalled upload retries with backoff instead of
 * becoming a single-attempt permanent failure. Genuine user cancellation
 * keeps the name "AbortError" and stays terminal.
 */
function isRetryableError(err: unknown): boolean {
  // ServerUnavailableError → retryable (5xx or network-level)
  if (err instanceof ServerUnavailableError) {
    return (
      err.statusCode === undefined || // network-level (no HTTP status)
      err.statusCode >= 500 // 5xx server error
    );
  }

  // (D1) TimeoutError from AbortSignal.timeout() → retryable
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return true;
  }
  // Defensive: some environments surface it as a plain Error with the name set
  if (err instanceof Error && err.name === "TimeoutError") {
    return true;
  }

  // TypeError (network failure) → retryable
  if (err instanceof TypeError) {
    return true;
  }

  // Check for 5xx status code on HttpError or other errors with statusCode
  if (err instanceof Error && "statusCode" in err) {
    const statusCode = (err as unknown as { statusCode: number }).statusCode;
    return typeof statusCode === "number" && statusCode >= 500;
  }

  return false;
}
