import { describe, it, expect } from "vitest";
import {
  CHROME_WEB_STORE_URL,
  GITHUB_REPO_URL,
  organizationJsonLd,
  siteJsonLd,
  softwareApplicationJsonLd,
} from "@/components/marketing/site-json-ld";

describe("siteJsonLd builders", () => {
  it("Organization names PagePocket with absolute url, logo, and GitHub sameAs", () => {
    const org = organizationJsonLd();

    expect(org["@context"]).toBe("https://schema.org");
    expect(org["@type"]).toBe("Organization");
    expect(org.name).toBe("PagePocket");
    expect(org.url).toBe("https://pagepocket.app/");
    expect(org.logo).toBe("https://pagepocket.app/icons/256x256.png");
    expect(org.sameAs).toEqual([GITHUB_REPO_URL]);
    // Honesty policy: no invented contact channel.
    expect(org).not.toHaveProperty("contactPoint");
  });

  it("SoftwareApplication is a BrowserApplication for Chrome/Chromium with the store URL", () => {
    const app = softwareApplicationJsonLd();

    expect(app["@context"]).toBe("https://schema.org");
    expect(app["@type"]).toBe("SoftwareApplication");
    expect(app.name).toBe("PagePocket");
    expect(app.applicationCategory).toBe("BrowserApplication");
    expect(app.operatingSystem).toBe("Chrome/Chromium");
    expect(app.url).toBe("https://pagepocket.app/");
    expect(app.sameAs).toEqual([CHROME_WEB_STORE_URL]);
    expect(typeof app.description).toBe("string");
    expect((app.description as string).length).toBeGreaterThan(0);
  });

  it("offers a Free tier and a $24/year Pro tier pointing at /pricing", () => {
    const offers = softwareApplicationJsonLd().offers as Array<
      Record<string, unknown>
    >;

    expect(offers).toHaveLength(2);
    expect(offers[0]).toEqual({
      "@type": "Offer",
      name: "Free",
      price: "0",
      priceCurrency: "USD",
    });
    expect(offers[1]?.["@type"]).toBe("Offer");
    expect(offers[1]?.name).toBe("Pro (billed yearly)");
    expect(offers[1]?.price).toBe("24");
    expect(offers[1]?.priceCurrency).toBe("USD");
    expect(offers[1]?.url).toBe("https://pagepocket.app/pricing");
  });

  it("never emits aggregateRating (spec: only with real, citable data)", () => {
    expect(organizationJsonLd()).not.toHaveProperty("aggregateRating");
    expect(softwareApplicationJsonLd()).not.toHaveProperty("aggregateRating");
  });

  it("siteJsonLd is exactly [Organization, SoftwareApplication]", () => {
    const site = siteJsonLd();

    expect(site).toHaveLength(2);
    expect(site.map((node) => node["@type"])).toEqual([
      "Organization",
      "SoftwareApplication",
    ]);
  });
});
