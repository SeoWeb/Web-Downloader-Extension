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
 */
export async function addDocumentFiles(
  documents: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: SendMessage,
  downloadId?: string,
  options?: FileHandlerOptions,
) {
  if (!documents?.length) {
    return;
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
    sendMessage({
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
      sendMessage(`Document CORS-blocked (opaque response): ${document}`);
      return;
    }

    try {
      const snapshotBytes = result.snapshot.bytes;
      const bytes = snapshotBytes
        ? new Uint8Array(snapshotBytes)
        : new Uint8Array();
      const blob = new Blob([bytes]);

      // Collision-free archive path preserving the directory structure.
      const archivePath = buildArchivePath(fullDocumentUrl, "documents");
      const docContentType = docContentTypeFromExtension(archivePath);

      await storage.addFile(archivePath, blob, docContentType);
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
    sendMessage({
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
}
