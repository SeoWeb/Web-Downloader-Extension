import type { MetadataRoute } from "next";

/**
 * Single source of truth for the public marketing site's URL surface.
 *
 * `app/sitemap.ts`, `app/robots.ts` and root metadata (metadataBase,
 * canonicals) all read from here so a route is registered once and emitted
 * consistently everywhere. Later phases (use-cases, compare, docs, changelog,
 * blog slugs) extend {@link MARKETING_ROUTES} in the same commit that adds
 * the pages — never list a route whose page does not exist yet.
 */

/** Production origin every canonical/OG/sitemap URL points at (design D1). */
export const MARKETING_SITE_URL = "https://pagepocket.app";

/** Path prefixes crawlers must never index; consumed by `app/robots.ts`. */
export const CRAWLER_DISALLOWED_PREFIXES = ["/app", "/s/", "/api/"] as const;

type SitemapEntry = MetadataRoute.Sitemap[number];

export type MarketingRoute = {
  /** Root-relative path, e.g. "/pricing". Must exist as a real page. */
  path: string;
  /** Sitemap priority (0–1). */
  priority: number;
  changeFrequency: SitemapEntry["changeFrequency"];
};

/**
 * Routes that exist after Phase 0. Privacy and terms land with the legal
 * pages; everything here must have a `page.tsx` in the same release.
 *
 * Phase 3 (content engine, design D6): the use-case, compare, docs,
 * changelog, about and blog-index routes below ship in the same batch as
 * this registry extension — the pages are created in parallel and land
 * together. Individual BLOG POST URLs are deliberately NOT listed here:
 * they are dynamic from the MDX content and appended in `app/sitemap.ts`
 * (via `src/lib/blog.ts`), which also keeps this registry statically
 * analyzable and importable from unit tests without pulling in content.
 */
export const MARKETING_ROUTES: readonly MarketingRoute[] = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/features", priority: 0.9, changeFrequency: "monthly" },
  { path: "/pricing", priority: 0.9, changeFrequency: "monthly" },
  { path: "/blog", priority: 0.7, changeFrequency: "weekly" },
  { path: "/use-cases", priority: 0.8, changeFrequency: "monthly" },
  { path: "/use-cases/researchers", priority: 0.8, changeFrequency: "monthly" },
  { path: "/use-cases/journalists", priority: 0.8, changeFrequency: "monthly" },
  { path: "/use-cases/developers", priority: 0.8, changeFrequency: "monthly" },
  { path: "/use-cases/archivists", priority: 0.8, changeFrequency: "monthly" },
  { path: "/compare", priority: 0.7, changeFrequency: "monthly" },
  { path: "/compare/singlefile", priority: 0.7, changeFrequency: "monthly" },
  { path: "/compare/wayback", priority: 0.7, changeFrequency: "monthly" },
  { path: "/compare/perma-cc", priority: 0.7, changeFrequency: "monthly" },
  { path: "/docs", priority: 0.7, changeFrequency: "monthly" },
  { path: "/changelog", priority: 0.5, changeFrequency: "weekly" },
  { path: "/about", priority: 0.6, changeFrequency: "monthly" },
  { path: "/privacy", priority: 0.3, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.3, changeFrequency: "yearly" },
];

/** Absolute production URL for a root-relative path. */
export function marketingUrl(path: string): string {
  return new URL(path, MARKETING_SITE_URL).toString();
}
