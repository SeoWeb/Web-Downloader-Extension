import { describe, it, expect } from "vitest";
import {
  getChangelogSlugs,
  isValidChangelogSlug,
  slugFromChangelogFilename,
} from "./changelog";

describe("changelog — slug helpers", () => {
  it("derives slugs from .mdx filenames", () => {
    expect(slugFromChangelogFilename("2026-10-cloud-library-launch.mdx")).toBe(
      "2026-10-cloud-library-launch",
    );
  });

  it("accepts only safe kebab-case slugs (defence before dynamic import)", () => {
    expect(isValidChangelogSlug("2026-10-cloud-library-launch")).toBe(true);
    expect(isValidChangelogSlug("")).toBe(false);
    expect(isValidChangelogSlug("../escape")).toBe(false);
    expect(isValidChangelogSlug("2026/10")).toBe(false);
    expect(isValidChangelogSlug("-leading")).toBe(false);
    expect(isValidChangelogSlug("trailing-")).toBe(false);
  });
});

describe("changelog — content policy", () => {
  it("every entry file is date-prefixed so the timeline is readable in-repo", () => {
    for (const slug of getChangelogSlugs()) {
      expect(slug).toMatch(/^\d{4}-\d{2}-/);
    }
  });
});
