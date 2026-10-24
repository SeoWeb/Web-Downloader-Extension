import { describe, it, expect } from "vitest";
import { z } from "zod";
import { isLegacyHtmlOnly, knownContentFormats } from "./content-formats";
import { PageResponseSchema, ValidateShareResponseSchema } from "./api/schemas";

describe("knownContentFormats", () => {
  it("keeps only known values, in canonical switcher order", () => {
    // Stored order is irrelevant — the viewer always shows HTML | Markdown | Text.
    expect(knownContentFormats(["text", "markdown", "html"])).toEqual([
      "html",
      "markdown",
      "text",
    ]);
    expect(knownContentFormats(["markdown", "html"])).toEqual([
      "html",
      "markdown",
    ]);
    expect(knownContentFormats(["text"])).toEqual(["text"]);
  });

  it("ignores unknown format values", () => {
    expect(knownContentFormats(["epub", "markdown"])).toEqual(["markdown"]);
    expect(knownContentFormats(["epub"])).toEqual([]);
  });

  it("tolerates missing or empty fields (older backend)", () => {
    expect(knownContentFormats(undefined)).toEqual([]);
    expect(knownContentFormats(null)).toEqual([]);
    expect(knownContentFormats([])).toEqual([]);
  });
});

describe("isLegacyHtmlOnly", () => {
  it("is true for html-only and unknown/empty format pages", () => {
    expect(isLegacyHtmlOnly(["html"])).toBe(true);
    expect(isLegacyHtmlOnly([])).toBe(true);
  });

  it("is false whenever a second format exists", () => {
    expect(isLegacyHtmlOnly(["html", "markdown"])).toBe(false);
    expect(isLegacyHtmlOnly(["markdown"])).toBe(false);
    expect(isLegacyHtmlOnly(["text"])).toBe(false);
  });
});

describe("content_formats schema tolerance (text-native-downloads D1)", () => {
  it("defaults PageResponse.content_formats to [] when absent", () => {
    const parsed = PageResponseSchema.parse({
      id: "p1",
      user_id: "u1",
      url: "https://example.com",
      title: "Example",
      archived_at: "2026-10-24T00:00:00Z",
    });
    expect(parsed.content_formats).toEqual([]);
  });

  it("passes stored formats through when present", () => {
    const parsed = PageResponseSchema.parse({
      id: "p1",
      user_id: "u1",
      url: "https://example.com",
      title: "Example",
      archived_at: "2026-10-24T00:00:00Z",
      content_formats: ["html", "markdown"],
    });
    expect(parsed.content_formats).toEqual(["html", "markdown"]);
  });

  it("never fails on unknown format strings (ignored by the viewer)", () => {
    const schema = z.object({
      content_formats: z.array(z.string()).default([]),
    });
    expect(schema.parse({ content_formats: ["epub"] }).content_formats).toEqual(
      ["epub"],
    );
  });

  it("defaults ValidateShareResponse.content_formats to [] when absent", () => {
    const parsed = ValidateShareResponseSchema.parse({});
    expect(parsed.content_formats).toEqual([]);
  });
});
