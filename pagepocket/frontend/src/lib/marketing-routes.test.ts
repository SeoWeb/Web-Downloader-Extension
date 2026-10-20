import { describe, it, expect } from "vitest";
import {
  CRAWLER_DISALLOWED_PREFIXES,
  MARKETING_ROUTES,
  MARKETING_SITE_URL,
  marketingUrl,
} from "./marketing-routes";

describe("marketing-routes — sitemap/robots contract", () => {
  it("production origin is the canonical bare URL", () => {
    expect(MARKETING_SITE_URL).toBe("https://pagepocket.app");
  });

  it("every route path is root-relative, normalised, and unique", () => {
    const paths = MARKETING_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toMatch(/\/{2,}/);
      if (path !== "/") expect(path.endsWith("/")).toBe(false);
    }
  });

  it("no sitemap route sits in a robots-disallowed area (no 404 or private entries)", () => {
    for (const route of MARKETING_ROUTES) {
      for (const prefix of CRAWLER_DISALLOWED_PREFIXES) {
        expect(route.path.startsWith(prefix)).toBe(false);
      }
    }
  });

  it("priorities are within the 0–1 sitemap range", () => {
    for (const route of MARKETING_ROUTES) {
      expect(route.priority).toBeGreaterThanOrEqual(0);
      expect(route.priority).toBeLessThanOrEqual(1);
    }
  });

  it("marketingUrl composes absolute production URLs", () => {
    expect(marketingUrl("/")).toBe("https://pagepocket.app/");
    expect(marketingUrl("/pricing")).toBe("https://pagepocket.app/pricing");
    expect(marketingUrl("/sitemap.xml")).toBe(
      "https://pagepocket.app/sitemap.xml",
    );
  });
});

describe("marketing-routes — phase-3 content surface (design D6)", () => {
  it("registers every route landing in this batch", () => {
    const paths = new Set(MARKETING_ROUTES.map((r) => r.path));
    const expected = [
      "/blog",
      "/use-cases",
      "/use-cases/researchers",
      "/use-cases/journalists",
      "/use-cases/developers",
      "/use-cases/archivists",
      "/compare",
      "/compare/singlefile",
      "/compare/wayback",
      "/compare/perma-cc",
      "/docs",
      "/changelog",
      "/about",
    ];
    for (const path of expected) {
      expect(paths.has(path)).toBe(true);
    }
  });

  it("blog post URLs stay out of the registry (dynamic from MDX content via app/sitemap.ts)", () => {
    const paths = MARKETING_ROUTES.map((r) => r.path);
    expect(paths.filter((path) => path.startsWith("/blog/"))).toEqual([]);
  });
});
