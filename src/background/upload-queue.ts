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
    this.resourceUrlMap.set(id, { url: originalUrl, path, contentType });

    // Start processing if not already running
    this.scheduleProcessing();

    return id;
  }

  /**
   * (9.4) Cancel all uploads: abort in-progress fetches and cancel
   * pending uploads using AbortController.
   */
  cancel(): void {
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
   */
  private readonly resourceUrlMap: Map<
    string,
    { url: string; path: string; contentType: string }
  > = new Map();

  getResourceUrls(): Array<{ url: string; path: string; contentType: string }> {
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
    if (this.isDone()) return;
    if (this.cancelled) {
      throw new Error("UploadQueue was cancelled");
    }

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
        `[UploadQueue] Uploading: path=${task.path} size=${task.totalBytes} type=${task.contentType}`,
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

      this.notifyProgress();

      // Continue processing if there are pending tasks
      if (this.pending.length > 0) {
        this.scheduleProcessing();
      }
    } catch (err) {
      await this.handleTaskError(task, err);
    }
  }

  /**
   * (9.3) Handle upload errors with proper retry logic.
   *
   * - 5xx / network errors → retry with exponential backoff (max 3 retries)
   * - 429 Rate Limit → retry with Retry-After or exponential backoff
   * - 413 Session Full → fatal, trigger onSessionFull callback
   * - Other 4xx → no retry
   * - AuthenticationError → no retry (ServerClient handles re-registration)
   * - AbortError → no retry (user cancelled)
   */
  private async handleTaskError(task: UploadTask, err: unknown): Promise<void> {
    // Check for abort (user cancellation)
    if (isAbortError(err) || task.abortController.signal.aborted) {
      task.status = "failed";
      task.blob = null; // release memory
      this.failedCount++;
      this.active.delete(task.id);
      this.notifyProgress();
      return;
    }

    // AuthenticationError → no retry (ServerClient already tried re-registration)
    if (err instanceof AuthenticationError) {
      task.status = "failed";
      task.blob = null;
      this.failedCount++;
      this.active.delete(task.id);
      this.notifyProgress();
      return;
    }

    // (9.3) 413 Session Full → stop scraping, fast-fail pending, finalize with partial data.
    if (is413Error(err)) {
      task.status = "failed";
      task.blob = null;
      this.failedCount++;
      this.active.delete(task.id);

      // Only drain pending and fire callback on the first 413 — subsequent
      // 413s from concurrent uploads just mark their own task as failed.
      if (!this.sessionFullDetected) {
        this.sessionFullDetected = true;

        // Fast-fail all remaining pending tasks — they would 413 anyway.
        while (this.pending.length > 0) {
          const pendingTask = this.pending.shift()!;
          pendingTask.status = "failed";
          pendingTask.blob = null;
          this.failedCount++;
        }

        this.notifyProgress();
        this.onSessionFull?.(task.sessionId);
      }
      return;
    }

    // (9.3) 429 Rate Limit → retryable with Retry-After or exponential backoff
    if (is429Error(err)) {
      if (task.retries < MAX_RETRIES) {
        task.retries++;
        const retryAfterMs = getRetryAfterFromError(err);
        const backoffMs = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, task.retries - 1),
          MAX_BACKOFF_MS,
        );
        const delay = retryAfterMs ?? backoffMs;

        await this.sleep(delay);

        // Check if cancelled during sleep
        if (this.cancelled || task.abortController.signal.aborted) {
          task.status = "failed";
          task.blob = null;
          this.failedCount++;
          this.active.delete(task.id);
          this.notifyProgress();
          return;
        }

        // Retry the upload
        this.executeTask(task).catch(() => {});
        return;
      }
      // Exhausted retries for 429
      task.status = "failed";
      task.blob = null;
      this.failedCount++;
      this.active.delete(task.id);
      this.notifyProgress();
      return;
    }

    // (9.3) 5xx / ServerUnavailableError / network errors → retryable
    if (isRetryableError(err)) {
      if (task.retries < MAX_RETRIES) {
        task.retries++;
        const delay = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, task.retries - 1),
          MAX_BACKOFF_MS,
        );

        await this.sleep(delay);

        // Check if cancelled during sleep
        if (this.cancelled || task.abortController.signal.aborted) {
          task.status = "failed";
          task.blob = null;
          this.failedCount++;
          this.active.delete(task.id);
          this.notifyProgress();
          return;
        }

        // Retry the upload
        this.executeTask(task).catch(() => {});
        return;
      }
    }

    // Non-retryable error or exhausted retries
    task.status = "failed";
    task.blob = null; // release memory even on failure
    this.failedCount++;
    this.active.delete(task.id);
    this.resourceUrlMap.delete(task.id); // exclude from checkpoint
    this.notifyProgress();

    console.error(
      `[UploadQueue] Upload failed permanently: path=${task.path} retries=${task.retries} ` +
        `error=${err instanceof Error ? err.message : err}`,
    );

    // Continue processing if there are pending tasks
    if (this.pending.length > 0) {
      this.scheduleProcessing();
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private generateTaskId(): string {
    return `upload-${Date.now()}-${++this.taskIdCounter}`;
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
    this.onProgress?.(this.getProgress());

    // Resolve waitForAll() waiters when the queue empties
    if (this.isDone() && this.doneWaiters.length > 0) {
      const waiters = this.doneWaiters.splice(0);
      for (const { resolve } of waiters) {
        resolve();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Check if the error is retryable (5xx, network error, or ServerUnavailableError).
 * Non-retryable: 4xx client errors (except 429 handled separately).
 *
 * (S2 fix) Removed regex-based HTTP status fallback — all custom error
 * classes carry a `statusCode` property for structured detection.
 */
function isRetryableError(err: unknown): boolean {
  // ServerUnavailableError → retryable (5xx or network-level)
  if (err instanceof ServerUnavailableError) {
    return (
      err.statusCode === undefined || // network-level (no HTTP status)
      err.statusCode >= 500 // 5xx server error
    );
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
