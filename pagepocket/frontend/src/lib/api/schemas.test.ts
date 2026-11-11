import { describe, it, expect } from "vitest";
import { PageResponseSchema, ValidateShareResponseSchema } from "./schemas";

const BASE_PAGE = {
  id: "p1",
  user_id: "u1",
  url: "https://example.com/article",
  title: "Example",
  archived_at: "2026-10-01T12:00:00",
};

const MANIFEST = [
  {
    path: "about.md",
    title: "About",
    url: "https://example.com/about",
    content_format: "markdown",
  },
  {
    path: "docs/notes.txt",
    title: "Notes",
    url: "https://example.com/docs/notes",
    content_format: "text",
  },
];

describe("PageResponseSchema.pages (multipage-download-fixes 8.2/D7)", () => {
  it("parses a full manifest into typed entries", () => {
    const parsed = PageResponseSchema.parse({
      ...BASE_PAGE,
      content_formats: ["markdown"],
      pages: MANIFEST,
    });
    expect(parsed.pages).toEqual(MANIFEST);
    expect(parsed.pages?.[0]?.path).toBe("about.md");
  });

  it("absent pages → undefined (legacy page renders unchanged)", () => {
    const parsed = PageResponseSchema.parse(BASE_PAGE);
    expect(parsed.pages).toBeUndefined();
  });

  it("malformed pages value → undefined (tolerant catch, never throws)", () => {
    for (const garbage of [null, "nope", 42, { path: "x" }, [42]]) {
      const parsed = PageResponseSchema.parse({
        ...BASE_PAGE,
        content_formats: [],
        pages: garbage,
      });
      expect(parsed.pages).toBeUndefined();
    }
  });
});

describe("ValidateShareResponseSchema.pages (share parity)", () => {
  it("parses the manifest through the share validation payload", () => {
    const parsed = ValidateShareResponseSchema.parse({
      valid: true,
      page_id: "p1",
      content_formats: ["markdown"],
      pages: MANIFEST,
    });
    expect(parsed.pages).toEqual(MANIFEST);
  });

  it("absent or malformed pages → undefined (older gateway degrades)", () => {
    expect(
      ValidateShareResponseSchema.parse({ valid: true }).pages,
    ).toBeUndefined();
    expect(
      ValidateShareResponseSchema.parse({ valid: true, pages: "x" }).pages,
    ).toBeUndefined();
  });
});
