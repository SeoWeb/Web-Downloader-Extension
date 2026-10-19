import { IStorageAdapter } from "../storage/server-storage-adapter";
import {
  buildArchivePath,
  resolveResourceUrl,
  toFailureCategory,
} from "../urlUtils";
import type {
  FileHandlerFailureCategory,
  FileHandlerOptions,
} from "../urlUtils";
import { requestQueue } from "../../utils/RequestQueue";
import {
  RequestPriority,
  RequestResult,
  ResourceType,
} from "../../types/queue";
import type { QueuedRequest } from "../../types/queue";

/** Outcome of a queued fetch — either a result or the failure. */
type QueueOutcome =
  | { ok: true; result: RequestResult }
  | { ok: false; error: unknown };

type SendMessage = (message: string | { key: string; options?: any }) => void;

/** Enqueue one fetch and settle to a plain outcome (never throws). */
function enqueueRequest(
  request: Omit<QueuedRequest, "id" | "status" | "queuedAt">,
): Promise<QueueOutcome> {
  return new Promise<QueueOutcome>((resolve) => {
    requestQueue
      .enqueue({
        ...request,
        onComplete: (result) => resolve({ ok: true, result }),
        onError: (error) => resolve({ ok: false, error }),
      })
      .catch((error) => resolve({ ok: false, error }));
  });
}

/**
 * Download JS files for the archive.
 *
 * Relative URLs resolve against the document URL (design D2). Opaque
 * (no-cors) responses are recorded as a categorized `cors` failure — their
 * body is unreadable and must never be read (task 2.4).
 *
 * Returns a filename map (mirroring the image handler): each uploaded
 * script is keyed BOTH by its raw as-authored attribute and by its resolved
 * absolute URL (query string included), with the archive path as the value —
 * uploaded to the server so the archived-HTML converter can resolve script
 * srcs to the exact stored paths.
 */
export async function addJsFiles(
  jss: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: SendMessage,
  downloadId?: string,
  options?: FileHandlerOptions,
): Promise<Map<string, string>> {
  const filenameMap = new Map<string, string>();
  if (!jss?.length) return filenameMap;

  const documentUrl = options?.documentUrl;
  // Legacy fallback base: the site origin (previous behavior).
  const fallbackBase = new URL(tabUrl).origin + "/";

  // Using storage adapter directly
  const count = jss.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;
  const failureCategories: Partial<Record<FileHandlerFailureCategory, number>> =
    {};

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // TODO: Log download tracking
  }

  const tasks = jss.map(async (js) => {
    if (!js) {
      failCount++;
      return;
    }

    // D2: resolve relative references against the document URL.
    const fullJsUrl = resolveResourceUrl(js, documentUrl, fallbackBase);
    if (!fullJsUrl) {
      // data:/blob:/fragment-only references are never fetched.
      skippedCount++;
      return;
    }

    const outcome = await enqueueRequest({
      url: fullJsUrl,
      resourceType: ResourceType.JS,
      priority: RequestPriority.NORMAL, // JS is normal priority
      domain: "", // Will be auto-extracted
      dependencies: [], // No dependencies for JS files
      retryCount: 0,
      estimatedSize: 0, // Unknown size
      fetchOptions: {
        headers: {
          Accept: "application/javascript,text/javascript,*/*;q=0.1",
        },
      },
    });

    completedCount++;
    sendMessage({
      key: "status.jsProgress",
      options: { completed: completedCount, total: count },
    });

    if (!outcome.ok) {
      const category = toFailureCategory(outcome.error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      failCount++;
      return;
    }

    const { result } = outcome;

    // Opaque (no-cors) bodies are unreadable — record a categorized cors
    // failure and continue without ever reading the body (task 2.4).
    if (result.type === "opaque" || result.snapshot.type === "opaque") {
      failureCategories.cors = (failureCategories.cors ?? 0) + 1;
      failCount++;
      sendMessage(`Script CORS-blocked (opaque response): ${js}`);
      return;
    }

    try {
      const snapshotBytes = result.snapshot.bytes;
      const bytes = snapshotBytes
        ? new Uint8Array(snapshotBytes)
        : new Uint8Array();
      const blob = new Blob([bytes]);

      // Collision-free archive path preserving the directory structure.
      // The 4th argument carries the resolved ABSOLUTE source URL (query
      // string included) so the server stores it as resources.original_url
      // — the archived-HTML converter looks scripts up by absolute URL
      // in the session filename map (fix G).
      const archivePath = buildArchivePath(fullJsUrl, "scripts");
      await storage.addFile(
        archivePath,
        blob,
        "application/javascript",
        fullJsUrl,
      );
      // Mirror the image handler's map: raw attribute AND absolute URL.
      filenameMap.set(js, archivePath);
      filenameMap.set(fullJsUrl, archivePath);
      successCount++;
    } catch (error) {
      const category = toFailureCategory(error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      failCount++;
    }
  });

  // Wait for all JS files to be processed
  await Promise.allSettled(tasks);

  if (failCount > 0 || skippedCount > 0) {
    sendMessage({
      key: "status.jsSummary",
      options: {
        succeeded: successCount,
        failed: failCount,
        skipped: skippedCount,
        failureCategories: Object.keys(failureCategories).length
          ? failureCategories
          : undefined,
      },
    });
  }

  return filenameMap;
}
