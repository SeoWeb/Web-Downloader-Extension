const DB_NAME = "WebPageDownloaderBlobStorage";
const STORE_NAME = "blobs";
const METADATA_STORE_NAME = "blob_metadata";
const DB_VERSION = 2;

interface BlobMetadata {
  key: string;
  size: number;
  timestamp: number;
  accessCount: number;
  lastAccessed: number;
  downloadId?: string;
}

export async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Create main blob store if it doesn't exist
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }

      // Create metadata store for tracking and cleanup
      if (!db.objectStoreNames.contains(METADATA_STORE_NAME)) {
        const metadataStore = db.createObjectStore(METADATA_STORE_NAME, {
          keyPath: "key",
        });
        metadataStore.createIndex("timestamp", "timestamp");
        metadataStore.createIndex("lastAccessed", "lastAccessed");
        metadataStore.createIndex("downloadId", "downloadId");
      }
    };
  });
}

export async function saveBlob(
  key: string,
  blob: Blob,
  downloadId?: string,
): Promise<void> {
  const db = await initDB();
  const timestamp = Date.now();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Save the blob
    const blobRequest = blobStore.put(blob, key);
    blobRequest.onerror = () => reject(blobRequest.error);

    // Save metadata
    const metadata: BlobMetadata = {
      key,
      size: blob.size,
      timestamp,
      accessCount: 0,
      lastAccessed: timestamp,
      downloadId,
    };

    const metadataRequest = metadataStore.put(metadata);
    metadataRequest.onerror = () => reject(metadataRequest.error);

    transaction.oncomplete = () => {
      console.log(`Blob saved: ${key} (${formatBytes(blob.size)})`);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getBlob(key: string): Promise<Blob> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Get the blob
    const blobRequest = blobStore.get(key);
    blobRequest.onerror = () => reject(blobRequest.error);

    blobRequest.onsuccess = () => {
      if (blobRequest.result) {
        // Update access metadata
        const metadataRequest = metadataStore.get(key);
        metadataRequest.onsuccess = () => {
          const metadata = metadataRequest.result as BlobMetadata;
          if (metadata) {
            metadata.accessCount++;
            metadata.lastAccessed = Date.now();
            metadataStore.put(metadata);
          }
        };

        resolve(blobRequest.result);
      } else {
        reject(new Error(`Blob with key ${key} not found`));
      }
    };
  });
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Delete blob
    const blobRequest = blobStore.delete(key);
    blobRequest.onerror = () => reject(blobRequest.error);

    // Delete metadata
    const metadataRequest = metadataStore.delete(key);
    metadataRequest.onerror = () => reject(metadataRequest.error);

    transaction.oncomplete = () => {
      console.log(`Blob deleted: ${key}`);
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Get storage statistics for monitoring
 */
export async function getStorageStats(): Promise<{
  totalBlobs: number;
  totalSize: number;
  oldestBlob: number;
  averageAccessCount: number;
}> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(METADATA_STORE_NAME, "readonly");
    const store = transaction.objectStore(METADATA_STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const metadata = request.result as BlobMetadata[];
      const totalBlobs = metadata.length;
      const totalSize = metadata.reduce((sum, blob) => sum + blob.size, 0);
      const oldestBlob =
        metadata.length > 0
          ? Math.min(...metadata.map((blob) => blob.timestamp))
          : 0;
      const averageAccessCount =
        totalBlobs > 0
          ? metadata.reduce((sum, blob) => sum + blob.accessCount, 0) /
            totalBlobs
          : 0;

      resolve({
        totalBlobs,
        totalSize,
        oldestBlob,
        averageAccessCount,
      });
    };
  });
}

/**
 * Clean up old blobs based on age and usage
 */
export async function cleanupOldBlobs(
  maxAge: number = 30 * 60 * 1000,
): Promise<void> {
  const db = await initDB();
  const cutoffTime = Date.now() - maxAge;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Get old metadata
    const index = metadataStore.index("timestamp");
    const range = IDBKeyRange.upperBound(cutoffTime);
    const request = index.getAllKeys(range);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const oldKeys = request.result as string[];
      let deletedCount = 0;

      if (oldKeys.length === 0) {
        console.log("No old blobs to clean up");
        resolve();
        return;
      }

      // Delete old blobs and their metadata
      oldKeys.forEach((key) => {
        blobStore.delete(key);
        metadataStore.delete(key);
        deletedCount++;
      });

      transaction.oncomplete = () => {
        console.log(`Cleaned up ${deletedCount} old blobs`);
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

/**
 * Clean up blobs for a specific download ID
 */
export async function cleanupDownloadBlobs(downloadId: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Find blobs for this download ID
    const index = metadataStore.index("downloadId");
    const request = index.getAllKeys(downloadId);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const keys = request.result as string[];
      let deletedCount = 0;

      if (keys.length === 0) {
        console.log(`No blobs found for download ${downloadId}`);
        resolve();
        return;
      }

      // Delete blobs and their metadata
      keys.forEach((key) => {
        blobStore.delete(key);
        metadataStore.delete(key);
        deletedCount++;
      });

      transaction.oncomplete = () => {
        console.log(
          `Cleaned up ${deletedCount} blobs for download ${downloadId}`,
        );
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

/**
 * Force cleanup of all blobs (emergency cleanup)
 */
export async function forceCleanupAllBlobs(): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      [STORE_NAME, METADATA_STORE_NAME],
      "readwrite",
    );
    const blobStore = transaction.objectStore(STORE_NAME);
    const metadataStore = transaction.objectStore(METADATA_STORE_NAME);

    // Clear all stores
    const blobRequest = blobStore.clear();
    const metadataRequest = metadataStore.clear();

    blobRequest.onerror = () => reject(blobRequest.error);
    metadataRequest.onerror = () => reject(metadataRequest.error);

    transaction.oncomplete = () => {
      console.log("Force cleanup: All blobs deleted");
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Get memory usage for the blob storage
 */
export async function getBlobMemoryUsage(): Promise<{
  blobCount: number;
  totalSize: number;
  oldestBlob: Date;
  newestBlob: Date;
}> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(METADATA_STORE_NAME, "readonly");
    const store = transaction.objectStore(METADATA_STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const metadata = request.result as BlobMetadata[];

      if (metadata.length === 0) {
        resolve({
          blobCount: 0,
          totalSize: 0,
          oldestBlob: new Date(),
          newestBlob: new Date(),
        });
        return;
      }

      const blobCount = metadata.length;
      const totalSize = metadata.reduce((sum, blob) => sum + blob.size, 0);
      const timestamps = metadata.map((blob) => blob.timestamp);
      const oldestBlob = new Date(Math.min(...timestamps));
      const newestBlob = new Date(Math.max(...timestamps));

      resolve({
        blobCount,
        totalSize,
        oldestBlob,
        newestBlob,
      });
    };
  });
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}
