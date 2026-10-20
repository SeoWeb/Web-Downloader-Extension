/**
 * JsonLd — RSC-safe structured-data renderer (design D5).
 *
 * Server component (no "use client"): renders a native
 * `<script type="application/ld+json">`, which is the recommended approach
 * per the Next.js JSON-LD guide (node_modules/next/dist/docs/01-app/02-guides/json-ld.md).
 * `next/script` is for executable JS and must NOT be used for structured data.
 *
 * Accepts a single JSON-LD object or an array (e.g. SoftwareApplication +
 * Organization site-wide, or BreadcrumbList + FAQPage on one route).
 *
 * Escape-safety: `JSON.stringify` does not sanitise strings, so `<` is
 * replaced with its unicode escape to make `</script>` breakout impossible.
 * The output stays valid JSON — crawlers parse the decoded original values.
 */

export type JsonLdObject = Record<string, unknown>;
export type JsonLdData = JsonLdObject | JsonLdObject[];

export function jsonLdScriptContent(data: JsonLdData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function JsonLd({ data }: { data: JsonLdData }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: jsonLdScriptContent(data) }}
    />
  );
}
