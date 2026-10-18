/**
 * Checkpoint keying tests (D4 / fix-archived-page-pipeline).
 *
 * The checkpoint storage is keyed PER DOWNLOAD (by server session id),
 * replacing the single global `downloadCheckpoint` key that concurrent
 * downloads clobbered. Verifies:
 * - two concurrent downloads keep independent manifests,
 * - manifest entries carry `size` (from the upload task),
 * - blobs are NEVER written to storage (metadata-only manifests),
 * - startup detection can enumerate all checkpoint keys,
 * - targeted clear removes only one download's checkpoint,
 * - the legacy global key is still readable/clearable (upgrade path).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  writeCheckpoint,
  readCheckpoint,
  readAllCheckpoints,
  updateCheckpointPhase,
  updateCheckpointResourceUrls,
  clearCheckpoint,
  type DownloadCheckpoint,
  type ResourceUrlEntry,
} from "../../src/background/download-checkpoint";

// ---------------------------------------------------------------------------
// In-memory chrome.storage.session
// ---------------------------------------------------------------------------

let store: Map<string, unknown>;

function installFakeChromeStorage(): void {
  const session = {
    get: async (
      keys?: string | string[] | null,
    ): Promise<Record<string, unknown>> => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      const wanted = typeof keys === "string" ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of wanted) {
        if (store.has(k)) out[k] = store.get(k);
      }
      return out;
    },
    set: async (objs: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(objs)) store.set(k, v);
    },
    remove: async (keys: string | string[]): Promise<void> => {
      for (const k of typeof keys === "string" ? [keys] : keys) {
        store.delete(k);
      }
    },
  };
  (globalThis as any).chrome = {
    ...((globalThis as any).chrome ?? {}),
    storage: { ...((globalThis as any).chrome?.storage ?? {}), session },
  };
}

const ENTRIES_A: ResourceUrlEntry[] = [
  {
    url: "https://example.com/a.png",
    path: "images/a.png",
    contentType: "image/png",
    size: 123,
  },
];

const ENTRIES_B: ResourceUrlEntry[] = [
  {
    url: "https://example.com/b.css",
    path: "styles/b.css",
    contentType: "text/css",
    size: 456,
  },
];

beforeEach(() => {
  store = new Map();
  installFakeChromeStorage();
});

afterEach(() => {
  delete (globalThis as any).chrome;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("download-checkpoint per-download keying (D4)", () => {
  it("writes each download's manifest under its own namespaced key", async () => {
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: "sess-A",
      tabId: 1,
      tabUrl: "https://example.com/a",
    });
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: "sess-B",
      tabId: 2,
      tabUrl: "https://example.com/b",
    });

    expect(store.has("downloadCheckpoint:sess-A")).toBe(true);
    expect(store.has("downloadCheckpoint:sess-B")).toBe(true);

    const a = await readCheckpoint("sess-A");
    const b = await readCheckpoint("sess-B");
    expect(a?.tabUrl).toBe("https://example.com/a");
    expect(b?.tabUrl).toBe("https://example.com/b");
    expect(a?.downloadInterrupted).toBe(true);
  });

  it("two concurrent downloads keep independent manifests", async () => {
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: "sess-A",
    });
    await writeCheckpoint({
      phase: "scraping",
      serverSessionId: "sess-B",
    });

    await updateCheckpointResourceUrls(ENTRIES_A, "sess-A");
    await updateCheckpointResourceUrls(ENTRIES_B, "sess-B");
    await updateCheckpointPhase("uploading", "sess-B");

    const a = await readCheckpoint("sess-A");
    const b = await readCheckpoint("sess-B");

    // A untouched by B's phase update
    expect(a?.phase).toBe("scraping");
    expect(a?.resourceUrls).toEqual(ENTRIES_A);
    expect(b?.phase).toBe("uploading");
    expect(b?.resourceUrls).toEqual(ENTRIES_B);
  });

  it("manifest entries persist size and storage never contains blobs", async () => {
    await writeCheckpoint({
      phase: "uploading",
      serverSessionId: "sess-A",
    });
    await updateCheckpointResourceUrls(ENTRIES_A, "sess-A");

    const a = await readCheckpoint("sess-A");
    expect(a?.resourceUrls?.[0]?.size).toBe(123);

    // Every stored value must be plain JSON metadata — no Blob instances
    // anywhere (design D4.4: blobs are never persisted).
    for (const value of store.values()) {
      const seen: unknown[] = [value];
      while (seen.length > 0) {
        const current = seen.pop();
        expect(current).not.toBeInstanceOf(Blob);
        if (current && typeof current === "object") {
          seen.push(...Object.values(current as Record<string, unknown>));
        }
      }
      expect(() => JSON.stringify(value)).not.toThrow();
    }
  });

  it("startup detection enumerates all checkpoint keys, newest first", async () => {
    // Seed directly to control timestamps
    store.set("downloadCheckpoint:sess-old", {
      downloadInterrupted: true,
      serverSessionId: "sess-old",
      phase: "scraping",
      timestamp: 1000,
    } satisfies DownloadCheckpoint);
    store.set("downloadCheckpoint:sess-new", {
      downloadInterrupted: true,
      serverSessionId: "sess-new",
      phase: "uploading",
      timestamp: 2000,
    } satisfies DownloadCheckpoint);

    const all = await readAllCheckpoints();
    expect(all).toHaveLength(2);
    expect(all[0]?.serverSessionId).toBe("sess-new");
    expect(all[1]?.serverSessionId).toBe("sess-old");
  });

  it("readCheckpoint() without an id returns the newest checkpoint (panel flow)", async () => {
    store.set("downloadCheckpoint:sess-old", {
      downloadInterrupted: true,
      serverSessionId: "sess-old",
      phase: "scraping",
      timestamp: 1000,
    });
    store.set("downloadCheckpoint:sess-new", {
      downloadInterrupted: true,
      serverSessionId: "sess-new",
      phase: "uploading",
      timestamp: 2000,
    });

    expect((await readCheckpoint())?.serverSessionId).toBe("sess-new");
  });

  it("targeted clearCheckpoint removes only that download's checkpoint", async () => {
    await writeCheckpoint({ phase: "scraping", serverSessionId: "sess-A" });
    await writeCheckpoint({ phase: "scraping", serverSessionId: "sess-B" });

    await clearCheckpoint("sess-A");

    expect(await readCheckpoint("sess-A")).toBeNull();
    expect(await readCheckpoint("sess-B")).not.toBeNull();
  });

  it("clearCheckpoint() without an id clears every checkpoint key", async () => {
    await writeCheckpoint({ phase: "scraping", serverSessionId: "sess-A" });
    await writeCheckpoint({ phase: "scraping", serverSessionId: "sess-B" });

    await clearCheckpoint();

    expect(await readAllCheckpoints()).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("a write without a server session id falls back to the legacy global key", async () => {
    await writeCheckpoint({ phase: "scraping" });

    expect(store.has("downloadCheckpoint")).toBe(true);
    expect((await readCheckpoint())?.phase).toBe("scraping");
  });

  it("legacy global-key checkpoints (older extension version) remain discoverable and clearable", async () => {
    store.set("downloadCheckpoint", {
      downloadInterrupted: true,
      serverSessionId: "sess-legacy",
      phase: "uploading",
      timestamp: 500,
    });

    const all = await readAllCheckpoints();
    expect(all).toHaveLength(1);
    expect(all[0]?.serverSessionId).toBe("sess-legacy");

    // Targeted clear by the legacy checkpoint's session id removes it —
    // clearCheckpoint maps a session id to BOTH its namespaced key and,
    // when targeted, the legacy entry written before per-download keying.
    await clearCheckpoint("sess-legacy");
    expect(await readAllCheckpoints()).toHaveLength(0);
  });
});
