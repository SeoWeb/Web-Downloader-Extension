/**
 * Unit tests for buildArchivePath (OpenSpec task 3.2, design D5).
 *
 * Covers:
 * - two same-basename files from different directories produce distinct paths
 * - query strings are hashed into the filename so variants never collide
 * - the same URL is stable/idempotent
 * - directory structure is preserved under the category prefix
 */

import { describe, expect, it } from "vitest";
import { buildArchivePath } from "../../src/background/urlUtils";

describe("buildArchivePath", () => {
  it("keeps the category prefix convention", () => {
    expect(buildArchivePath("https://host/main.css", "styles")).toBe(
      "styles/main.css",
    );
    expect(buildArchivePath("https://host/app.js", "scripts")).toBe(
      "scripts/app.js",
    );
    expect(buildArchivePath("https://host/pic.png", "images")).toBe(
      "images/pic.png",
    );
    expect(buildArchivePath("https://host/report.pdf", "documents")).toBe(
      "documents/report.pdf",
    );
  });

  it("preserves the URL's directory structure under the category prefix", () => {
    expect(
      buildArchivePath("https://host/assets/vendor/theme/buttons.css", "styles"),
    ).toBe("styles/assets/vendor/theme/buttons.css");
  });

  it("produces distinct paths for same-basename files from different directories", () => {
    const a = buildArchivePath("https://host/a/main.css", "styles");
    const b = buildArchivePath("https://host/b/main.css", "styles");
    expect(a).toBe("styles/a/main.css");
    expect(b).toBe("styles/b/main.css");
    expect(a).not.toBe(b);
  });

  it("hashes query strings into the filename so variants never collide", () => {
    const v1 = buildArchivePath("https://host/w/x.css?v=1", "styles");
    const v2 = buildArchivePath("https://host/w/x.css?v=2", "styles");
    expect(v1).toMatch(/^styles\/w\/x_[0-9a-f]{8}\.css$/);
    expect(v2).toMatch(/^styles\/w\/x_[0-9a-f]{8}\.css$/);
    expect(v1).not.toBe(v2);
  });

  it("distinguishes MediaWiki-style load.php query variants", () => {
    const styles = buildArchivePath(
      "https://host/w/load.php?modules=site.styles&only=styles",
      "styles",
    );
    const scripts = buildArchivePath(
      "https://host/w/load.php?modules=site.scripts&only=scripts",
      "styles",
    );
    expect(styles).toMatch(/^styles\/w\/load_[0-9a-f]{8}\.php$/);
    expect(scripts).toMatch(/^styles\/w\/load_[0-9a-f]{8}\.php$/);
    expect(styles).not.toBe(scripts);
  });

  it("is stable/idempotent for the same URL", () => {
    const url = "https://host/dir/page/img/photo.png?w=640&h=480";
    expect(buildArchivePath(url, "images")).toBe(
      buildArchivePath(url, "images"),
    );
  });

  it("applies the category default extension for extension-less filenames", () => {
    expect(buildArchivePath("https://host/cdn/js/main", "scripts")).toBe(
      "scripts/cdn/js/main.js",
    );
    expect(buildArchivePath("https://host/generated/style", "styles")).toBe(
      "styles/generated/style.css",
    );
    expect(buildArchivePath("https://host/files/blob", "documents")).toBe(
      "documents/files/blob.bin",
    );
  });

  it("honors an explicit defaultExtension (e.g. from a Content-Type sniff)", () => {
    expect(
      buildArchivePath("https://host/img/unknown", "images", {
        defaultExtension: "png",
      }),
    ).toBe("images/img/unknown.png");
  });

  it("keeps the URL-provided extension over the default", () => {
    expect(
      buildArchivePath("https://host/img/pic.jpg", "images", {
        defaultExtension: "png",
      }),
    ).toBe("images/img/pic.jpg");
  });

  it("percent-decodes and sanitizes path segments", () => {
    expect(
      buildArchivePath(
        "https://host/my%20docs/wei%20rd/file%20name.png",
        "images",
      ),
    ).toBe("images/my-docs/wei-rd/file-name.png");
    // Encoded slashes stay inside one segment (become dashes), never
    // introduce new directories.
    expect(
      buildArchivePath("https://host/dir/a%2Fb/file.png", "images"),
    ).toBe("images/dir/a-b/file.png");
  });

  it("strips 'undefined' prefixes from broken JS-generated URLs", () => {
    expect(buildArchivePath("https://host/undefinedfoo.css", "styles")).toBe(
      "styles/foo.css",
    );
  });

  it("treats directory-style URLs as index pages", () => {
    expect(buildArchivePath("https://host/blog/", "documents")).toBe(
      "documents/blog/index.bin",
    );
    expect(buildArchivePath("https://host/", "styles")).toBe(
      "styles/index.css",
    );
  });

  it("never escapes through '..' segments", () => {
    // new URL() normalizes dot segments before the builder sees them, and
    // the category prefix is always prepended, so paths stay in-bucket.
    const path = buildArchivePath("https://host/a/../../etc/passwd", "documents");
    expect(path).toBe("documents/etc/passwd.bin");
    expect(path.startsWith("documents/")).toBe(true);
  });

  it("handles invalid input without throwing", () => {
    const path = buildArchivePath("not a url", "styles");
    expect(path).toMatch(/^styles\//);
    // Same input is still deterministic.
    expect(path).toBe(buildArchivePath("not a url", "styles"));
  });
});
