import { IStorageAdapter } from "../storage/server-storage-adapter";
import {
  buildArchivePath,
  getExtensionFromMimeType,
  resolveResourceUrl,
  toFailureCategory,
} from "../urlUtils";
import type {
  FileHandlerFailureCategory,
  FileHandlerOptions,
} from "../urlUtils";
import { sniffImageMimeType } from "../sniffImageMime";
import { requestQueue } from "../../utils/RequestQueue";
import { RequestPriority, RequestResult, ResourceType } from "../../types/queue";
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
 * Download image files and return a mapping from original URL to local filename.
 * This map is used by the HTML converter to rewrite image URLs correctly.
 *
 * Relative URLs resolve against the document URL (design D2). Opaque
 * (no-cors) responses are recorded as a categorized `cors` failure — their
 * body is unreadable and must never be read (task 2.4).
 */
export async function addImageFiles(
  images: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: SendMessage,
  downloadId?: string,
  options?: FileHandlerOptions,
): Promise<Map<string, string>> {
  const filenameMap = new Map<string, string>();

  if (!images?.length) return filenameMap;

  const documentUrl = options?.documentUrl;
  // Legacy fallback base: the site origin (previous behavior).
  const fallbackBase = new URL(tabUrl).origin + "/";

  // Using storage adapter directly
  const count = images.length;
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

  const tasks = images.map(async (image) => {
    if (!image) {
      failCount++;
      return;
    }

    // D2: resolve relative references against the document URL.
    const fullImageUrl = resolveResourceUrl(image, documentUrl, fallbackBase);
    if (!fullImageUrl) {
      // data:/blob:/fragment-only references are never fetched.
      successCount++;
      skippedCount++;
      return;
    }

    // Store the original src for the filename map
    const originalSrc = image;

    const outcome = await enqueueRequest({
      url: fullImageUrl,
      resourceType: ResourceType.IMAGE,
      priority: RequestPriority.LOW, // Images are low priority
      domain: "", // Will be auto-extracted
      dependencies: [], // No dependencies for images
      retryCount: 0,
      estimatedSize: 0, // Unknown size
      fetchOptions: {
        headers: {
          Accept: "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
      },
    });

    completedCount++;
    sendMessage({
      key: "status.imagesProgress",
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
    // failure and continue without ever reading the body (task 2.4). The
    // overall download continues and completes.
    if (result.type === "opaque" || result.snapshot.type === "opaque") {
      failureCategories.cors = (failureCategories.cors ?? 0) + 1;
      failCount++;
      sendMessage(`Image CORS-blocked (opaque response): ${image}`);
      return;
    }

    try {
      const snapshotBytes = result.snapshot.bytes;
      const bytes = snapshotBytes ? new Uint8Array(snapshotBytes) : new Uint8Array();
      let contentType = result.snapshot.contentType || "";

      const blob = new Blob([bytes], { type: contentType || undefined });

      // When Content-Type is missing or unhelpful, sniff the blob bytes
      if (
        contentType === "" ||
        contentType === "application/octet-stream"
      ) {
        const sniffed = await sniffImageMimeType(blob);
        if (sniffed) contentType = sniffed;
      }

      // Collision-free archive path preserving the directory structure.
      // The Content-Type refines the extension for extension-less URLs.
      const archivePath = buildArchivePath(fullImageUrl, "images", {
        defaultExtension: getExtensionFromMimeType(contentType) ?? undefined,
      });
      if (!archivePath) {
        failCount++;
        return;
      }

      await storage.addFile(
        archivePath,
        blob,
        contentType || undefined,
        originalSrc,
      );
      // Store both the original src and the full URL mapping to local filename
      filenameMap.set(originalSrc, archivePath);
      filenameMap.set(fullImageUrl, archivePath);
      successCount++;
    } catch (error) {
      const category = toFailureCategory(error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      failCount++;
    }
  });

  // Wait for all image files to be processed
  await Promise.allSettled(tasks);

  // Failures handled inside the task block

  if (failCount > 0 || skippedCount > 0) {
    sendMessage({
      key: "status.imagesSummary",
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
