import type { MetadataRoute } from "next";
import { MARKETING_ROUTES, marketingUrl } from "@/lib/marketing-routes";
import { getPostSummaries } from "@/lib/blog";

/**
 * Build-generated sitemap, driven by the shared marketing route registry so
 * new phases extend it by adding one entry (plus the page). Blog post URLs
 * are appended from the MDX content (`content/blog/*.mdx`) at build time —
 * each post carries its publish date as lastModified (design D5/D6).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();

  const staticRoutes: MetadataRoute.Sitemap = MARKETING_ROUTES.map((route) => ({
    url: marketingUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const blogPosts: MetadataRoute.Sitemap = (await getPostSummaries()).map(
    (post) => ({
      url: marketingUrl(`/blog/${post.slug}`),
      lastModified: new Date(post.date),
      changeFrequency: "monthly",
      priority: 0.6,
    }),
  );

  return [...staticRoutes, ...blogPosts];
}
