/**
 * Download Checkpoint — lightweight session-scoped persistence for detecting
 * and recovering from service worker termination during an active download.
 *
 * Uses `chrome.storage.session` (cleared on browser close) to store the
 * minimum metadata needed to detect interruption and offer the user a restart.
 *
 * (D4 / fix-archived-page-pipeline) Storage is keyed PER DOWNLOAD (by server
 * session id) so concurrent downloads can no longer clobber each other's
 * recovery state — the single global `downloadCheckpoint` key is replaced by
 * a `downloadCheckpoint:<serverSessionId>` namespace. The legacy key is still
 * read for checkpoints written by an older extension version. Only small
 * metadata manifests are stored — upload BLOBS are never persisted.
 */

const STORAGE_KEY_PREFIX = "downloadCheckpoint";
/** Legacy single global key (pre per-download keying). */
const LEGACY_STORAGE_KEY = "downloadCheckpoint";

/** True for any checkpoint storage key (namespaced or legacy). */
function isCheckpointKey(key: string): boolean {
  return key === LEGACY_STORAGE_KEY || key.startsWith(`${STORAGE_KEY_PREFIX}:`);
}

function checkpointKey(serverSessionId?: string): string {
  return serverSessionId
    ? `${STORAGE_KEY_PREFIX}:${serverSessionId}`
    : LEGACY_STORAGE_KEY;
}

export interface ResourceUrlEntry {
  url: string;
  path: string;
  contentType: string;
  /**
   * Resource size in bytes (from the upload task). Metadata only — blobs are
   * never persisted to storage (design D4.4).
   */
  size?: number;
}

export interface DownloadCheckpoint {
  downloadInterrupted: boolean;
  serverSessionId?: string;
  tabId?: number;
  tabUrl?: string;
  phase: string;
  timestamp: number;
  resourceUrls?: ResourceUrlEntry[];
}

/** Persist a checkpoint to session storage, keyed by server session id. */
export async function writeCheckpoint(
  data: Omit<DownloadCheckpoint, "downloadInterrupted" | "timestamp">,
): Promise<void> {
  const checkpoint: DownloadCheckpoint = {
    ...data,
    downloadInterrupted: true,
    timestamp: Date.now(),
  };
  const key = checkpointKey(data.serverSessionId);
  await chrome.storage?.session?.set({ [key]: checkpoint });
  console.log(
    `[Checkpoint] Written: phase=${data.phase} session=${data.serverSessionId ?? "none"}`,
  );
}

/**
 * Update only the phase field of the checkpoint for `serverSessionId`.
 * No-op if none exists. When no session id is given, the legacy global key
 * is updated.
 */
export async function updateCheckpointPhase(
  phase: string,
  serverSessionId?: string,
): Promise<void> {
  const key = checkpointKey(serverSessionId);
  const existing = await readCheckpointByKey(key);
  if (existing) {
    existing.phase = phase;
    await chrome.storage?.session?.set({ [key]: existing });
    console.log(`[Checkpoint] Phase updated: ${phase}`);
  }
}

/**
 * Read the checkpoint for a specific download, or — when no session id is
 * given — the most recent checkpoint across all downloads (backward-compatible
 * single-checkpoint view used by the panel interrupt flow).
 */
export async function readCheckpoint(
  serverSessionId?: string,
): Promise<DownloadCheckpoint | null> {
  if (serverSessionId) {
    return readCheckpointByKey(checkpointKey(serverSessionId));
  }
  const all = await readAllCheckpoints();
  return all[0] ?? null;
}

/**
 * Enumerate ALL per-download checkpoints currently in session storage
 * (startup detection must handle multiple concurrent interrupted downloads).
 * Returned newest-first.
 */
export async function readAllCheckpoints(): Promise<DownloadCheckpoint[]> {
  if (!chrome.storage?.session) return [];
  const everything = await chrome.storage.session.get(null);
  const checkpoints: DownloadCheckpoint[] = [];
  for (const [key, value] of Object.entries(everything ?? {})) {
    if (isCheckpointKey(key) && value && typeof value === "object") {
      checkpoints.push(value as DownloadCheckpoint);
    }
  }
  checkpoints.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return checkpoints;
}

/** Update the resourceUrls field of the checkpoint for `serverSessionId`. */
export async function updateCheckpointResourceUrls(
  resourceUrls: ResourceUrlEntry[],
  serverSessionId?: string,
): Promise<void> {
  const key = checkpointKey(serverSessionId);
  const existing = await readCheckpointByKey(key);
  if (existing) {
    existing.resourceUrls = resourceUrls;
    await chrome.storage?.session?.set({ [key]: existing });
    console.log(
      `[Checkpoint] Resource URLs updated: ${resourceUrls.length} entries ` +
        `(session=${serverSessionId ?? "none"})`,
    );
  }
}

/**
 * Clear the checkpoint for `serverSessionId`. When no session id is given,
 * ALL checkpoint keys are cleared (legacy global-clear semantics, used by
 * the panel dismiss flow).
 *
 * Upgrade path: the legacy single global key is also removed when it holds
 * THIS session's checkpoint (written by an extension version before
 * per-download keying).
 */
export async function clearCheckpoint(serverSessionId?: string): Promise<void> {
  if (!chrome.storage?.session) return;
  if (serverSessionId) {
    const keys = [checkpointKey(serverSessionId)];
    const legacy = await readCheckpointByKey(LEGACY_STORAGE_KEY);
    if (legacy && legacy.serverSessionId === serverSessionId) {
      keys.push(LEGACY_STORAGE_KEY);
    }
    await chrome.storage.session.remove(keys);
    console.log(`[Checkpoint] Cleared (session=${serverSessionId})`);
    return;
  }
  const everything = await chrome.storage.session.get(null);
  const keys = Object.keys(everything ?? {}).filter(isCheckpointKey);
  if (keys.length > 0) {
    await chrome.storage.session.remove(keys);
  }
  console.log(`[Checkpoint] Cleared (${keys.length} key(s))`);
}

async function readCheckpointByKey(
  key: string,
): Promise<DownloadCheckpoint | null> {
  if (!chrome.storage?.session) return null;
  const result = await chrome.storage.session.get(key);
  return (result[key] as DownloadCheckpoint) ?? null;
}
