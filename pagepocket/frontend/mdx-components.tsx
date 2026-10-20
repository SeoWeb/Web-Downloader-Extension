import type { MDXComponents } from "mdx/types";

/**
 * Global MDX component map (required for `@next/mdx` with App Router —
 * see node_modules/next/dist/docs/01-app/02-guides/mdx.md).
 *
 * Intentionally empty of overrides: long-form article styling lives in the
 * scoped `.prose-blog` class in `src/app/globals.css`, so MDX renders plain
 * semantic HTML with zero client-side JavaScript (design D6 — RSC rendering
 * keeps the 120 KB/route budget intact). When a post later needs to embed a
 * React component (e.g. `next/image` screenshots), map it here.
 */
const components: MDXComponents = {};

export function useMDXComponents(): MDXComponents {
  return components;
}
