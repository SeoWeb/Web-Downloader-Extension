import { describe, it, expect } from "vitest";
import {
  DOC_ORDER,
  assertDocOrderCoversDirectory,
  getAdjacentDocs,
  getDocFaqs,
  isValidDocSlug,
  slugFromDocFilename,
} from "./docs";

describe("docs — slug helpers", () => {
  it("derives slugs from .mdx filenames", () => {
    expect(slugFromDocFilename("getting-started.mdx")).toBe("getting-started");
  });

  it("accepts only safe kebab-case slugs (defence before dynamic import)", () => {
    expect(isValidDocSlug("getting-started")).toBe(true);
    expect(isValidDocSlug("full-text-search")).toBe(true);
    expect(isValidDocSlug("")).toBe(false);
    expect(isValidDocSlug("../escape")).toBe(false);
    expect(isValidDocSlug("Up/Case")).toBe(false);
    expect(isValidDocSlug("-leading")).toBe(false);
    expect(isValidDocSlug("trailing-")).toBe(false);
    expect(isValidDocSlug("double--dash")).toBe(false);
  });
});

describe("docs — canonical reading order", () => {
  it("covers the six launch docs in pedagogical order", () => {
    expect(DOC_ORDER).toEqual([
      "getting-started",
      "saving-pages",
      "collections",
      "full-text-search",
      "sharing",
      "troubleshooting",
    ]);
  });

  it("rejects a directory that disagrees with the TOC (build-time contract)", () => {
    // Every launch doc present: no error.
    expect(() => assertDocOrderCoversDirectory([...DOC_ORDER])).not.toThrow();

    // A file missing from DOC_ORDER must fail loudly, not silently drop
    // off the index while still being routable.
    expect(() =>
      assertDocOrderCoversDirectory([...DOC_ORDER, "advanced-import"]),
    ).toThrow(/advanced-import/);

    // A TOC entry without a file must fail loudly, not render a 404 card.
    expect(() =>
      assertDocOrderCoversDirectory(DOC_ORDER.filter((s) => s !== "sharing")),
    ).toThrow(/sharing/);
  });
});

describe("docs — prev/next navigation", () => {
  it("chains the launch docs in reading order", () => {
    expect(getAdjacentDocs("getting-started")).toEqual({
      previous: null,
      next: "saving-pages",
    });
    expect(getAdjacentDocs("full-text-search")).toEqual({
      previous: "collections",
      next: "sharing",
    });
    expect(getAdjacentDocs("troubleshooting")).toEqual({
      previous: "sharing",
      next: null,
    });
  });

  it("returns empty neighbours for unknown slugs", () => {
    expect(getAdjacentDocs("not-a-doc")).toEqual({
      previous: null,
      next: null,
    });
  });
});

describe("docs — per-page FAQs", () => {
  it("declares FAQs only for pages that render them", () => {
    expect(getDocFaqs("getting-started").length).toBeGreaterThanOrEqual(3);
    expect(getDocFaqs("collections")).toEqual([]);
  });
});
