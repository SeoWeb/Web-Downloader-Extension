/**
 * Site-wide JSON-LD payloads (design D5, task 5.1): Organization +
 * SoftwareApplication, emitted once by the (marketing) layout so every
 * marketing page carries them. They render as their own ld+json script,
 * separate from the per-page FAQPage / BlogPosting / BreadcrumbList
 * scripts — multiple ld+json scripts on one page are valid and standard,
 * and the @types here do not overlap the per-page ones.
 *
 * Honesty policy (design D2/D3): no `aggregateRating` until the Chrome Web
 * Store listing shows real, citable ratings; no `contactPoint` because
 * there is no published contact channel to link to.
 */

import type { JsonLdObject } from "@/components/marketing/json-ld";
import { marketingUrl } from "@/lib/marketing-routes";

/** Open-source repo — linked from the footer and used as sameAs identity. */
export const GITHUB_REPO_URL =
  "https://github.com/SeoWeb/Web-Downloader-Extension";

/**
 * Chrome Web Store listing. The slug still reads "web-page-downloader":
 * the store-side rename to PagePocket is a user action (see the change
 * handoff doc, §Store listing) — the URL itself is stable.
 */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk";

/** Largest icon actually shipped in public/icons/ (OG-safe 256×256). */
const ORG_LOGO_PATH = "/icons/256x256.png";

export function organizationJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "PagePocket",
    url: marketingUrl("/"),
    logo: marketingUrl(ORG_LOGO_PATH),
    sameAs: [GITHUB_REPO_URL],
  };
}

export function softwareApplicationJsonLd(): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "PagePocket",
    // "BrowserApplication" is one of the enumerated applicationCategory
    // values accepted for SoftwareApplication (Google-supported list).
    applicationCategory: "BrowserApplication",
    operatingSystem: "Chrome/Chromium",
    url: marketingUrl("/"),
    sameAs: [CHROME_WEB_STORE_URL],
    description:
      "Browser extension for saving full-fidelity copies of web pages to a private, searchable library you can share with a simple link.",
    offers: [
      {
        "@type": "Offer",
        name: "Free",
        price: "0",
        priceCurrency: "USD",
      },
      {
        "@type": "Offer",
        name: "Pro (billed yearly)",
        price: "24",
        priceCurrency: "USD",
        url: marketingUrl("/pricing"),
      },
    ],
  };
}

/** Both site-wide objects, in render order, for the (marketing) layout. */
export function siteJsonLd(): JsonLdObject[] {
  return [organizationJsonLd(), softwareApplicationJsonLd()];
}
