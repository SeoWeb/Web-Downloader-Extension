import type { MetadataRoute } from "next";
import {
  CRAWLER_DISALLOWED_PREFIXES,
  marketingUrl,
} from "@/lib/marketing-routes";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Keep the app shell, shared pages, and APIs out of indexes.
      disallow: [...CRAWLER_DISALLOWED_PREFIXES],
    },
    sitemap: marketingUrl("/sitemap.xml"),
  };
}
