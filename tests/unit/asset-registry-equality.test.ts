/**
 * Asset registry path-equality tests (task 4.1 / remainder of 3.2).
 *
 * The asset registry (and the per-download filename-map bookkeeping) must
 * build its keys with the SAME buildArchivePath the file handlers use for
 * upload paths — registry keys equal uploaded paths. Before D5 the registry
 * used basename-only `styles/${fixFilename(url)}` paths while uploads went
 * elsewhere, so the registry metadata was inconsistent.
 */

import { AssetRegistry, buildArchivePath as registryBuildArchivePath } from "../../src/background/asset-registry";
import { buildArchivePath as canonicalBuildArchivePath } from "../../src/background/urlUtils";

describe("asset registry path equality (tasks 4.1 + 3.2)", () => {
  it("delegates to the canonical buildArchivePath in urlUtils", () => {
    const samples: Array<[string, string]> = [
      ["https://host/main.css", "styles"],
      ["https://host/assets/js/app.js?v=3", "scripts"],
      ["https://host/dir/page/img/photo.png", "images"],
      ["https://host/files/manual.pdf", "documents"],
    ];

    for (const [url, category] of samples) {
      expect(registryBuildArchivePath(url, category)).toBe(
        canonicalBuildArchivePath(url, category),
      );
    }
  });

  it("registry keys equal the paths handlers upload to (round-trip)", () => {
    const registry = new AssetRegistry();
    const url = "https://host/assets/vendor/theme/buttons.css";
    const uploadPath = canonicalBuildArchivePath(url, "styles");

    registry.register(url, uploadPath, 0);

    expect(registry.has(url)).toBe(true);
    expect(registry.get(url)?.localPath).toBe(uploadPath);
    expect(registry.get(url)?.localPath).toBe(
      "styles/assets/vendor/theme/buttons.css",
    );
  });

  it("same-basename assets from different directories register distinctly", () => {
    const registry = new AssetRegistry();
    const a = "https://host/a/main.css";
    const b = "https://host/b/main.css";

    const pathA = canonicalBuildArchivePath(a, "styles");
    const pathB = canonicalBuildArchivePath(b, "styles");

    expect(pathA).not.toBe(pathB);

    registry.register(a, pathA, 0);
    registry.register(b, pathB, 0);

    expect(registry.get(a)?.localPath).toBe("styles/a/main.css");
    expect(registry.get(b)?.localPath).toBe("styles/b/main.css");
    expect(registry.size()).toBe(2);
  });

  it("registry dedup keys survive absolute-URL resolution like the scraper's filter", () => {
    // The linked-page dedup filter resolves relative hrefs against the
    // document URL before consulting the registry — the registry must be
    // keyed by the same absolute URL (task 1.6).
    const registry = new AssetRegistry();
    const documentUrl = "https://host/dir/page.html";
    const absolute = new URL("theme/style.css", documentUrl).href;

    registry.register(
      absolute,
      canonicalBuildArchivePath(absolute, "styles"),
      0,
    );

    // A second page whose relative reference resolves to the same absolute
    // URL produces the same registry key → dedup hits.
    const sameFromOtherPage = new URL(
      "theme/style.css",
      "https://host/dir/other.html",
    ).href;
    expect(sameFromOtherPage).toBe(absolute);
    expect(registry.has(sameFromOtherPage)).toBe(true);
  });

  it("query-string variants register as distinct registry entries", () => {
    const registry = new AssetRegistry();
    const v1 = "https://host/w/load.php?modules=site.styles";
    const v2 = "https://host/w/load.php?modules=more.styles";

    const p1 = canonicalBuildArchivePath(v1, "styles");
    const p2 = canonicalBuildArchivePath(v2, "styles");

    expect(p1).not.toBe(p2);

    registry.register(v1, p1, 0);
    registry.register(v2, p2, 0);

    expect(registry.size()).toBe(2);
    expect(registry.has(v1)).toBe(true);
    expect(registry.has(v2)).toBe(true);
  });
});
