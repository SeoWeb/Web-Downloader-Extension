import { MultiPartProgressTracker } from "./multi-part-progress";

/**
 * Downloads a single blob.
 */
async function downloadBlob(
  blob: Blob,
  filename: string
): Promise<number> {
  const objectUrl = URL.createObjectURL(blob);
  
  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: false, // Don't ask for location for every part, ideally
      conflictAction: "uniquify",
    });

    // Wait for the download to complete? 
    // chrome.downloads.download returns immediately.
    // We should probably monitor it, but for simplicity in "fire and forget" mode:
    return downloadId;
  } finally {
    // Revoke URL after a delay to ensure download started
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60000); // 1 minute keep-alive for the URL
  }
}

/**
 * Wait for a download to complete (simplified).
 * In a real robust implementation, we'd add listeners to chrome.downloads.onChanged
 */
async function waitForDownloadCompletion(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (!results || results.length === 0) {
          clearInterval(checkInterval);
          reject(new Error("Download not found"));
          return;
        }

        const item = results[0];
        if (item.state === 'complete') {
          clearInterval(checkInterval);
          resolve();
        } else if (item.state === 'interrupted') {
          clearInterval(checkInterval);
          reject(new Error(`Download interrupted: ${item.error}`));
        }
      });
    }, 1000);
  });
}

export async function downloadParts(
  blobs: Blob[],
  baseFilename: string,
  tracker: MultiPartProgressTracker
): Promise<void> {
  const totalParts = blobs.length;
  
  // baseFilename e.g. "example-com-part.zip". 
  // We want "example-com-part-1.zip", "example-com-part-2.zip"
  // Or if input is "example-com.zip", remove extension first.
  const nameWithoutExt = baseFilename.replace(/\.zip$/i, '');

  for (let i = 0; i < totalParts; i++) {
    const partNum = i + 1;
    tracker.startDownloading(partNum);
    
    // Construct filename
    // If multiple parts, append part number
    // If it was just 1 part (shouldn't happen here usually), keep original?
    // But this function is "downloadParts", implying multiple.
    const partFilename = `${nameWithoutExt}-part-${partNum}.zip`;
    
    try {
      const downloadId = await downloadBlob(blobs[i], partFilename);
      
      // Wait for it to finish before starting next? 
      // This prevents browser from choking on multiple large writes/network requests.
      await waitForDownloadCompletion(downloadId);
      
      // Add a small delay between downloads
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      throw error;
    }
  }
  
  tracker.complete();
}
