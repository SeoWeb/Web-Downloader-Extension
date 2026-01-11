import { db, ScrapedFile } from './database';

export class FileStore {
  /**
   * Store a file in IndexedDB
   */
  static async storeFile(
    downloadId: string,
    path: string,
    content: Blob | string | ArrayBuffer,
    mimeType?: string
  ): Promise<void> {
    const blob = this.toBlob(content, mimeType);
    
    const file: ScrapedFile = {
      id: `${downloadId}-${path}`,
      downloadId,
      path,
      blob,
      size: blob.size,
      mimeType: blob.type || mimeType || 'application/octet-stream',
      timestamp: Date.now()
    };

    await db.files.put(file);
  }

  /**
   * Retrieve a single file
   */
  static async getFile(downloadId: string, path: string): Promise<ScrapedFile | undefined> {
    return await db.files.get(`${downloadId}-${path}`);
  }

  /**
   * Retrieve a file blob directly by ID
   */
  static async getFileBlobById(id: string): Promise<Blob | undefined> {
    const file = await db.files.get(id);
    return file?.blob;
  }

  /**
   * Get all files for a download session
   */
  static async getAllFiles(downloadId: string): Promise<ScrapedFile[]> {
    return await db.files.where('downloadId').equals(downloadId).toArray();
  }

  /**
   * Get file metadata only (without blobs) for partitioning
   */
  static async getFileMetadata(downloadId: string): Promise<Array<{
    path: string;
    size: number;
    id: string;
  }>> {
    const files = await db.files
      .where('downloadId')
      .equals(downloadId)
      .toArray();
    
    return files.map(f => ({
      path: f.path,
      size: f.size,
      id: f.id
    }));
  }

  /**
   * Get files for a specific partition
   */
  static async getPartitionFiles(fileIds: string[]): Promise<ScrapedFile[]> {
    return await db.files.bulkGet(fileIds) as ScrapedFile[];
  }

  /**
   * Delete all files for a download session
   */
  static async deleteDownload(downloadId: string): Promise<void> {
    await db.files.where('downloadId').equals(downloadId).delete();
    await db.sessions.delete(downloadId);
  }

  /**
   * Clean up old downloads (older than 24 hours)
   */
  static async cleanupOldDownloads(): Promise<number> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const deleted = await db.files.where('timestamp').below(cutoff).delete();
    await db.sessions.where('startTime').below(cutoff).delete();
    return deleted;
  }

  /**
   * Get total storage usage
   */
  static async getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    activeSessions: number;
  }> {
    const files = await db.files.toArray();
    const sessions = await db.sessions.where('status').notEqual('complete').count();
    
    return {
      totalFiles: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      activeSessions: sessions
    };
  }

  /**
   * Helper: Convert various content types to Blob
   */
  private static toBlob(content: Blob | string | ArrayBuffer, mimeType?: string): Blob {
    if (content instanceof Blob) {
      return content;
    }
    if (typeof content === 'string') {
      return new Blob([content], { type: mimeType || 'text/plain' });
    }
    if (content instanceof ArrayBuffer) {
      return new Blob([content], { type: mimeType || 'application/octet-stream' });
    }
    throw new Error('Unsupported content type');
  }
}
