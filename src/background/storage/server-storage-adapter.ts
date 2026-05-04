/**
 * ServerStorageAdapter — IStorageAdapter implementation that uploads
 * resources to the Python microservice instead of storing locally.
 *
 * Tasks 10.1–10.5 of the server-side-microservice migration.
 *
 * Key behaviors:
 * - addFile() enqueues uploads via UploadQueue (task 10.2)
 * - getFile() returns null — server storage is write-only (task 10.3)
 * - getResourceCount() returns queue count for UI progress (task 10.3a)
 * - getAllFiles() returns empty array — server manages enumeration (task 10.4)
 * - clear() aborts uploads AND deletes session atomically (task 10.5)
 */

import { IStorageAdapter } from "./storage-adapter";
import { ServerClient } from "../server-client";
import { UploadQueue } from "../upload-queue";

// ---------------------------------------------------------------------------
// ServerStorageAdapter
// ---------------------------------------------------------------------------

export class ServerStorageAdapter implements IStorageAdapter {
  private readonly serverClient: ServerClient;
  private readonly uploadQueue: UploadQueue;

  /** Server session ID — set once via setSessionId() after session creation. */
  private sessionId: string | null = null;

  /** Set of paths already enqueued for upload — prevents duplicate uploads
   *  when the same resource path is passed to addFile() multiple times
   *  (e.g. MediaWiki load.php images with different query params that
   *  previously mapped to the same filename). */
  private readonly enqueuedPaths: Set<string> = new Set();

  constructor(serverClient: ServerClient) {
    this.serverClient = serverClient;
    this.uploadQueue = new UploadQueue(serverClient);
  }

  // -----------------------------------------------------------------------
  // Session ID management
  // -----------------------------------------------------------------------

  /**
   * Set the server session ID. Must be called after the session is
   * created on the server (via ServerClient.createSession) before
   * any addFile() calls. The session ID is not known at construction
   * time because session creation is async and may happen after the
   * adapter is instantiated.
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** Get the current server session ID. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  // -----------------------------------------------------------------------
  // IStorageAdapter implementation
  // -----------------------------------------------------------------------

  /**
   * (10.2) Upload a file to the server via UploadQueue.
   *
   * Text-based MIME types are gzip-compressed; binary resources are
   * uploaded uncompressed (D9). The UploadQueue handles concurrency,
   * retry logic, progress tracking, and blob memory release.
   */
  async addFile(
    path: string,
    content: Blob | string | ArrayBuffer,
    mimeType?: string,
    originalUrl?: string,
  ): Promise<void> {
    if (!this.sessionId) {
      throw new Error(
        "ServerStorageAdapter: sessionId not set. Call setSessionId() before addFile().",
      );
    }

    const contentType = mimeType || "application/octet-stream";

    // Dedup: skip if this path was already enqueued. This prevents
    // re-uploading the same resource when multiple URLs map to the
    // same local path (e.g. MediaWiki load.php with different query params).
    if (this.enqueuedPaths.has(path)) {
      console.log(
        `[ServerStorageAdapter] addFile: skipping duplicate path=${path}`,
      );
      return;
    }
    this.enqueuedPaths.add(path);

    // Convert content to Blob for upload
    const blob = this.toBlob(content, contentType);

    // Use the provided originalUrl (the actual web URL) when available,
    // falling back to the local path for backward compatibility.
    const effectiveOriginalUrl = originalUrl || path;

    console.log(
      `[ServerStorageAdapter] addFile: path=${path} size=${blob.size} type=${contentType}`,
    );

    await this.uploadQueue.enqueue(
      this.sessionId,
      path,
      blob,
      effectiveOriginalUrl,
      contentType,
    );
  }

  /**
   * (10.3) Server storage is write-only from the extension's perspective.
   * Returns null because files cannot be retrieved from the server
   * during the download process — the server handles all file
   * assembly internally.
   */
  async getFile(_path: string): Promise<Blob | null> {
    return null;
  }

  /**
   * (10.4) Server manages file enumeration. Returns an empty array
   * because the extension does not need to list files stored on the
   * server — the server handles ZIP assembly with its own file tracking.
   */
  async getAllFiles(): Promise<Array<{ path: string; size: number }>> {
    return [];
  }

  /**
   * (10.5) Cancel all uploads and delete the server session.
   *
   * Both actions MUST occur together (S5 fix):
   * - Abort all pending and in-progress uploads in the UploadQueue
   *   via AbortController.abort()
   * - Send DELETE /api/v1/sessions/{id} to the server
   *
   * Aborting uploads without deleting the session leaves orphaned
   * server data. Deleting the session without aborting uploads causes
   * 404 errors on in-flight requests. The server's stale-session
   * cleanup (30-min timeout) is a backstop but not a substitute.
   */
  async clear(): Promise<void> {
    // (a) Immediately abort all pending and in-progress uploads
    this.uploadQueue.cancel();

    // Clear dedup tracking
    this.enqueuedPaths.clear();

    // (b) Delete the server session to clean up uploaded data
    if (this.sessionId) {
      try {
        await this.serverClient.deleteSession(this.sessionId);
      } catch {
        // Best-effort deletion — the server's stale-session cleanup
        // will handle orphaned sessions. Don't block on failures.
      }
      this.sessionId = null;
    }
  }

  // -----------------------------------------------------------------------
  // Extended API (task 10.3a)
  // -----------------------------------------------------------------------

  /**
   * (10.3a) Get the current count of resources submitted to the
   * UploadQueue (queued + in-progress + completed). Used by the
   * UI for "X/Y resources uploaded" progress display.
   *
   * This method is NOT on IStorageAdapter — local mode continues
   * to use getAllFiles().length for enumeration.
   */
  getResourceCount(): number {
    return this.uploadQueue.getResourceCount();
  }

  // -----------------------------------------------------------------------
  // UploadQueue delegation
  // -----------------------------------------------------------------------

  /** Get the underlying UploadQueue for progress tracking and cancellation. */
  getUploadQueue(): UploadQueue {
    return this.uploadQueue;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Convert various content types to Blob for upload.
   * Mirrors FileStore.toBlob() in file-store.ts.
   */
  private toBlob(content: Blob | string | ArrayBuffer, mimeType?: string): Blob {
    if (content instanceof Blob) {
      return content;
    }
    if (typeof content === "string") {
      return new Blob([content], { type: mimeType || "text/plain" });
    }
    if (content instanceof ArrayBuffer) {
      return new Blob([content], { type: mimeType || "application/octet-stream" });
    }
    throw new Error("Unsupported content type for ServerStorageAdapter.addFile()");
  }
}
