import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CTA_MICROCOPY,
  PERSONAS,
  breadcrumbJsonLd,
  getPersona,
  otherPersonas,
  personaMetadata,
} from "./personas";

/** Reads a PNG's real pixel dimensions from its IHDR header. */
function pngSize(src: string): { width: number; height: number } {
  const buf = readFileSync(path.join(process.cwd(), "public", src));
  expect(buf.readUInt32BE(0)).toBe(0x89504e47); // PNG magic
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("persona content data", () => {
  it("has exactly the four launch personas, in order, with unique slugs", () => {
    expect(PERSONAS.map((persona) => persona.slug)).toEqual([
      "researchers",
      "journalists",
      "developers",
      "archivists",
    ]);
  });

  it("gives every persona >=3 workflow use cases, each with a real screenshot", () => {
    for (const persona of PERSONAS) {
      expect(persona.useCases.length, persona.slug).toBeGreaterThanOrEqual(3);

      for (const useCase of persona.useCases) {
        const { screenshot } = useCase;
        expect(screenshot.src, useCase.title).toMatch(
          /^\/screenshots\/.+\.png$/,
        );

        // The file must exist (task 3.1: "relevant real screenshot").
        const real = pngSize(screenshot.src);
        // And the declared display size must be aspect-true (no stretching).
        expect(screenshot.width / screenshot.height).toBeCloseTo(
          real.width / real.height,
          2,
        );
      }
    }
  });

  it("gives every persona >=3 FAQ items with unique questions", () => {
    for (const persona of PERSONAS) {
      expect(persona.faqs.length, persona.slug).toBeGreaterThanOrEqual(3);
      const questions = persona.faqs.map((faq) => faq.question);
      expect(new Set(questions).size, persona.slug).toBe(questions.length);
      for (const faq of persona.faqs) {
        expect(faq.answer.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps metadata within SERP-friendly lengths and targets keywords", () => {
    for (const persona of PERSONAS) {
      expect(persona.metaTitle.length, persona.slug).toBeLessThanOrEqual(60);
      expect(persona.metaDescription.length, persona.slug).toBeLessThanOrEqual(
        160,
      );
      expect(persona.keywords.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("builds persona metadata with the absolute canonical URL", () => {
    const persona = getPersona("researchers");
    const metadata = personaMetadata(persona);

    expect(metadata.title).toBe(persona.metaTitle); // root template appends brand
    expect(metadata.description).toBe(persona.metaDescription);
    expect(metadata.alternates?.canonical).toBe(
      "https://pagepocket.app/use-cases/researchers",
    );
    expect(metadata.openGraph?.url).toBe(
      "https://pagepocket.app/use-cases/researchers",
    );
  });

  it("builds BreadcrumbList JSON-LD with positions and absolute item URLs", () => {
    const data = breadcrumbJsonLd([
      { name: "Home", path: "/" },
      { name: "Use cases", path: "/use-cases" },
      { name: "Researchers" },
    ]);

    expect(data["@type"]).toBe("BreadcrumbList");
    const items = data.itemListElement as Array<{
      "@type": string;
      position: number;
      name: string;
      item?: string;
    }>;

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://pagepocket.app/",
    });
    expect(items[1]?.item).toBe("https://pagepocket.app/use-cases");
    // Current page omits `item`.
    expect(items[2]).toEqual({
      "@type": "ListItem",
      position: 3,
      name: "Researchers",
    });
  });

  it("cross-links every persona to the other three", () => {
    for (const persona of PERSONAS) {
      const others = otherPersonas(persona);
      expect(others).toHaveLength(3);
      expect(others.map((other) => other.slug)).not.toContain(persona.slug);
    }
  });

  it("keeps the CTA microcopy honest and quota-accurate", () => {
    // Mirrors the real /pricing quotas — no invented numbers.
    expect(CTA_MICROCOPY).toContain("50 pages/month");
    expect(CTA_MICROCOPY).toContain("$2/mo");
  });
});
