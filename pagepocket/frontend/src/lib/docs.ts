import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType } from "react";
import type { FaqItem } from "@/components/marketing/faq-list";

/**
 * Docs content engine (design D6) — the blog engine's (src/lib/blog.ts)
 * mechanism applied to the documentation section, with docs-specific
 * ordering and FAQ payloads.
 *
 * Pages live in `content/docs/*.mdx` at the frontend root and are read at
 * BUILD time only — every consumer (index page, doc pages, sitemap,
 * generateStaticParams, OG image routes) runs on the server, so no client
 * JS is added to the routes.
 *
 * Metadata mechanism (same as the blog): each MDX file exports a `meta`
 * constant (title, description, ISO date) and the slug is derived from the
 * filename. Docs are NOT date-ordered — reading order matters — so
 * {@link DOC_ORDER} pins the canonical table-of-contents order and the
 * loader fails the build if the directory and the TOC ever disagree.
 */

/** Directory holding the MDX doc pages, resolved from the frontend root. */
const DOCS_DIR = join(process.cwd(), "content", "docs");

/** Shape every doc's `export const meta` must have. */
export type DocMetaInput = {
  title: string;
  description: string;
  /** ISO date of the last substantial update, e.g. "2026-10-20". */
  date: string;
};

/** A doc summary as used by the index, prev/next navigation, and OG images. */
export type DocSummary = DocMetaInput & {
  /** URL slug, derived from the MDX filename. */
  slug: string;
};

/** A full doc page: summary data plus the compiled MDX body component. */
export type Doc = DocSummary & {
  /** Server component rendering the doc body (RSC, no client JS). */
  Content: ComponentType;
};

/** Optional per-doc FAQ, rendered with `FaqList` (which emits FAQPage JSON-LD). */
export type DocFaq = { slug: string; items: readonly FaqItem[] };

/**
 * Canonical reading order for the docs section — the index, prev/next
 * navigation, and the sitemap registry all follow this order. Every file
 * in `content/docs` MUST appear here exactly once (asserted by
 * {@link assertDocOrderCoversDirectory} at load time).
 */
export const DOC_ORDER: readonly string[] = [
  "getting-started",
  "saving-pages",
  "collections",
  "full-text-search",
  "sharing",
  "troubleshooting",
];

/** FAQs rendered (and marked up as FAQPage) on specific doc pages. */
export const DOC_FAQS: readonly DocFaq[] = [
  {
    slug: "getting-started",
    items: [
      {
        question: "What does PagePocket cost?",
        answer:
          "The Free plan covers 50 page saves per rolling 30 days with 500 MB of storage — no credit card required. Search, collections, and share links are included. Pro is $2/month (billed yearly, $24/yr) when you need a bigger library: more saves and 10 GB of storage.",
      },
      {
        question: "Do the people I share with need an account?",
        answer:
          "No. Anyone with your share link can open the saved page — no PagePocket account, no sign-up. Until you create a share link, your library is visible only to you.",
      },
      {
        question: "Can I read my saved pages offline?",
        answer:
          "Opening a saved page in the viewer needs a connection — that is what makes it available on every device you sign in from. But you can download any saved page as a ZIP from your dashboard (viewer toolbar or page menu) and read that copy offline. You can also export a copy to your computer as a ZIP or single-file HTML at save time by turning cloud storage off in the extension panel.",
      },
      {
        question: "Is PagePocket available for Firefox or Edge?",
        answer:
          "Currently PagePocket ships as a Chrome extension, installable from the Chrome Web Store. The library itself is a website, so saved pages can be read and shared from any modern browser.",
      },
    ],
  },
];

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maps "getting-started.mdx" → "getting-started". */
export function slugFromDocFilename(filename: string): string {
  return filename.replace(/\.mdx$/, "");
}

/** Defensive check before a slug is used in a dynamic import path. */
export function isValidDocSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** All doc slugs from `content/docs`, alphabetically. Read via fs so
 * `generateStaticParams` needs no MDX compilation just to enumerate routes. */
export function getDocSlugs(): string[] {
  const slugs = readdirSync(DOCS_DIR)
    .filter((file) => file.endsWith(".mdx"))
    .map(slugFromDocFilename)
    .filter(isValidDocSlug)
    .sort();
  assertDocOrderCoversDirectory(slugs);
  return slugs;
}

/**
 * Build-time contract: the TOC and the content directory must agree —
 * every doc file is listed in DOC_ORDER, and every DOC_ORDER entry has a
 * file. A mismatch is an authoring error we want to fail loudly, not a doc
 * that silently disappears from the index or a card that 404s.
 */
export function assertDocOrderCoversDirectory(slugs: string[]): void {
  const listed = new Set(slugs);
  const order = new Set(DOC_ORDER);
  const missingFromOrder = slugs.filter((slug) => !order.has(slug));
  const missingOnDisk = DOC_ORDER.filter((slug) => !listed.has(slug));
  if (missingFromOrder.length > 0 || missingOnDisk.length > 0) {
    throw new Error(
      `content/docs and DOC_ORDER disagree. ` +
        (missingFromOrder.length > 0
          ? `Not in DOC_ORDER: ${missingFromOrder.join(", ")}. `
          : "") +
        (missingOnDisk.length > 0
          ? `No MDX file for: ${missingOnDisk.join(", ")}.`
          : ""),
    );
  }
}

function assertMeta(slug: string, meta: DocMetaInput): void {
  const missing = (["title", "description", "date"] as const).filter(
    (field) => !meta[field],
  );
  if (missing.length > 0 || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? "")) {
    throw new Error(
      `content/docs/${slug}.mdx: meta is missing required fields ` +
        `${missing.join(", ") || "(date must be ISO YYYY-MM-DD)"}. ` +
        "Every doc must export const meta = { title, description, date }.",
    );
  }
}

type MdxDocModule = {
  default: ComponentType;
  meta: DocMetaInput;
};

/** Module-level cache: each doc module is imported/compiled once per process. */
const summariesCache = new Map<string, Promise<DocSummary>>();

async function loadSummary(slug: string): Promise<DocSummary> {
  const cached = summariesCache.get(slug);
  if (cached) return cached;
  const promise = (async () => {
    const mod = (await import(
      `../../content/docs/${slug}.mdx`
    )) as MdxDocModule;
    assertMeta(slug, mod.meta);
    return { ...mod.meta, slug };
  })();
  promise.catch(() => summariesCache.delete(slug));
  summariesCache.set(slug, promise);
  return promise;
}

/**
 * All doc summaries in {@link DOC_ORDER} (reading order, not date order).
 * Async because metadata is read from the compiled MDX modules; every call
 * site (pages, sitemap) is server-side and statically prerendered.
 */
export async function getDocSummaries(): Promise<DocSummary[]> {
  return Promise.all(DOC_ORDER.map((slug) => loadSummary(slug)));
}

/**
 * One doc with its compiled MDX body, or null for unknown slugs.
 * (Combined with `dynamicParams = false` on /docs/[slug], unknown slugs 404.)
 */
export async function getDoc(slug: string): Promise<Doc | null> {
  if (!isValidDocSlug(slug)) return null;
  if (!DOC_ORDER.includes(slug)) return null;
  const summaries = await getDocSummaries();
  const summary = summaries.find((doc) => doc.slug === slug);
  if (!summary) return null;
  const mod = (await import(`../../content/docs/${slug}.mdx`)) as MdxDocModule;
  return { ...summary, Content: mod.default };
}

/** Neighbouring docs in reading order, for prev/next navigation (slugs —
 * resolve via {@link getDocSummaries}). */
export type AdjacentDocs = {
  /** Earlier in the TOC — the previous page a reader should see. */
  previous: string | null;
  /** Later in the TOC. */
  next: string | null;
};

export function getAdjacentDocs(slug: string): AdjacentDocs {
  const index = DOC_ORDER.indexOf(slug);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: DOC_ORDER[index - 1] ?? null,
    next: DOC_ORDER[index + 1] ?? null,
  };
}

/** FAQs for a doc page (empty array when the page declares none). */
export function getDocFaqs(slug: string): readonly FaqItem[] {
  return DOC_FAQS.find((faq) => faq.slug === slug)?.items ?? [];
}
