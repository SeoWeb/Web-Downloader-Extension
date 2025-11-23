import { getBlob, deleteBlob } from '../common/blobStorage';

/// <reference types="chrome" />

chrome.runtime.onMessage.addListener((message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
  if (message.action === 'createBlobUrl') {
    handleCreateBlobUrl(message.key).then(sendResponse).catch((error) => {
      console.error('Error creating blob URL:', error);
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
    return true; // Keep channel open for async response
  } else if (message.action === 'revokeBlobUrl') {
    handleRevokeBlobUrl(message.url);
    sendResponse({ success: true });
  }
});

async function handleCreateBlobUrl(key: string) {
  try {
    const blob = await getBlob(key);
    const url = URL.createObjectURL(blob);
    
    // We can delete the blob from storage now that we have a URL?
    // No, if we reload the offscreen document, the URL is lost.
    // But the URL is valid as long as the document is alive.
    // We should delete the blob from storage to free up space, 
    // but maybe wait until download starts?
    // Let's keep it simple: delete after creating URL, assuming download happens soon.
    // Actually, if we delete it, and the download fails and we retry, we might need it?
    // The background script handles retries.
    // Let's delete it here to avoid storage accumulation.
    await deleteBlob(key);
    
    return { url };
  } catch (error) {
    console.error('Failed to create blob URL:', error);
    throw error;
  }
}

function handleRevokeBlobUrl(url: string) {
  URL.revokeObjectURL(url);
}