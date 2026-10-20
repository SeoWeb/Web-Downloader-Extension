import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType } from "react";

/**
 * Changelog content engine (design D6).
 *
 * Entries live in `content/changelog/*.mdx` at the frontend root and are
 * read at BUILD time only; the /changelog page is a static RSC listing, so
 * no client JS is added to the route.
 *
 * Metadata mechanism (same as the blog and docs engines): each MDX file
 * exports a `meta` constant (title, ISO date) and the slug is derived from
 * the filename. Entries are rendered newest-first on a single listing page
 * (there are no per-entry routes, and the sitemap only carries /changelog).
 *
 * Content policy: entries are user-visible HIGHLIGHTS translated from the
 * project's development history — written in product language, never commit
 * messages or hashes, never internal tooling noise.
 */

/** Directory holding the MDX changelog entries, resolved from the frontend root. */
const CHANGELOG_DIR = join(process.cwd(), "content", "changelog");

/** Shape every entry's `export const meta` must have. */
export type ChangelogMetaInput = {
  title: string;
  /** ISO date the entry describes, e.g. "2026-10-20". */
  date: string;
};

/** A changelog entry: metadata plus the compiled MDX body component. */
export type ChangelogEntry = ChangelogMetaInput & {
  /** URL slug, derived from the MDX filename (unused in routes; ids/keys). */
  slug: string;
  /** Server component rendering the entry body (RSC, no client JS). */
  Content: ComponentType;
};

type MdxEntryModule = {
  default: ComponentType;
  meta: ChangelogMetaInput;
};

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maps "2026-10-cloud-library-launch.mdx" → "2026-10-cloud-library-launch". */
export function slugFromChangelogFilename(filename: string): string {
  return filename.replace(/\.mdx$/, "");
}

/** Defensive check before a slug is used in a dynamic import path. */
export function isValidChangelogSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/** All entry slugs from `content/changelog`, alphabetically. */
export function getChangelogSlugs(): string[] {
  return readdirSync(CHANGELOG_DIR)
    .filter((file) => file.endsWith(".mdx"))
    .map(slugFromChangelogFilename)
    .filter(isValidChangelogSlug)
    .sort();
}

function assertMeta(slug: string, meta: ChangelogMetaInput): void {
  const missing = (["title", "date"] as const).filter((field) => !meta[field]);
  if (missing.length > 0 || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? "")) {
    throw new Error(
      `content/changelog/${slug}.mdx: meta is missing required fields ` +
        `${missing.join(", ") || "(date must be ISO YYYY-MM-DD)"}. ` +
        "Every entry must export const meta = { title, date }.",
    );
  }
}

/** Module-level cache: each entry module is imported/compiled once per process. */
const entriesCache = new Map<string, Promise<ChangelogEntry>>();

async function loadEntry(slug: string): Promise<ChangelogEntry> {
  const cached = entriesCache.get(slug);
  if (cached) return cached;
  const promise = (async () => {
    const mod = (await import(
      `../../content/changelog/${slug}.mdx`
    )) as MdxEntryModule;
    assertMeta(slug, mod.meta);
    return { ...mod.meta, slug, Content: mod.default };
  })();
  promise.catch(() => entriesCache.delete(slug));
  entriesCache.set(slug, promise);
  return promise;
}

/**
 * All entries, newest first (ties broken alphabetically for deterministic
 * output). Async because metadata is read from the compiled MDX modules;
 * the call site (/changelog page) is server-side and statically prerendered.
 */
export async function getChangelogEntries(): Promise<ChangelogEntry[]> {
  const slugs = getChangelogSlugs();
  const missing = slugs.filter((slug) => !entriesCache.has(slug));
  for (const slug of missing) {
    loadEntry(slug).catch(() => {
      /* loadEntry already removed the failed promise from the cache */
    });
  }
  const entries = await Promise.all(slugs.map((slug) => loadEntry(slug)));
  return entries.sort(
    (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
  );
}
