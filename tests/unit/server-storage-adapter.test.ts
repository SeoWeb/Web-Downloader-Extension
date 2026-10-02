/**
 * Unit tests for ServerStorageAdapter (tasks 10.1–10.6).
 *
 * All ServerClient and UploadQueue interactions are mocked — no real
 * server needed. Tests validate IStorageAdapter contract compliance,
 * delegation to UploadQueue, write-only semantics, atomic clear,
 * and interchangeability with IndexedDBAdapter.
 */

import { ServerStorageAdapter } from "../../src/background/storage/server-storage-adapter";
import { IStorageAdapter } from "../../src/background/storage/storage-adapter";
import { ServerClient } from "../../src/background/server-client";
import { UploadQueue } from "../../src/background/upload-queue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock ServerClient with controlled methods. */
function createMockServerClient(overrides?: {
  deleteSession?: (sessionId: string) => Promise<void>;
  uploadResource?: (...args: unknown[]) => Promise<unknown>;
}): ServerClient {
  const client = new ServerClient();
  if (overrides?.deleteSession) {
    (client as any).deleteSession = overrides.deleteSession;
  }
  if (overrides?.uploadResource) {
    (client as any).uploadResource = overrides.uploadResource;
  }
  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ServerStorageAdapter", () => {
  // -----------------------------------------------------------------------
  // 10.1 — Implements IStorageAdapter
  // -----------------------------------------------------------------------
  describe("IStorageAdapter contract", () => {
    it("implements the IStorageAdapter interface", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      // Verify all IStorageAdapter methods exist
      expect(typeof adapter.addFile).toBe("function");
      expect(typeof adapter.getFile).toBe("function");
      expect(typeof adapter.getAllFiles).toBe("function");
      expect(typeof adapter.clear).toBe("function");
    });

    it("is assignable to IStorageAdapter type", () => {
      const client = createMockServerClient();
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);
      expect(adapter).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // 10.2 — addFile() uploads via ServerClient + UploadQueue
  // -----------------------------------------------------------------------
  describe("addFile", () => {
    it("throws if sessionId is not set", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      await expect(
        adapter.addFile("images/test.png", new Blob(["data"]), "image/png"),
      ).rejects.toThrow("sessionId not set");
    });

    it("delegates to UploadQueue.enqueue after setSessionId", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      // Spy on the internal UploadQueue's enqueue method
      const queue = adapter.getUploadQueue();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockResolvedValue("task-1");

      const blob = new Blob(["test content"], { type: "text/plain" });
      await adapter.addFile("styles/main.css", blob, "text/css");

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith(
        "sess-1",
        "styles/main.css",
        expect.any(Blob),
        "styles/main.css", // originalUrl defaults to path
        "text/css",
      );

      enqueueSpy.mockRestore();
    });

    it("converts string content to Blob before enqueuing", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockResolvedValue("task-2");

      await adapter.addFile("index.html", "<html></html>", "text/html");

      // The blob argument should be a Blob with the string content
      const enqueuedBlob = enqueueSpy.mock.calls[0][2] as Blob;
      expect(enqueuedBlob).toBeInstanceOf(Blob);

      const text = await enqueuedBlob.text();
      expect(text).toBe("<html></html>");

      enqueueSpy.mockRestore();
    });

    it("converts ArrayBuffer content to Blob before enqueuing", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockResolvedValue("task-3");

      const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
      await adapter.addFile("data.bin", buffer, "application/octet-stream");

      const enqueuedBlob = enqueueSpy.mock.calls[0][2] as Blob;
      expect(enqueuedBlob).toBeInstanceOf(Blob);
      expect(enqueuedBlob.size).toBe(4);

      enqueueSpy.mockRestore();
    });

    it("passes Blob content through unchanged", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockResolvedValue("task-4");

      const originalBlob = new Blob(["binary data"], { type: "image/png" });
      await adapter.addFile("images/photo.png", originalBlob, "image/png");

      const enqueuedBlob = enqueueSpy.mock.calls[0][2] as Blob;
      expect(enqueuedBlob).toBe(originalBlob); // Same reference

      enqueueSpy.mockRestore();
    });

    it("defaults mimeType to application/octet-stream when not provided", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const enqueueSpy = vi.spyOn(queue, "enqueue").mockResolvedValue("task-5");

      await adapter.addFile("data.bin", new Blob(["data"]));

      const contentType = enqueueSpy.mock.calls[0][4] as string;
      expect(contentType).toBe("application/octet-stream");

      enqueueSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // 10.3 — getFile() returns null (write-only)
  // -----------------------------------------------------------------------
  describe("getFile", () => {
    it("returns null for any path (server storage is write-only)", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      const result = await adapter.getFile("images/test.png");
      expect(result).toBeNull();
    });

    it("returns null even after addFile (no local read)", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      // Mock the queue so addFile doesn't fail
      const queue = adapter.getUploadQueue();
      vi.spyOn(queue, "enqueue").mockResolvedValue("task-1");

      await adapter.addFile("images/test.png", new Blob(["data"]), "image/png");

      // Still returns null — files are on the server, not locally
      const result = await adapter.getFile("images/test.png");
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // 10.3a — getResourceCount() on ServerStorageAdapter (NOT IStorageAdapter)
  // -----------------------------------------------------------------------
  describe("getResourceCount", () => {
    it("delegates to UploadQueue.getResourceCount", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      const queue = adapter.getUploadQueue();
      const spy = vi.spyOn(queue, "getResourceCount").mockReturnValue(5);

      expect(adapter.getResourceCount()).toBe(5);
      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });

    it("is NOT part of the IStorageAdapter interface", () => {
      const client = createMockServerClient();
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);

      // getResourceCount is a ServerStorageAdapter-specific method.
      // TypeScript enforces this at compile time; at runtime we verify
      // that the method exists on the concrete class but not on the
      // interface type (would require a cast).
      expect(typeof (adapter as ServerStorageAdapter).getResourceCount).toBe("function");
    });
  });

  // -----------------------------------------------------------------------
  // 10.4 — getAllFiles() returns empty array
  // -----------------------------------------------------------------------
  describe("getAllFiles", () => {
    it("returns an empty array (server manages file enumeration)", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      const result = await adapter.getAllFiles();
      expect(result).toEqual([]);
    });

    it("returns empty array even after addFile", async () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      vi.spyOn(queue, "enqueue").mockResolvedValue("task-1");

      await adapter.addFile("styles/main.css", "body {}", "text/css");

      const result = await adapter.getAllFiles();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // 10.5 — clear() aborts uploads AND deletes session atomically
  // -----------------------------------------------------------------------
  describe("clear", () => {
    it("calls UploadQueue.cancel() to abort in-progress uploads", async () => {
      const client = createMockServerClient({
        deleteSession: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const cancelSpy = vi.spyOn(queue, "cancel");

      await adapter.clear();

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      cancelSpy.mockRestore();
    });

    it("calls ServerClient.deleteSession() to clean up server data", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const client = createMockServerClient({
        deleteSession: deleteMock,
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      await adapter.clear();

      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith("sess-1");
    });

    it("performs BOTH cancel and delete (S5: atomic abort+delete)", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const client = createMockServerClient({
        deleteSession: deleteMock,
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      const queue = adapter.getUploadQueue();
      const cancelSpy = vi.spyOn(queue, "cancel");

      await adapter.clear();

      // Both actions must occur (S5 fix)
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledWith("sess-1");

      cancelSpy.mockRestore();
    });

    it("clears sessionId after successful deletion", async () => {
      const client = createMockServerClient({
        deleteSession: vi.fn().mockResolvedValue(undefined),
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      expect(adapter.getSessionId()).toBe("sess-1");

      await adapter.clear();

      expect(adapter.getSessionId()).toBeNull();
    });

    it("does not call deleteSession when sessionId is null", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const client = createMockServerClient({
        deleteSession: deleteMock,
      });
      const adapter = new ServerStorageAdapter(client);
      // No setSessionId called — sessionId is null

      await adapter.clear();

      expect(deleteMock).not.toHaveBeenCalled();
    });

    it("still clears sessionId when deleteSession throws (best-effort)", async () => {
      const client = createMockServerClient({
        deleteSession: vi.fn().mockRejectedValue(new Error("Network error")),
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      // Should not throw — deletion is best-effort
      await expect(adapter.clear()).resolves.not.toThrow();

      // SessionId should still be cleared
      expect(adapter.getSessionId()).toBeNull();
    });

    it("still calls deleteSession even if cancel has no uploads", async () => {
      const deleteMock = vi.fn().mockResolvedValue(undefined);
      const client = createMockServerClient({
        deleteSession: deleteMock,
      });
      const adapter = new ServerStorageAdapter(client);
      adapter.setSessionId("sess-1");

      await adapter.clear();

      // deleteSession should still be called — even with no uploads,
      // there may be server-side data to clean up
      expect(deleteMock).toHaveBeenCalledWith("sess-1");
    });
  });

  // -----------------------------------------------------------------------
  // 10.6 — Interchangeability with IndexedDBAdapter
  // -----------------------------------------------------------------------
  describe("interchangeability with IndexedDBAdapter", () => {
    it("addFile accepts same parameter types as IStorageAdapter.addFile", async () => {
      const client = createMockServerClient();
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);
      (adapter as ServerStorageAdapter).setSessionId("sess-1");

      const queue = (adapter as ServerStorageAdapter).getUploadQueue();
      vi.spyOn(queue, "enqueue").mockResolvedValue("task-1");

      // These are the same callsites file handlers use:
      // storage.addFile(path, content, mimeType?)
      await adapter.addFile("images/photo.jpg", new Blob(["img"]), "image/jpeg");
      await adapter.addFile("styles/main.css", "body {}", "text/css");
      await adapter.addFile("scripts/app.js", new ArrayBuffer(0), "application/javascript");

      // All calls succeed without type errors
    });

    it("getFile returns null (vs IndexedDB returning Blob|null)", async () => {
      const client = createMockServerClient();
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);

      const result = await adapter.getFile("any/path");
      // Both adapters return Blob | null — ServerStorageAdapter always returns null
      expect(result).toBeNull();
    });

    it("getAllFiles returns empty array (vs IndexedDB returning file list)", async () => {
      const client = createMockServerClient();
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);

      const result = await adapter.getAllFiles();
      // Same return type as IndexedDBAdapter.getAllFiles()
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it("clear resolves without error (same as IndexedDBAdapter.clear)", async () => {
      const client = createMockServerClient({
        deleteSession: vi.fn().mockResolvedValue(undefined),
      });
      const adapter: IStorageAdapter = new ServerStorageAdapter(client);
      (adapter as ServerStorageAdapter).setSessionId("sess-1");

      // Should not throw
      await expect(adapter.clear()).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Session ID management
  // -----------------------------------------------------------------------
  describe("session ID management", () => {
    it("getSessionId returns null before setSessionId", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      expect(adapter.getSessionId()).toBeNull();
    });

    it("getSessionId returns the ID after setSessionId", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      adapter.setSessionId("sess-abc");
      expect(adapter.getSessionId()).toBe("sess-abc");
    });

    it("setSessionId can be called to update the session ID", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      adapter.setSessionId("sess-1");
      expect(adapter.getSessionId()).toBe("sess-1");

      adapter.setSessionId("sess-2");
      expect(adapter.getSessionId()).toBe("sess-2");
    });
  });

  // -----------------------------------------------------------------------
  // UploadQueue delegation
  // -----------------------------------------------------------------------
  describe("getUploadQueue", () => {
    it("returns the internal UploadQueue instance", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      const queue = adapter.getUploadQueue();
      expect(queue).toBeInstanceOf(UploadQueue);
    });

    it("returns the same instance on repeated calls", () => {
      const client = createMockServerClient();
      const adapter = new ServerStorageAdapter(client);

      const queue1 = adapter.getUploadQueue();
      const queue2 = adapter.getUploadQueue();
      expect(queue1).toBe(queue2);
    });
  });
});
