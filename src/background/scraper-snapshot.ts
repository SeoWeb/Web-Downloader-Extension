/**
 * Linked-scraper pause snapshot (multipage-download-fixes D2, tasks 4.3–4.5).
 *
 * When a pause takes effect (current page completed, loop blocked at the
 * between-page check), the LinkedPageScraper freezes its scrape state into
 * this snapshot and persists it to `chrome.storage.session`. If the service
 * worker dies while the pause is held, the download is PARKED: the snapshot
 * plus the phase-`paused` checkpoint survive and the reopened panel can
 * Resume (re-spawn the scraper seeded from the snapshot against the same
 * unfinalized server session) or Stop (finalize the partial download).
 *
 * Storage conventions mirror download-checkpoint.ts: one namespaced key per
 * download (keyed by server session id), session-scoped (cleared on browser
 * close), metadata only — never page/asset payloads.
 *
 * Cap: queued URLs are capped at 5,000 entries total (internal + external
 * combined). Beyond the cap the snapshot records `truncated: true` — a Stop
 * from a truncated park still finalizes the partial; a Resume continues with
 * the truncated queue. (Realistic runs stay well under the cap: maxPages is
 * clamped to ≤ 500.)
 */

export const SCRAPER_SNAPSHOT_KEY_PREFIX = "linkedScraperSnapshot";

/** Hard cap on queued URLs persisted in one snapshot (internal + external). */
export const SCRAPER_SNAPSHOT_MAX_QUEUED = 5_000;

export const SCRAPER_SNAPSHOT_VERSION = 1;

/** Serializable form of a queued page job (LinkedPageJob minus status). */
export interface ScraperSnapshotJob {
  url: string;
  depth: number;
  parentUrl: string;
}

export interface LinkedScraperSnapshotOptions {
  maxPages: number;
  delayBetweenPages: number;
  includeExternal: boolean;
  pageTimeout: number;
  downloadImages: boolean;
  downloadAssets: boolean;
  downloadDocuments: boolean;
  extractText: boolean;
}

/**
 * Frozen scrape state at the pause moment. `phase` records which queue the
 * loop was walking when the pause took effect ("internal" | "external");
 * `visitedUrls` is the processed (completed or failed) set used on
 * resume-from-park to avoid re-scraping pages that already finished.
 */
export interface LinkedScraperSnapshot {
  version: number;
  serverSessionId?: string;
  tabId?: number;
  tabUrl?: string;
  phase: "internal" | "external";
  internalQueue: ScraperSnapshotJob[];
  externalQueue: ScraperSnapshotJob[];
  visitedUrls: string[];
  successCount: number;
  failCount: number;
  options: LinkedScraperSnapshotOptions;
  /** Checkpoint phase observed before the pause (restored on resume). */
  previousCheckpointPhase?: string;
  /** True when more than SCRAPER_SNAPSHOT_MAX_QUEUED URLs remained queued —
   *  the persisted queues are capped and a Stop finalizes the partial. */
  truncated?: boolean;
  timestamp: number;
}

function snapshotKey(serverSessionId: string): string {
  return `${SCRAPER_SNAPSHOT_KEY_PREFIX}:${serverSessionId}`;
}

/** True for any scraper-snapshot storage key (namespaced). */
export function isScraperSnapshotKey(key: string): boolean {
  return key.startsWith(`${SCRAPER_SNAPSHOT_KEY_PREFIX}:`);
}

/**
 * Cap the queued URLs at SCRAPER_SNAPSHOT_MAX_QUEUED entries total
 * (internal first — it has scrape priority). Returns the capped queues and
 * the truncation marker.
 */
export function truncateSnapshotQueues(
  internalQueue: ScraperSnapshotJob[],
  externalQueue: ScraperSnapshotJob[],
  cap: number = SCRAPER_SNAPSHOT_MAX_QUEUED,
): {
  internalQueue: ScraperSnapshotJob[];
  externalQueue: ScraperSnapshotJob[];
  truncated: boolean;
} {
  const total = internalQueue.length + externalQueue.length;
  if (total <= cap) {
    return { internalQueue, externalQueue, truncated: false };
  }
  const keptInternal = internalQueue.slice(0, cap);
  const keptExternal = externalQueue.slice(0, cap - keptInternal.length);
  return {
    internalQueue: keptInternal,
    externalQueue: keptExternal,
    truncated: true,
  };
}

/** Persist the snapshot under its per-download namespaced key. */
export async function writeScraperSnapshot(
  snapshot: LinkedScraperSnapshot,
): Promise<void> {
  if (!snapshot.serverSessionId) {
    throw new Error(
      "writeScraperSnapshot requires a serverSessionId (server-mode downloads only)",
    );
  }
  await chrome.storage?.session?.set({
    [snapshotKey(snapshot.serverSessionId)]: snapshot,
  });
  console.log(
    `[ScraperSnapshot] Written: session=${snapshot.serverSessionId} ` +
      `internal=${snapshot.internalQueue.length} external=${snapshot.externalQueue.length} ` +
      `visited=${snapshot.visitedUrls.length}` +
      (snapshot.truncated ? " TRUNCATED (>5,000 queued)" : ""),
  );
}

/**
 * Read the snapshot for a specific download. Returns null when absent OR
 * corrupt (wrong shape/version) — callers fall back cleanly (report and
 * offer Stop) instead of crashing the worker.
 */
export async function readScraperSnapshot(
  serverSessionId: string,
): Promise<LinkedScraperSnapshot | null> {
  const snapshot = await readScraperSnapshotByKey(snapshotKey(serverSessionId));
  return snapshot;
}

/**
 * Enumerate ALL parked snapshots currently in session storage, newest-first.
 * (Startup detection and session-less lookups need this when only a tab id
 * or nothing at all is known.)
 */
export async function readAllScraperSnapshots(): Promise<
  LinkedScraperSnapshot[]
> {
  if (!chrome.storage?.session) return [];
  const everything = await chrome.storage.session.get(null);
  const snapshots: LinkedScraperSnapshot[] = [];
  for (const [key, value] of Object.entries(everything ?? {})) {
    if (!isScraperSnapshotKey(key)) continue;
    const snapshot = validateSnapshot(value);
    if (snapshot) snapshots.push(snapshot);
  }
  snapshots.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return snapshots;
}

/**
 * Clear the snapshot for `serverSessionId`. Cleared on resume, stop, and
 * completion (task 4.3). Scoped like clearCheckpoint: without a session id
 * this is a NO-OP unless { all: true } is passed explicitly.
 */
export async function clearScraperSnapshot(
  serverSessionId?: string,
  options?: { all?: boolean },
): Promise<void> {
  if (!chrome.storage?.session) return;
  if (serverSessionId) {
    await chrome.storage.session.remove([snapshotKey(serverSessionId)]);
    console.log(`[ScraperSnapshot] Cleared (session=${serverSessionId})`);
    return;
  }
  if (options?.all !== true) {
    console.warn(
      "[ScraperSnapshot] clearScraperSnapshot() without a session id and " +
        "without { all: true } is a no-op — pass the session id to scope the clear.",
    );
    return;
  }
  const everything = await chrome.storage.session.get(null);
  const keys = Object.keys(everything ?? {}).filter(isScraperSnapshotKey);
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
  console.log(`[ScraperSnapshot] Cleared (${keys.length} key(s))`);
}

async function readScraperSnapshotByKey(
  key: string,
): Promise<LinkedScraperSnapshot | null> {
  if (!chrome.storage?.session) return null;
  const result = await chrome.storage.session.get(key);
  return validateSnapshot(result[key]);
}

/** Structural validation — a corrupt snapshot reads as null, never throws. */
function validateSnapshot(value: unknown): LinkedScraperSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LinkedScraperSnapshot>;
  if (candidate.version !== SCRAPER_SNAPSHOT_VERSION) return null;
  if (candidate.phase !== "internal" && candidate.phase !== "external") {
    return null;
  }
  if (
    !Array.isArray(candidate.internalQueue) ||
    !Array.isArray(candidate.externalQueue)
  ) {
    return null;
  }
  if (!Array.isArray(candidate.visitedUrls)) return null;
  if (!candidate.options || typeof candidate.options !== "object") return null;
  return candidate as LinkedScraperSnapshot;
}
