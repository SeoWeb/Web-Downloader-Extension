/**
 * Unit tests for upload content-type fallback (resolveUploadContentType).
 *
 * Production evidence (session bb03b08d): CSS url() resources (webp images,
 * woff2 fonts) were uploaded as application/octet-stream because their
 * responses carried no usable Content-Type and the storage adapter fell
 * back to the generic type without consulting the file extension.
 *
 * Covers:
 * - generic/missing types (empty, application/octet-stream) are inferred
 *   from the path/URL extension
 * - specific provided types pass through untouched
 * - the ServerStorageAdapter.addFile chokepoint applies the fallback
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveUploadContentType } from "../../src/background/urlUtils";
import { ServerStorageAdapter } from "../../src/background/storage/server-storage-adapter";
import { ServerClient } from "../../src/background/server-client";

describe("resolveUploadContentType", () => {
  it("infers image MIME from extension when type is octet-stream", () => {
    expect(
      resolveUploadContentType("images/photo.webp", "application/octet-stream"),
    ).toBe("image/webp");
    expect(
      resolveUploadContentType("images/photo.png", "application/octet-stream"),
    ).toBe("image/png");
    expect(
      resolveUploadContentType("images/photo.jpg", "application/octet-stream"),
    ).toBe("image/jpeg");
    expect(
      resolveUploadContentType("images/icon.svg", "application/octet-stream"),
    ).toBe("image/svg+xml");
  });

  it("infers font MIME from extension when type is empty", () => {
    expect(resolveUploadContentType("fonts/main.woff2", "")).toBe("font/woff2");
    expect(resolveUploadContentType("fonts/main.woff", "")).toBe("font/woff");
    expect(resolveUploadContentType("fonts/main.ttf", "")).toBe("font/ttf");
    expect(resolveUploadContentType("fonts/main.otf", "")).toBe("font/otf");
  });

  it("infers text/code MIME from extension when type is undefined", () => {
    expect(resolveUploadContentType("styles/main.css", undefined)).toBe(
      "text/css",
    );
    expect(resolveUploadContentType("scripts/app.js", undefined)).toBe(
      "application/javascript",
    );
    expect(resolveUploadContentType("scripts/app.mjs", undefined)).toBe(
      "application/javascript",
    );
    expect(resolveUploadContentType("data/config.json", undefined)).toBe(
      "application/json",
    );
    expect(resolveUploadContentType("docs/readme.txt", undefined)).toBe(
      "text/plain",
    );
    expect(resolveUploadContentType("docs/spec.pdf", undefined)).toBe(
      "application/pdf",
    );
  });

  it("strips query string and fragment before reading the extension", () => {
    expect(
      resolveUploadContentType("images/pic.webp?v=2#hash", undefined),
    ).toBe("image/webp");
  });

  it("keeps a specific provided type untouched", () => {
    expect(resolveUploadContentType("images/photo.webp", "image/png")).toBe(
      "image/png",
    );
    expect(
      resolveUploadContentType("styles/main.css", "text/css;charset=utf-8"),
    ).toBe("text/css;charset=utf-8");
  });

  it("falls back to octet-stream when no extension matches", () => {
    expect(resolveUploadContentType("bin/unknown", undefined)).toBe(
      "application/octet-stream",
    );
    expect(
      resolveUploadContentType("bin/unknown.xyz", "application/octet-stream"),
    ).toBe("application/octet-stream");
  });
});

describe("ServerStorageAdapter.addFile content-type fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("infers the content type from the path when the handler passes none", async () => {
    const adapter = new ServerStorageAdapter(new ServerClient());
    adapter.setSessionId("session-1");
    const enqueueSpy = vi
      .spyOn(adapter.getUploadQueue(), "enqueue")
      .mockResolvedValue("task-1");

    // CSS url() fetch path (css.ts downloadBackgroundImages): no MIME known.
    await adapter.addFile("images/bg.webp", new Blob([new Uint8Array([1])]));
    await adapter.addFile(
      "images/fonts/main.woff2",
      new Blob([new Uint8Array([1])]),
    );

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSpy.mock.calls[0][4]).toBe("image/webp");
    expect(enqueueSpy.mock.calls[1][4]).toBe("font/woff2");
  });

  it("upgrades an octet-stream pass-through via the path extension", async () => {
    const adapter = new ServerStorageAdapter(new ServerClient());
    adapter.setSessionId("session-1");
    const enqueueSpy = vi
      .spyOn(adapter.getUploadQueue(), "enqueue")
      .mockResolvedValue("task-1");

    await adapter.addFile(
      "images/photo.png",
      new Blob([new Uint8Array([1])]),
      "application/octet-stream",
    );

    expect(enqueueSpy.mock.calls[0][4]).toBe("image/png");
  });

  it("keeps a specific provided type untouched", async () => {
    const adapter = new ServerStorageAdapter(new ServerClient());
    adapter.setSessionId("session-1");
    const enqueueSpy = vi
      .spyOn(adapter.getUploadQueue(), "enqueue")
      .mockResolvedValue("task-1");

    await adapter.addFile("styles/main.css", new Blob(["body{}"]), "text/css");

    expect(enqueueSpy.mock.calls[0][4]).toBe("text/css");
  });
});
