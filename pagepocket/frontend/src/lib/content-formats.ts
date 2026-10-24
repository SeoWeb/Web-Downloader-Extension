/**
 * Viewer-side content-format derivation (text-native-downloads D1/D6).
 *
 * The API reports a page's stored formats as loose strings (`content_formats`);
 * the viewer turns that into its tab list using only the KNOWN values, in the
 * canonical switcher order (HTML | Markdown | Text). Unknown values and
 * missing fields degrade to fewer tabs — an older backend response parses and
 * renders exactly as before.
 */

export const CONTENT_FORMATS = ["html", "markdown", "text"] as const;

export type ContentFormat = (typeof CONTENT_FORMATS)[number];

/** Stored file name per format inside the page archive (R2 layout, D1). */
export const CONTENT_FILE_NAMES: Record<ContentFormat, string> = {
  html: "index.html",
  markdown: "index.md",
  text: "index.txt",
};

/**
 * Filter a page's raw `content_formats` down to the known viewer formats,
 * ordered canonically (html, markdown, text) regardless of stored order.
 */
export function knownContentFormats(
  raw: readonly string[] | null | undefined,
): ContentFormat[] {
  const present = new Set(raw ?? []);
  return CONTENT_FORMATS.filter((format) => present.has(format));
}

/**
 * True when the page must render as the bare legacy HTML iframe: no known
 * formats at all, or html as the only one ("Legacy page renders bare").
 */
export function isLegacyHtmlOnly(known: readonly ContentFormat[]): boolean {
  return known.length === 0 || (known.length === 1 && known[0] === "html");
}
