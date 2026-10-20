import { describe, expect, it } from "vitest";
import {
  breadcrumbJsonLd,
  compareOrder,
  comparePages,
  compareSummaries,
} from "./comparisons";

/**
 * Data-integrity tests for the /compare pages. The honesty policy
 * (content-engine spec) is partly structural: every competitor claim
 * needs a source, every page needs its required sections, and
 * cross-links must point at pages that exist in this change.
 */
describe("comparePages data", () => {
  const pages = compareOrder.map((slug) => comparePages[slug]);

  it("exposes exactly the three comparison pages", () => {
    expect(compareOrder).toEqual(["singlefile", "wayback", "perma-cc"]);
    expect(Object.keys(compareSummaries)).toEqual([
      "singlefile",
      "wayback",
      "perma-cc",
    ]);
  });

  it.each(compareOrder)(
    "%s: has metadata, framing, table, better-choice, fits, FAQ, and sources",
    (slug) => {
      const page = comparePages[slug];

      expect(page.path).toBe(`/compare/${slug}`);
      expect(page.metaTitle).toMatch(/^PagePocket vs /);
      expect(page.metaDescription.length).toBeGreaterThan(50);
      expect(page.heroTitle).toContain(page.competitor);
      expect(page.framing.body.length).toBeGreaterThan(100);
      expect(page.framing.bullets.length).toBeGreaterThanOrEqual(3);

      // Two-column table (PagePocket + competitor), PagePocket highlighted
      // via the shared column id used by ComparisonTable's highlightColumn.
      expect(page.columns.map((column) => column.id)).toEqual([
        "pagepocket",
        slug === "perma-cc" ? "perma" : slug,
      ]);
      expect(page.rows.length).toBeGreaterThanOrEqual(7);
      for (const row of page.rows) {
        expect(Object.keys(row.values).sort()).toEqual(
          ["pagepocket", slug === "perma-cc" ? "perma" : slug].sort(),
        );
      }

      // Spec scenario: explicit "when the competitor is the better choice".
      expect(page.betterChoice.length).toBeGreaterThanOrEqual(2);
      expect(page.fits.length).toBeGreaterThanOrEqual(2);

      // FAQ (2–3 items) feeds FaqList → FAQPage JSON-LD.
      expect(page.faqs.length).toBeGreaterThanOrEqual(2);
      expect(page.faqs.length).toBeLessThanOrEqual(3);
      for (const faq of page.faqs) {
        expect(faq.question.length).toBeGreaterThan(0);
        expect(faq.answer.length).toBeGreaterThan(0);
      }

      // Every competitor fact needs at least one numbered source, and all
      // source URLs are competitor (or their host's) public materials.
      expect(page.sources.length).toBeGreaterThanOrEqual(2);
      for (const source of page.sources) {
        expect(source.url).toMatch(/^https:\/\//);
      }
    },
  );

  it.each(compareOrder)(
    "%s: footnote references [n] in notes/FAQs stay within the sources list",
    (slug) => {
      const page = comparePages[slug];
      const maxRef = page.sources.length;

      const texts = [
        page.framing.body,
        ...page.framing.bullets,
        ...page.rows.flatMap((row) => [
          row.note ?? "",
          String(
            row.values.singlefile ??
              row.values.wayback ??
              row.values.perma ??
              "",
          ),
        ]),
        ...page.betterChoice.map((scenario) => scenario.body),
        ...page.faqs.map((faq) => faq.answer),
      ];
      const refs = texts.flatMap((text) =>
        Array.from(text.matchAll(/\[(\d)\]/g)).map((match) => Number(match[1])),
      );
      for (const ref of refs) {
        expect(ref).toBeGreaterThanOrEqual(1);
        expect(ref).toBeLessThanOrEqual(maxRef);
      }
      // The table must actually cite its sources.
      expect(refs.length).toBeGreaterThan(0);
    },
  );

  it("links each page to the other two comparisons and use-case pages", () => {
    for (const page of Object.values(comparePages)) {
      expect(page.related).toHaveLength(2);
      for (const link of page.related) {
        expect(link.href).toMatch(/^\/compare\/(singlefile|wayback|perma-cc)$/);
        expect(link.href).not.toBe(page.path);
      }
      expect(page.useCases.length).toBeGreaterThanOrEqual(2);
      for (const link of page.useCases) {
        expect(link.href).toMatch(/^\/use-cases\//);
      }
    }
  });
});

describe("breadcrumbJsonLd", () => {
  it("builds a valid BreadcrumbList with 1-based positions and absolute URLs", () => {
    const data = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Compare", path: "/compare" },
      { name: "SingleFile", path: "/compare/singlefile" },
    ]);

    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@type"]).toBe("BreadcrumbList");
    expect(data.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://pagepocket.app/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Compare",
        item: "https://pagepocket.app/compare",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "SingleFile",
        item: "https://pagepocket.app/compare/singlefile",
      },
    ]);
  });
});
