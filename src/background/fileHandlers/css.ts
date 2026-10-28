import { IStorageAdapter } from "../storage/server-storage-adapter";
import {
  buildArchivePath,
  decodeTextWithCharset,
  extractCssImports,
  extractCssUrls,
  FileHandlerError,
  isFetchableResourceUrl,
  resolveResourceUrl,
  toFailureCategory,
} from "../urlUtils";
import type {
  FileHandlerFailureCategory,
  FileHandlerOptions,
} from "../urlUtils";
import { DEFAULT_MEMORY_LIMITS } from "../../utils/memoryLimits";
import { requestQueue } from "../../utils/RequestQueue";
import {
  RequestPriority,
  RequestResult,
  ResourceType,
} from "../../types/queue";
import type { QueuedRequest } from "../../types/queue";

/** Maximum @import recursion depth (page-level CSS counts as depth 0). */
export const CSS_IMPORT_DEPTH_LIMIT = 3;

/** Outcome of a queued fetch — either a result or the failure. */
type QueueOutcome =
  | { ok: true; result: RequestResult }
  | { ok: false; error: unknown };

type SendMessage = (message: string | { key: string; options?: any }) => void;

/** One schedulable stylesheet: resolved absolute URL + as-authored reference. */
interface CssItem {
  url: string;
  depth: number;
  /** Raw as-authored reference (attribute value or @import target). */
  raw: string;
}

/** Per-download accounting shared by top-level stylesheets and imports. */
interface CssDownloadState {
  storage: IStorageAdapter;
  sendMessage: SendMessage;
  /** Failure counters by category (cors, network, timeout, http, ...). */
  failureCategories: Partial<Record<FileHandlerFailureCategory, number>>;
  /** Resolved absolute CSS URLs already processed — dedups per download. */
  visited: Set<string>;
  /** Uploaded stylesheets: raw reference AND absolute URL → archive path. */
  filenameMap: Map<string, string>;
  /** Number of page-level stylesheets (drives progress totals). */
  totalCount: number;
  /** Top-level stats (drive progress + summary). */
  successCount: number;
  failCount: number;
  skippedCount: number;
  completedCount: number;
  /** Stats for @import-discovered stylesheets. */
  importsSucceeded: number;
  importsFailed: number;
  /** Schedule a stylesheet for processing (tracked by the drain loop). */
  spawn: (item: CssItem) => void;
}

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

/** Record a failure in the per-download category breakdown. */
function recordFailure(
  state: CssDownloadState,
  error: unknown,
): FileHandlerFailureCategory {
  const category = toFailureCategory(error);
  state.failureCategories[category] =
    (state.failureCategories[category] ?? 0) + 1;
  return category;
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
        "[fileHandlers:css] panel push failed (ignored):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    console.debug(
      "[fileHandlers:css] panel push failed (ignored):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Download CSS files (and their @import chain) so the server can rewrite
 * url() references during finalization.
 *
 * Relative URLs resolve against the document URL (design D2). Text is
 * decoded with the declared charset (design D6). Opaque (no-cors) responses
 * are recorded as a categorized `cors` failure — their body is unreadable.
 *
 * Returns a filename map (mirroring the image handler): each uploaded
 * stylesheet is keyed BOTH by its raw as-authored reference and by its
 * resolved absolute URL (query string included), with the archive path as
 * the value — this is uploaded to the server so the archived-HTML converter
 * can resolve stylesheet hrefs to the exact stored paths.
 */
export async function addCssFiles(
  csss: string[],
  storage: IStorageAdapter,
  tabUrl: string,
  sendMessage: SendMessage,
  downloadId?: string,
  options?: FileHandlerOptions,
): Promise<Map<string, string>> {
  const filenameMap = new Map<string, string>();
  if (!csss?.length) return filenameMap;

  const documentUrl = options?.documentUrl;
  // Legacy fallback base: the site origin (previous behavior).
  const fallbackBase = new URL(tabUrl).origin + "/";

  const state: CssDownloadState = {
    storage,
    sendMessage,
    failureCategories: {},
    visited: new Set<string>(),
    filenameMap,
    totalCount: 0,
    successCount: 0,
    failCount: 0,
    skippedCount: 0,
    completedCount: 0,
    importsSucceeded: 0,
    importsFailed: 0,
    spawn: () => {},
  };

  // Log download tracking if downloadId is provided
  if (downloadId) {
    // TODO: Log download tracking
  }

  /** In-flight processing tasks — grows as @imports are discovered. */
  const inflight = new Set<Promise<void>>();

  state.spawn = (item) => {
    const task = processCssItem(item, state)
      .catch(() => {
        // Defensive: an unexpected rejection must never leave the drain
        // loop waiting forever.
        state.failCount++;
      })
      .then(() => {
        inflight.delete(task);
      });
    inflight.add(task);
  };

  // Seed the drain loop with the page-level stylesheets.
  for (const css of csss) {
    if (!css) {
      state.failCount++;
      continue;
    }
    const resolved = resolveResourceUrl(css, documentUrl, fallbackBase);
    if (!resolved) {
      // data:/blob:/fragment-only references are never fetched.
      state.skippedCount++;
      continue;
    }
    if (state.visited.has(resolved)) {
      state.skippedCount++;
      continue;
    }
    state.visited.add(resolved);
    state.totalCount++;
    state.spawn({ url: resolved, depth: 0, raw: css });
  }

  // Drain: keep waiting while any stylesheet (or newly discovered import)
  // is still being processed.
  while (inflight.size > 0) {
    await Promise.race(inflight);
  }

  const failureCategories = state.failureCategories;
  const hasFailures =
    state.failCount > 0 ||
    state.skippedCount > 0 ||
    state.importsFailed > 0 ||
    Object.keys(failureCategories).length > 0;

  if (hasFailures) {
    pushToPanelSafely(sendMessage, {
      key: "status.cssSummary",
      options: {
        succeeded: state.successCount,
        failed: state.failCount,
        skipped: state.skippedCount,
        importsSucceeded: state.importsSucceeded || undefined,
        importsFailed: state.importsFailed || undefined,
        failureCategories: Object.keys(failureCategories).length
          ? failureCategories
          : undefined,
      },
    });
  }

  // Feed the shared failure tally (reported as `resourcesFailed` on
  // scrape-complete). Only top-level failures count here; nested @import
  // failures are tracked separately in `importsFailed`.
  if (options?.failureTally) {
    options.failureTally.css =
      (options.failureTally.css ?? 0) + state.failCount;
  }

  return filenameMap;
}

/**
 * Fetch, decode, upload one stylesheet and follow its @import rules.
 * Resolves after its own work; discovered imports are spawned into the
 * drain loop (entered into `inflight` before this task settles).
 */
async function processCssItem(
  item: CssItem,
  state: CssDownloadState,
): Promise<void> {
  const { url: fullCssUrl, depth, raw } = item;
  const isTopLevel = depth === 0;

  const outcome = await enqueueRequest({
    url: fullCssUrl,
    resourceType: ResourceType.CSS,
    priority: RequestPriority.HIGH, // CSS is high priority for rendering
    domain: "", // Will be auto-extracted
    dependencies: [], // No dependencies for CSS files
    retryCount: 0,
    estimatedSize: 0, // Unknown size
    fetchOptions: {
      headers: {
        Accept: "text/css,*/*;q=0.1",
        "Cache-Control": "max-age=0",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      retries: 5, // Increase retries for CSS files
      timeout: 45000, // Increase timeout for CSS files
    },
  });

  if (isTopLevel) {
    state.completedCount++;
    pushToPanelSafely(state.sendMessage, {
      key: "status.cssProgress",
      options: { completed: state.completedCount, total: state.totalCount },
    });
  }

  if (!outcome.ok) {
    recordFailure(state, outcome.error);
    if (isTopLevel) state.failCount++;
    else state.importsFailed++;
    return;
  }

  const { result } = outcome;

  // Opaque (no-cors) responses have an unreadable body — record a
  // categorized cors failure instead of attempting to read text (task 2.4).
  if (result.type === "opaque" || result.snapshot.type === "opaque") {
    recordFailure(
      state,
      new FileHandlerError(
        `Opaque (no-cors) response for stylesheet — body unreadable: ${fullCssUrl}`,
        "cors",
      ),
    );
    if (isTopLevel) state.failCount++;
    else state.importsFailed++;
    return;
  }

  try {
    // Decode with the declared charset (Content-Type, then @charset, then
    // UTF-8) — never via response.text(), which assumes UTF-8 (design D6).
    const cssContent = decodeTextWithCharset(
      result.snapshot.bytes,
      result.snapshot.headers["content-type"],
    );

    // Check CSS content size against limits
    if (cssContent.length > DEFAULT_MEMORY_LIMITS.MAX_HTML_CONTENT_SIZE) {
      state.skippedCount++;
      return;
    }

    // Download images and other resources referenced via url(). Relative
    // references resolve against the CSS file's own URL, per the CSS spec.
    // @import statements are stripped first — their url("target") is an
    // import to recurse into (below), not a background image to fetch.
    const cssWithoutImports = cssContent.replace(/@import[^;]*;/gi, "");
    const backgroundImages = extractCssUrls(cssWithoutImports).filter(
      (candidate) =>
        isFetchableResourceUrl(candidate) && !candidate.startsWith("data:"),
    );
    if (backgroundImages.length > 0) {
      await downloadBackgroundImages(
        backgroundImages,
        state.storage,
        fullCssUrl,
        state.sendMessage,
      );
    }

    // Upload the raw CSS at a collision-free archive path (design D5).
    // The 4th argument carries the resolved ABSOLUTE source URL (query
    // string included) so the server stores it as resources.original_url —
    // the archived-HTML converter resolves stylesheet hrefs to absolute
    // URLs and looks them up in the session filename map (fix G).
    const archivePath = buildArchivePath(fullCssUrl, "styles");
    const cssBlob = new Blob([cssContent], { type: "text/css" });
    await state.storage.addFile(archivePath, cssBlob, "text/css", fullCssUrl);

    // Mirror the image handler's map: keyed by the raw as-authored
    // reference AND the resolved absolute URL → archive path.
    state.filenameMap.set(raw, archivePath);
    state.filenameMap.set(fullCssUrl, archivePath);

    if (isTopLevel) state.successCount++;
    else state.importsSucceeded++;

    // Follow @import rules (url and string forms) up to the depth cap.
    if (depth < CSS_IMPORT_DEPTH_LIMIT) {
      for (const importTarget of extractCssImports(cssContent)) {
        // @import resolves against the importing stylesheet's URL.
        const resolvedImport = resolveResourceUrl(importTarget, fullCssUrl);
        if (!resolvedImport || state.visited.has(resolvedImport)) continue;
        state.visited.add(resolvedImport);
        state.spawn({
          url: resolvedImport,
          depth: depth + 1,
          raw: importTarget,
        });
      }
    }
  } catch (error) {
    recordFailure(state, error);
    if (isTopLevel) state.failCount++;
    else state.importsFailed++;
  }
}

/**
 * Download images referenced by CSS url() rules (background images, fonts,
 * cursors). Opaque responses are skipped with a categorized cors failure.
 */
async function downloadBackgroundImages(
  imageUrls: string[],
  storage: IStorageAdapter,
  baseUrl: string,
  sendMessage: SendMessage,
): Promise<void> {
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  let completedCount = 0;

  const tasks = imageUrls.map(async (imageUrl) => {
    const fullImageUrl = resolveResourceUrl(imageUrl, baseUrl);
    if (!fullImageUrl) {
      skippedCount++;
      return;
    }

    const outcome = await enqueueRequest({
      url: fullImageUrl,
      resourceType: ResourceType.IMAGE,
      priority: RequestPriority.LOW, // Background images are low priority
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
    pushToPanelSafely(sendMessage, {
      key: "status.bgImagesProgress",
      options: { completed: completedCount, total: imageUrls.length },
    });

    if (!outcome.ok) {
      failCount++;
      pushToPanelSafely(
        sendMessage,
        `Background image failed (${toFailureCategory(outcome.error)}): ${imageUrl}`,
      );
      return;
    }

    const { result } = outcome;

    // Opaque (no-cors) bodies are unreadable — skip with a cors failure.
    if (result.type === "opaque" || result.snapshot.type === "opaque") {
      failCount++;
      pushToPanelSafely(
        sendMessage,
        `Background image CORS-blocked (opaque response): ${imageUrl}`,
      );
      return;
    }

    try {
      const snapshotBytes = result.snapshot.bytes;
      const bytes = snapshotBytes
        ? new Uint8Array(snapshotBytes)
        : new Uint8Array();
      const blob = new Blob([bytes]);

      // The absolute source URL rides along as originalUrl so the server's
      // storage-path seed can resolve CSS url() references to these files.
      await storage.addFile(
        buildArchivePath(fullImageUrl, "images"),
        blob,
        undefined,
        fullImageUrl,
      );
      successCount++;
    } catch {
      failCount++;
    }
  });

  await Promise.allSettled(tasks);

  if (failCount > 0 || skippedCount > 0) {
    pushToPanelSafely(sendMessage, {
      key: "status.bgImagesSummary",
      options: {
        succeeded: successCount,
        failed: failCount,
        skipped: skippedCount,
      },
    });
  }
}
