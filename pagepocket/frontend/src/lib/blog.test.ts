import { describe, it, expect } from "vitest";
import {
  countMarkdownWords,
  isValidPostSlug,
  readingMinutesFromText,
  slugFromFilename,
  truncateOgTagline,
  wrapOgTitle,
} from "./blog";

describe("blog — slug helpers", () => {
  it("derives slugs from .mdx filenames", () => {
    expect(slugFromFilename("how-to-save-a-web-page-forever.mdx")).toBe(
      "how-to-save-a-web-page-forever",
    );
  });

  it("accepts only safe kebab-case slugs (defence before dynamic import)", () => {
    expect(isValidPostSlug("how-to-save-a-web-page-forever")).toBe(true);
    expect(isValidPostSlug("cite-web-pages-that-wont-rot")).toBe(true);
    expect(isValidPostSlug("")).toBe(false);
    expect(isValidPostSlug("../escape")).toBe(false);
    expect(isValidPostSlug("Up/Case")).toBe(false);
    expect(isValidPostSlug("-leading")).toBe(false);
    expect(isValidPostSlug("trailing-")).toBe(false);
    expect(isValidPostSlug("double--dash")).toBe(false);
  });
});

describe("blog — reading time", () => {
  it("counts prose words, not markup (code contents are not prose)", () => {
    const md = [
      "## Heading",
      "",
      "A paragraph with a [link](https://example.com/very/long/path) and",
      "some `inline code` plus **bold** text.",
      "",
      "```js",
      "const ignored = 'fenced code is not prose';",
      "```",
    ].join("\n");
    expect(countMarkdownWords(md)).toBe(
      "Heading A paragraph with a link and some plus bold text".split(" ")
        .length,
    );
  });

  it("yields at least one minute even for tiny posts", () => {
    expect(readingMinutesFromText("Short.")).toBe(1);
  });

  it("scales with length at ~200 wpm", () => {
    const words = Array.from({ length: 1000 }, () => "word").join(" ");
    expect(readingMinutesFromText(words)).toBe(5);
  });
});

describe("blog — OG image text fitting", () => {
  it("wraps titles into lines the 1200×630 layout can render", () => {
    const wrapped = wrapOgTitle("How to Save a Web Page Forever");
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(18);
    }
    expect(wrapped.split("\n").length).toBeLessThanOrEqual(3);
    expect(wrapped).not.toContain("…");
  });

  it("ellipsises titles that cannot fit three short lines", () => {
    const longTitle =
      "A Very Long Blog Post Title That Keeps Going And Going And Never Seems To Stop";
    const wrapped = wrapOgTitle(longTitle);
    expect(wrapped.endsWith("…")).toBe(true);
    for (const line of wrapped.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(18);
    }
  });

  it("leaves short descriptions untouched and truncates long ones at a word boundary", () => {
    expect(truncateOgTagline("Short description")).toBe("Short description");
    // 78 x's then " tailword": the 80-char cut lands inside "tailword", so a
    // word-boundary truncation must drop it entirely.
    const long = `${"x".repeat(78)} tailword`;
    const truncated = truncateOgTagline(long);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated).not.toContain("tailword");
    expect(truncated).toBe(`${"x".repeat(78)}…`);
  });
});
