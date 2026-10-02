/**
 * Download Checkpoint — lightweight session-scoped persistence for detecting
 * and recovering from service worker termination during an active download.
 *
 * Uses `chrome.storage.session` (cleared on browser close) to store the
 * minimum metadata needed to detect interruption and offer the user a restart.
 */

const STORAGE_KEY = "downloadCheckpoint";

export interface ResourceUrlEntry {
  url: string;
  path: string;
  contentType: string;
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

/** Persist a checkpoint to session storage. */
export async function writeCheckpoint(
  data: Omit<DownloadCheckpoint, "downloadInterrupted" | "timestamp">,
): Promise<void> {
  const checkpoint: DownloadCheckpoint = {
    ...data,
    downloadInterrupted: true,
    timestamp: Date.now(),
  };
  await chrome.storage?.session?.set({ [STORAGE_KEY]: checkpoint });
  console.log(`[Checkpoint] Written: phase=${data.phase}`);
}

/** Update only the phase field of an existing checkpoint. No-op if none exists. */
export async function updateCheckpointPhase(phase: string): Promise<void> {
  const existing = await readCheckpoint();
  if (existing) {
    existing.phase = phase;
    await chrome.storage?.session?.set({ [STORAGE_KEY]: existing });
    console.log(`[Checkpoint] Phase updated: ${phase}`);
  }
}

/** Read the current checkpoint, or null if none exists. */
export async function readCheckpoint(): Promise<DownloadCheckpoint | null> {
  if (!chrome.storage?.session) return null;
  const result = await chrome.storage.session.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as DownloadCheckpoint) ?? null;
}

/** Update the resourceUrls field of an existing checkpoint. No-op if none exists. */
export async function updateCheckpointResourceUrls(
  resourceUrls: ResourceUrlEntry[],
): Promise<void> {
  const existing = await readCheckpoint();
  if (existing) {
    existing.resourceUrls = resourceUrls;
    await chrome.storage?.session?.set({ [STORAGE_KEY]: existing });
    console.log(
      `[Checkpoint] Resource URLs updated: ${resourceUrls.length} entries`,
    );
  }
}

/** Clear the checkpoint from session storage. */
export async function clearCheckpoint(): Promise<void> {
  await chrome.storage?.session?.remove(STORAGE_KEY);
  console.log("[Checkpoint] Cleared");
}
