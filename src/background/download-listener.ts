
import { activeDownloads, getKeepalivePort, setKeepalivePort } from "./download-state";
import { setupOffscreenDocument } from "./download-utils";
import { sendMessageToPanel } from "./message";

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
            
            // Also try to send message in case side panel is still open (fire-and-forget)
            sendMessageToPanel("DOWNLOAD_COMPLETE", {
              downloadId: delta.id,
              filename: downloadInfo.filename,
              tabId: downloadInfo.tabId,
            }, false).then(() => {
              console.log(`Sent DOWNLOAD_COMPLETE message for download ${delta.id}`);
            }).catch((msgError) => {
              // Side panel might be closed, that's ok - storage will handle it
              console.log(`DOWNLOAD_COMPLETE message not delivered (side panel likely closed):`, msgError);
            });
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
          
          console.log(`Download ${delta.id} interruption details:`, {
            error: error || 'none',
            state: download?.state,
            exists: download?.exists
          });
          
          // Check if this was a user cancellation
          // Possible scenarios:
          // 1. User cancels from save dialog: error is undefined
          // 2. User cancels from chrome://downloads: error is "USER_CANCELED"
          // 3. Actual errors: error is set to something else (e.g., "NETWORK_FAILED", "FILE_FAILED", etc.)
          const isCancelled = !error || error === "USER_CANCELED";
          
          if (isCancelled) {
            console.log(`Download ${delta.id} was cancelled by user, sending DOWNLOAD_CANCELLED message`);
            // Send cancellation message to the side panel (fire-and-forget)
            // Don't await since the side panel might be closed
            sendMessageToPanel("DOWNLOAD_CANCELLED", {
              downloadId: delta.id,
              tabId: downloadInfo.tabId,
            }, false).then(() => {
              console.log(`Sent DOWNLOAD_CANCELLED message for download ${delta.id}`);
            }).catch((msgError) => {
              // Side panel might be closed, that's ok
              console.log(`DOWNLOAD_CANCELLED message not delivered (side panel likely closed):`, msgError);
            });
          } else {
            // It's an actual error, not a cancellation
            const errorMessage = error || "Download was interrupted";
            console.log(`Download ${delta.id} failed with error: ${errorMessage}`);
            
            // Send failure message to the side panel (fire-and-forget)
            // Don't await since the side panel might be closed
            sendMessageToPanel("DOWNLOAD_FAILED", {
              downloadId: delta.id,
              error: errorMessage,
              tabId: downloadInfo.tabId,
            }, false).then(() => {
              console.log(`Sent DOWNLOAD_FAILED message for download ${delta.id}`);
            }).catch((msgError) => {
              // Side panel might be closed, that's ok
              console.log(`DOWNLOAD_FAILED message not delivered (side panel likely closed):`, msgError);
            });
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

  // Handle downloads that are erased (e.g., when user cancels from save dialog)
  // This event fires when a download is removed from Chrome's download history
  // which happens when the user clicks "Cancel" in the save-as dialog
  chrome.downloads.onErased.addListener(async (downloadId) => {
    const downloadInfo = activeDownloads.get(downloadId);
    
    if (downloadInfo) {
      console.log(`Download ${downloadId} was erased (likely cancelled from save dialog)`);
      
      // Send cancellation message to the side panel (fire-and-forget)
      sendMessageToPanel("DOWNLOAD_CANCELLED", {
        downloadId: downloadId,
        tabId: downloadInfo.tabId,
      }, false).then(() => {
        console.log(`Sent DOWNLOAD_CANCELLED message for erased download ${downloadId}`);
      }).catch((msgError) => {
        // Side panel might be closed, that's ok
        console.log(`DOWNLOAD_CANCELLED message not delivered (side panel likely closed):`, msgError);
      });
      
      // Clean up blob URLs for erased downloads
      if (chrome.storage && chrome.storage.local) {
        const { downloads } = await chrome.storage.local.get("downloads");
        const downloadMap = downloads || {};

        if (downloadMap[downloadId]) {
          console.log(`Cleaning up object URL for erased download ${downloadId}`);
          const url = downloadMap[downloadId];

          // Only revoke object URLs, not data URLs
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
                `Failed to revoke object URL for erased download ${downloadId}:`,
                cleanupError,
              );
            }
          }

          delete downloadMap[downloadId];
          await chrome.storage.local.set({ downloads: downloadMap });
        }
      }
      
      // Remove from tracking
      activeDownloads.delete(downloadId);
      
      // Disconnect keepalive if no more active downloads
      if (activeDownloads.size === 0) {
        const keepalivePort = getKeepalivePort();
        if (keepalivePort) {
          keepalivePort.disconnect();
          setKeepalivePort(null);
        }
      }
    }
  });
}
