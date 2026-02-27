/**
 * Panel Download Helper
 * 
 * Delegates file downloads to the side panel where URL.createObjectURL is available.
 * Service workers (MV3) cannot use URL.createObjectURL, and using data URLs causes
 * Chrome to ignore the filename parameter, resulting in files named "download" with
 * no extension.
 * 
 * Flow:
 * 1. Service worker stores blob in shared IndexedDB (blobStorage)
 * 2. Service worker sends message to side panel with IDB key + filename
 * 3. Side panel reads blob from IDB, creates blob URL, triggers chrome.downloads.download
 * 4. Side panel returns the download ID
 */

import { sendMessageToPanel } from "./message";
import { saveBlob, deleteBlob } from "../common/blobStorage";
import { trackDownload } from "./download-state";

const PANEL_RESPONSE_TIMEOUT = 15000; // 15 seconds

/**
 * Error thrown when the side panel is unavailable
 */
export class PanelUnavailableError extends Error {
  constructor(message: string = "Extension panel is not available") {
    super(message);
    this.name = "PanelUnavailableError";
  }
}

/**
 * Check if the side panel is alive and responsive
 */
export async function isPanelAlive(): Promise<boolean> {
  try {
    const response = await Promise.race([
      sendMessageToPanel("PANEL_PING", {}, true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Panel ping timeout")), 5000)
      ),
    ]);
    return response === "PONG";
  } catch {
    return false;
  }
}

/**
 * Download a blob by delegating to the side panel.
 * 
 * Stores the blob in shared IndexedDB, then asks the side panel to
 * create a blob URL and trigger chrome.downloads.download with the
 * correct filename.
 * 
 * @param blob The blob to download
 * @param filename The desired filename (e.g. "website.zip")
 * @param saveAs Whether to show the "Save As" dialog
 * @param tabId Optional tab ID for tracking
 * @returns The chrome download ID
 * @throws PanelUnavailableError if the side panel is not responding
 */
export async function downloadViaPanel(
  blob: Blob,
  filename: string,
  saveAs: boolean = true,
  tabId?: number,
): Promise<number> {
  // Generate a unique key for this blob in IndexedDB
  const idbKey = `panel-download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  try {
    // 1. Store blob in IndexedDB (shared between SW and side panel)
    await saveBlob(idbKey, blob);

    // 2. Ask the side panel to create a blob URL and download
    const response = await Promise.race([
      sendMessageToPanel("PANEL_CREATE_DOWNLOAD", {
        idbKey,
        filename,
        saveAs,
      }, true),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new PanelUnavailableError(
          "Extension panel did not respond. Please keep the extension panel open during downloads."
        )), PANEL_RESPONSE_TIMEOUT)
      ),
    ]);

    if (!response) {
      throw new PanelUnavailableError("Extension panel did not respond. Please keep the extension panel open during downloads.");
    }

    if (response.error) {
      throw new Error(response.error);
    }

    const downloadId = response.downloadId as number;

    // 3. Track the download for completion detection
    trackDownload(downloadId, filename, tabId);

    return downloadId;
  } catch (error) {
    // Clean up the stored blob on failure
    try {
      await deleteBlob(idbKey);
    } catch {
      // Ignore cleanup errors
    }

    // Re-throw PanelUnavailableError as-is, wrap others
    if (error instanceof PanelUnavailableError) {
      throw error;
    }

    // Check if the error is due to no message listeners (panel closed)
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("Could not establish connection") ||
      errorMessage.includes("Receiving end does not exist") ||
      errorMessage.includes("No matching signature") ||
      errorMessage.includes("timeout")
    ) {
      throw new PanelUnavailableError(
        "Extension panel is not available. Please keep the extension panel open during downloads."
      );
    }

    throw error;
  }
}

/**
 * Download a blob via panel, with automatic waiting for download completion.
 * Used for multi-part downloads where we need to wait for each part to finish.
 */
export async function downloadViaPanelAndWait(
  blob: Blob,
  filename: string,
  saveAs: boolean = false,
  tabId?: number,
  timeoutMs: number = 300000, // 5 minute timeout
): Promise<void> {
  const downloadId = await downloadViaPanel(blob, filename, saveAs, tabId);

  // Wait for download to complete
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      reject(new Error("Download timeout"));
    }, timeoutMs);

    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId && delta.state) {
        if (delta.state.current === "complete") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          resolve();
        } else if (delta.state.current === "interrupted") {
          clearTimeout(timeout);
          chrome.downloads.onChanged.removeListener(listener);
          reject(new Error("Download interrupted"));
        }
      }
    };

    chrome.downloads.onChanged.addListener(listener);
  });
}
