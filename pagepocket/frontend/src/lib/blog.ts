import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType } from "react";

/**
 * Blog content engine (design D6).
 *
 * Posts live in `content/blog/*.mdx` at the frontend root and are read at
 * BUILD time only — every consumer (index page, post pages, sitemap,
 * generateStaticParams, OG image routes) runs on the server, so no client
 * JS is added to the routes.
 *
 * Metadata mechanism: each MDX file exports a `meta` constant (title,
 * description, ISO date, author, optional tags) and the slug is derived from
 * the filename. This follows the Next.js MDX guide's exported-constants
 * pattern (node_modules/next/dist/docs/01-app/02-guides/mdx.md —
 * "@next/mdx does allow you to use exports like any other JavaScript
 * component"). YAML frontmatter was tested and rejected: without the
 * remark-frontmatter plugin (a dependency outside the allowed minimum set),
 * the `---` block is compiled into the rendered page as a thematic break
 * plus its raw text.
 */

/** Directory holding the MDX posts, resolved from the frontend root. */
const POSTS_DIR = join(process.cwd(), "content", "blog");

/** Shape every post's `export const meta` must have. */
export type BlogPostMetaInput = {
  title: string;
  description: string;
  /** ISO date string, e.g. "2026-10-20". */
  date: string;
  author: string;
  tags?: string[];
};

/** A post summary as used by the index, sitemap, and prev/next navigation. */
export type BlogPostSummary = Omit<BlogPostMetaInput, "tags"> & {
  /** Normalised to always-present (empty when the post declares none). */
  tags: string[];
  /** URL slug, derived from the MDX filename. */
  slug: string;
  /** Reading time in whole minutes (minimum 1). */
  readingMinutes: number;
};

/** A full post: summary data plus the compiled MDX body component. */
export type BlogPost = BlogPostSummary & {
  /** Server component rendering the article body (RSC, no client JS). */
  Content: ComponentType;
};

type MdxPostModule = {
  default: ComponentType;
  meta: BlogPostMetaInput;
};

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maps "how-to-save-a-web-page-forever.mdx" → "how-to-save-a-web-page-forever". */
export function slugFromFilename(filename: string): string {
  return filename.replace(/\.mdx$/, "");
}

/** Defensive check before a slug is used in a dynamic import path. */
export function isValidPostSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * All post slugs from `content/blog`, alphabetically. Read via fs so
 * `generateStaticParams` needs no MDX compilation just to enumerate routes.
 */
export function getPostSlugs(): string[] {
  return readdirSync(POSTS_DIR)
    .filter((file) => file.endsWith(".mdx"))
    .map(slugFromFilename)
    .filter(isValidPostSlug)
    .sort();
}

/**
 * Strips markdown syntax so word counts reflect prose, not markup:
 * fenced/inline code, link URLs (keep the text), JSX/HTML tags, and
 * punctuation markers. Approximation is fine — reading time is a heuristic.
 */
export function countMarkdownWords(markdown: string): number {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*_~|]/g, " ");
  return text.split(/\s+/).filter(Boolean).length;
}

const WORDS_PER_MINUTE = 200;

/** Reading time in whole minutes from raw MDX text (minimum 1). */
export function readingMinutesFromText(mdx: string): number {
  return Math.max(1, Math.round(countMarkdownWords(mdx) / WORDS_PER_MINUTE));
}

function assertMeta(slug: string, meta: BlogPostMetaInput): void {
  const missing = (["title", "description", "date", "author"] as const).filter(
    (field) => !meta[field],
  );
  if (missing.length > 0 || !/^\d{4}-\d{2}-\d{2}$/.test(meta.date ?? "")) {
    throw new Error(
      `content/blog/${slug}.mdx: meta is missing required fields ` +
        `${missing.join(", ") || "(date must be ISO YYYY-MM-DD)"}. ` +
        "Every post must export const meta = { title, description, date, author, tags? }.",
    );
  }
}

async function loadSummary(slug: string): Promise<BlogPostSummary> {
  const [mod, raw] = await Promise.all([
    import(`../../content/blog/${slug}.mdx`) as Promise<MdxPostModule>,
    Promise.resolve(readFileSync(join(POSTS_DIR, `${slug}.mdx`), "utf8")),
  ]);
  assertMeta(slug, mod.meta);
  return {
    ...mod.meta,
    tags: mod.meta.tags ?? [],
    slug,
    readingMinutes: readingMinutesFromText(raw),
  };
}

/** Module-level cache: each post module is imported/compiled once per process. */
const summariesCache = new Map<string, Promise<BlogPostSummary>>();

async function loadSummaries(): Promise<BlogPostSummary[]> {
  const slugs = getPostSlugs();
  const missing = slugs.filter((slug) => !summariesCache.has(slug));
  for (const slug of missing) {
    summariesCache.set(
      slug,
      loadSummary(slug).catch((error: unknown) => {
        summariesCache.delete(slug);
        throw error;
      }),
    );
  }
  const summaries = await Promise.all(
    slugs.map((slug) => summariesCache.get(slug)!),
  );
  // Newest first; ties broken alphabetically for deterministic output.
  return summaries.sort(
    (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
  );
}

/**
 * All post summaries, newest first. Async because metadata is read from the
 * compiled MDX modules; every call site (pages, sitemap) is server-side and
 * build-time or statically prerendered.
 */
export async function getPostSummaries(): Promise<BlogPostSummary[]> {
  return loadSummaries();
}

/**
 * One post with its compiled MDX body, or null for unknown slugs.
 * (Combined with `dynamicParams = false` on /blog/[slug], unknown slugs 404.)
 */
export async function getPost(slug: string): Promise<BlogPost | null> {
  if (!isValidPostSlug(slug)) return null;
  const summaries = await loadSummaries();
  const summary = summaries.find((post) => post.slug === slug);
  if (!summary) return null;
  const mod = (await import(`../../content/blog/${slug}.mdx`)) as MdxPostModule;
  return { ...summary, Content: mod.default };
}

/** Chronologically neighbouring posts for prev/next navigation. */
export type AdjacentPosts = {
  /** Published more recently than this post. */
  newer: BlogPostSummary | null;
  /** Published earlier than this post. */
  older: BlogPostSummary | null;
};

export async function getAdjacentPosts(slug: string): Promise<AdjacentPosts> {
  const summaries = await loadSummaries();
  const index = summaries.findIndex((post) => post.slug === slug);
  if (index === -1) return { newer: null, older: null };
  return {
    newer: summaries[index - 1] ?? null,
    older: summaries[index + 1] ?? null,
  };
}

const OG_TITLE_MAX_CHARS_PER_LINE = 18;
const OG_TITLE_MAX_LINES = 3;

/**
 * Word-wraps a post title into short lines for the shared OG image layout
 * (76px headline on a 1200×630 canvas — the headline column fits roughly 18
 * characters per line and three lines). Returns a "\n"-joined string, with
 * an ellipsis when the title does not fit.
 */
export function wrapOgTitle(title: string): string {
  const lines: string[] = [];
  let current = "";
  let truncated = false;

  for (const word of title.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= OG_TITLE_MAX_CHARS_PER_LINE) {
      current = candidate;
      continue;
    }
    if (lines.length === OG_TITLE_MAX_LINES - 1) {
      // Last line: does the remaining text still fit?
      if (candidate.length <= OG_TITLE_MAX_CHARS_PER_LINE) {
        current = candidate;
      } else {
        truncated = true;
      }
      break;
    }
    lines.push(current);
    current = word;
    if (current.length > OG_TITLE_MAX_CHARS_PER_LINE) {
      truncated = true;
      break;
    }
  }
  if (!truncated && current) lines.push(current);

  let result = lines.join("\n");
  if (truncated) {
    result = `${result.slice(0, OG_TITLE_MAX_CHARS_PER_LINE * OG_TITLE_MAX_LINES - 1).trimEnd()}…`;
  }
  return result;
}

const OG_TAGLINE_MAX_CHARS = 80;

/** Truncates a post description to what fits the OG layout's tagline block. */
export function truncateOgTagline(description: string): string {
  if (description.length <= OG_TAGLINE_MAX_CHARS) return description;
  const slice = description.slice(0, OG_TAGLINE_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
}
