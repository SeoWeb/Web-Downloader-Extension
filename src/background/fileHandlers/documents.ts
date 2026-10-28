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
 * Fire-and-forget a panel push. The send callback resolves/rejects
 * asynchronously (messageWorker's addMessage → sendMessageToPanel), so when
 * the side panel is closed every push rejects with "Receiving end does not
 * exist". Catch and log those failures at debug level so a failed push never
 * becomes an unhandled rejection in the service worker and never affects the
 * download pipeline. A successful push behaves exactly as the bare call did.
 */
function pushToPanelSafely(
  sendMessage: SendMessage,
  message: string | { key: string; options?: any },
): void {
  try {
    Promise.resolve(sendMessage(message)).catch((err) => {
      console.debug(
        "[fileHandlers:documents] panel push failed (ignored):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.debug(
      "[fileHandlers:documents] panel push failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Determine the document MIME type from the filename extension. */
function docContentTypeFromExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const docContentTypes: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    rtf: "application/rtf",
    csv: "text/csv",
  };
  return docContentTypes[ext] || "application/octet-stream";
}

/**
 * Download document files (PDF, Office, archives, ...).
 *
 * Relative URLs resolve against the document URL (design D2). Uploaded
 * paths preserve the URL's directory structure (design D5).
 *
 * Returns a filename map (mirroring the image handler): each uploaded
 * document is keyed BOTH by its raw as-authored attribute and by its
 * resolved absolute URL (query string included), with the archive path as
 * the value — uploaded to the server so archived-HTML document links can
 * resolve to the exact stored paths.
 */
export async function addDocumentFiles(
  documents: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: SendMessage,
  downloadId?: string,
  options?: FileHandlerOptions,
): Promise<Map<string, string>> {
  const filenameMap = new Map<string, string>();
  if (!documents?.length) {
    return filenameMap;
  }

  const documentUrl = options?.documentUrl;
  // Legacy fallback base: the containing page URL (previous behavior).
  const fallbackBase = tabUrl;

  // Using storage adapter directly
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;
  const count = documents.length;
  const failureCategories: Partial<Record<FileHandlerFailureCategory, number>> =
    {};

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // TODO: Log download tracking
  }

  const tasks = documents.map(async (document) => {
    if (!document) {
      failCount++;
      return;
    }

    // D2: resolve relative references against the document URL.
    const fullDocumentUrl = resolveResourceUrl(
      document,
      documentUrl,
      fallbackBase,
    );
    if (!fullDocumentUrl) {
      // data:/blob:/fragment-only references are never fetched.
      skippedCount++;
      return;
    }

    const outcome = await enqueueRequest({
      url: fullDocumentUrl,
      resourceType: ResourceType.DOCUMENT,
      priority: RequestPriority.NORMAL, // Documents are normal priority
      domain: "", // Will be auto-extracted
      dependencies: [], // No dependencies for documents
      retryCount: 0,
      estimatedSize: 0, // Unknown size
      fetchOptions: {
        headers: {
          Accept:
            "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.5",
        },
      },
    });

    completedCount++;
    pushToPanelSafely(sendMessage, {
      key: "status.documentsProgress",
      options: { completed: completedCount, total: count },
    });

    if (!outcome.ok) {
      const category = toFailureCategory(outcome.error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      failCount++;
      return;
    }

    const { result } = outcome;

    // Opaque bodies are unreadable — never attempt to read one. (The queue
    // only falls back to no-cors for images, but cached results could too.)
    if (result.type === "opaque" || result.snapshot.type === "opaque") {
      failureCategories.cors = (failureCategories.cors ?? 0) + 1;
      failCount++;
      pushToPanelSafely(
        sendMessage,
        `Document CORS-blocked (opaque response): ${document}`,
      );
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
      // — archived-HTML document links are looked up by absolute URL in
      // the session filename map (fix G).
      const archivePath = buildArchivePath(fullDocumentUrl, "documents");
      const docContentType = docContentTypeFromExtension(archivePath);

      await storage.addFile(archivePath, blob, docContentType, fullDocumentUrl);
      // Mirror the image handler's map: raw attribute AND absolute URL.
      filenameMap.set(document, archivePath);
      filenameMap.set(fullDocumentUrl, archivePath);
      successCount++;
    } catch (error) {
      const category = toFailureCategory(error);
      failureCategories[category] = (failureCategories[category] ?? 0) + 1;
      failCount++;
    }
  });

  // Wait for all document files to be processed
  await Promise.allSettled(tasks);

  if (failCount > 0 || skippedCount > 0) {
    pushToPanelSafely(sendMessage, {
      key: "status.documentsSummary",
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

  // Feed the shared failure tally (reported as `resourcesFailed` on
  // scrape-complete).
  if (options?.failureTally) {
    options.failureTally.documents =
      (options.failureTally.documents ?? 0) + failCount;
  }

  return filenameMap;
}
