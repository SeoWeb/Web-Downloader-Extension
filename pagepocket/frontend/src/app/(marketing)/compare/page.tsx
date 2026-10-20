import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import {
  breadcrumbJsonLd,
  compareOrder,
  comparePages,
  compareSummaries,
} from "./comparisons";

export const metadata: Metadata = {
  title: "Compare — SingleFile, Wayback Machine, Perma.cc",
  description:
    "Honest, sourced comparisons of PagePocket with SingleFile, the Wayback Machine, and Perma.cc — including when the competitor is the better choice.",
  alternates: {
    canonical: "/compare",
  },
  twitter: {
    card: "summary_large_image",
    title: "Compare — SingleFile, Wayback Machine, Perma.cc",
    description:
      "Honest, sourced comparisons of PagePocket with SingleFile, the Wayback Machine, and Perma.cc — including when the competitor is the better choice.",
  },
};

/** Display names for the /compare index cards (differs from data keys). */
const competitorNames: Record<(typeof compareOrder)[number], string> = {
  singlefile: "SingleFile",
  wayback: "Wayback Machine",
  "perma-cc": "Perma.cc",
};

export default function CompareIndexPage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
        ])}
      />

      <PageHero
        eyebrow="Honest comparisons"
        title="PagePocket vs the alternatives"
        lede="Other tools do part of what PagePocket does — several of them exceptionally well in their own niche. We compared them feature by feature, cited our sources, and said plainly when the other tool wins."
        align="start"
        actions={
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/register" />}
          >
            Create your free account
          </Button>
        }
      />

      <Section
        id="comparisons"
        title="Pick a comparison"
        subtitle="Every page includes an accurate feature table, a “when the competitor is the better choice” section, and links to the competitor's own materials."
        spacing="sm"
      >
        <div className="grid gap-4 md:grid-cols-3">
          {compareOrder.map((slug) => {
            const data = comparePages[slug];
            return (
              <Link
                key={slug}
                href={data.path}
                className="border-border bg-card hover:border-primary/40 group flex flex-col rounded-xl border p-6 text-left transition-colors"
              >
                <h3 className="text-foreground text-base font-semibold">
                  PagePocket vs {competitorNames[slug]}
                </h3>
                <p className="text-muted-foreground mt-3 flex-1 text-sm leading-relaxed">
                  {compareSummaries[slug]}
                </p>
                <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
                  Read the comparison
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </Link>
            );
          })}
        </div>

        <div className="border-border bg-muted/30 mt-8 flex items-start gap-3 rounded-xl border p-4">
          <ShieldCheck
            aria-hidden="true"
            className="text-primary mt-0.5 size-5 shrink-0"
          />
          <p className="text-muted-foreground text-sm leading-relaxed">
            How we compare: competitor facts are taken from the
            competitor&apos;s own public materials and linked as sources on
            every page. Where a competitor is stronger — offline use, zero cost,
            institutional trust — the table says so. Where numbers appear, they
            link to their origin. No ratings, no rankings, no disparagement.
          </p>
        </div>
      </Section>

      <Section
        id="cta"
        title="Try the private alternative"
        subtitle="Full-fidelity pages, private by default, full-text searchable, shareable with a link. Free to start."
        spacing="sm"
      >
        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/register" />}
          >
            Start free
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Button>
          <Button
            size="lg"
            variant="outline"
            nativeButton={false}
            render={<Link href="/pricing" />}
          >
            See pricing
          </Button>
        </div>
      </Section>
    </>
  );
}
