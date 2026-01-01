
import { activeDownloads, getKeepalivePort, setKeepalivePort } from "./download-state";
import { setupOffscreenDocument } from "./download-utils";

export function initializeDownloadListener() {
  // Enhanced listener to track download completion and clean up object URLs
  chrome.downloads.onChanged.addListener(async (delta) => {
    // Check if this download is being tracked
    const downloadInfo = activeDownloads.get(delta.id);
    
    // Handle download state changes
    if (delta.state) {
      if (delta.state.current === "complete") {
        
        if (downloadInfo) {
          // Store completion status in chrome.storage for the side panel to pick up
          try {
            if (chrome.storage && chrome.storage.local) {
              await chrome.storage.local.set({
                downloadComplete: {
                  downloadId: delta.id,
                  filename: downloadInfo.filename,
                  tabId: downloadInfo.tabId,
                  timestamp: Date.now(),
                },
              });
            }
            
            // Also try to send message in case side panel is still open
            try {
              await chrome.runtime.sendMessage({
                action: "DOWNLOAD_COMPLETE",
                downloadId: delta.id,
                filename: downloadInfo.filename,
                tabId: downloadInfo.tabId,
              });
            } catch (msgError) {
              // Side panel might be closed, that's ok - storage will handle it
              console.log(`Message send failed (expected if side panel closed):`, msgError);
            }
          } catch (error) {
            console.error(`Failed to store DOWNLOAD_COMPLETE status:`, error);
          }
          
          // Remove from tracking
          activeDownloads.delete(delta.id);
          
          // Disconnect keepalive if no more active downloads
          if (activeDownloads.size === 0) {
            const keepalivePort = getKeepalivePort();
            if (keepalivePort) {
                keepalivePort.disconnect();
                setKeepalivePort(null);
            }
          }
        }
      } else if (delta.state.current === "interrupted") {
        console.log(`Download interrupted: ${delta.id}`);
        
        if (downloadInfo) {
          // Get the download to check the error
          const [download] = await chrome.downloads.search({ id: delta.id });
          const error = download?.error;
          
          // Check if this was a user cancellation
          // User can cancel from save dialog (no error) or from chrome://downloads (USER_CANCELED error)
          const isCancelled = !error || error === "USER_CANCELED";
          
          if (isCancelled) {
            // Send cancellation message to the side panel
            try {
              await chrome.runtime.sendMessage({
                action: "DOWNLOAD_CANCELLED",
                downloadId: delta.id,
                tabId: downloadInfo.tabId,
              });
              console.log(`Sent DOWNLOAD_CANCELLED message for download ${delta.id}`);
            } catch (msgError) {
              console.error(`Failed to send DOWNLOAD_CANCELLED message:`, msgError);
            }
          } else {
            // It's an actual error, not a cancellation
            const errorMessage = error || "Download was interrupted";
            
            // Send failure message to the side panel
            try {
              await chrome.runtime.sendMessage({
                action: "DOWNLOAD_FAILED",
                downloadId: delta.id,
                error: errorMessage,
                tabId: downloadInfo.tabId,
              });
            } catch (msgError) {
              console.error(`Failed to send DOWNLOAD_FAILED message:`, msgError);
            }
          }
          
          // Remove from tracking
          activeDownloads.delete(delta.id);
          
          // Disconnect keepalive if no more active downloads
          if (activeDownloads.size === 0) {
            const keepalivePort = getKeepalivePort();
            if (keepalivePort) {
                keepalivePort.disconnect();
                setKeepalivePort(null);
            }
          }
        }
      }
    }
    
    // Original cleanup logic for object URLs
    if (delta.state && delta.state.current !== "inprogress") {
      if (chrome.storage && chrome.storage.local) {
        const { downloads } = await chrome.storage.local.get("downloads");
        const downloadMap = downloads || {};

        if (downloadMap[delta.id]) {
          console.log(`Cleaning up object URL for download ${delta.id}`);
          const url = downloadMap[delta.id];

          // Only revoke object URLs, not data URLs or blob URLs
          if (url.startsWith("blob:") || url.startsWith("data:")) {
            try {
              if (typeof URL.revokeObjectURL === "function") {
                URL.revokeObjectURL(url);
              } else {
                // Send message to offscreen to revoke
                await setupOffscreenDocument("offscreen.html");
                chrome.runtime.sendMessage({ action: "revokeBlobUrl", url });
              }
            } catch (cleanupError) {
              console.warn(
                `Failed to revoke object URL for download ${delta.id}:`,
                cleanupError,
              );
            }
          }

          delete downloadMap[delta.id];
          await chrome.storage.local.set({ downloads: downloadMap });
        }
      }
    }
  });
}
