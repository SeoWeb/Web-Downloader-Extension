import JSZip from 'jszip';
import { FileStore } from './file-store';

/**
 * Adapter that can write to either JSZip (legacy) or IndexedDB (new)
 */
export interface IStorageAdapter {
  addFile(path: string, content: Blob | string | ArrayBuffer, mimeType?: string): Promise<void>;
  getFile(path: string): Promise<Blob | null>;
  getAllFiles(): Promise<Array<{ path: string; size: number }>>;
  clear(): Promise<void>;
}

/**
 * JSZip adapter (current implementation)
 */
export class JSZipAdapter implements IStorageAdapter {
  constructor(public zip: JSZip) {}

  async addFile(path: string, content: Blob | string | ArrayBuffer): Promise<void> {
    this.zip.file(path, content as any);
  }

  async getFile(path: string): Promise<Blob | null> {
    const file = this.zip.file(path);
    if (!file) return null;
    return await file.async('blob');
  }

  async getAllFiles(): Promise<Array<{ path: string; size: number }>> {
    const files: Array<{ path: string; size: number }> = [];
    this.zip.forEach((path, file) => {
      if (!file.dir) {
        files.push({ path, size: 0 }); // Size not easily available
      }
    });
    return files;
  }

  async clear(): Promise<void> {
    // JSZip doesn't need cleanup
  }
}

/**
 * IndexedDB adapter (new implementation)
 */
export class IndexedDBAdapter implements IStorageAdapter {
  constructor(private downloadId: string) {}

  async addFile(path: string, content: Blob | string | ArrayBuffer, mimeType?: string): Promise<void> {
    await FileStore.storeFile(this.downloadId, path, content, mimeType);
  }

  async getFile(path: string): Promise<Blob | null> {
    const file = await FileStore.getFile(this.downloadId, path);
    return file?.blob || null;
  }

  async getAllFiles(): Promise<Array<{ path: string; size: number }>> {
    return await FileStore.getFileMetadata(this.downloadId);
  }

  async clear(): Promise<void> {
    await FileStore.deleteDownload(this.downloadId);
  }
}
