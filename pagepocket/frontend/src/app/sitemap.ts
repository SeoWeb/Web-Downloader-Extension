import type { MetadataRoute } from "next";
import { MARKETING_ROUTES, marketingUrl } from "@/lib/marketing-routes";

/**
 * Build-generated sitemap, driven entirely by the shared marketing route
 * registry so new phases extend it by adding one entry (plus the page).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return MARKETING_ROUTES.map((route) => ({
    url: marketingUrl(route.path),
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
