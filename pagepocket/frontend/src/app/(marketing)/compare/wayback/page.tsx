import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { ComparisonTable } from "@/components/marketing/comparison-table";
import { FaqList } from "@/components/marketing/faq-list";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import { breadcrumbJsonLd, comparePages } from "../comparisons";

const page = comparePages.wayback;

export const metadata: Metadata = {
  title: page.metaTitle,
  description: page.metaDescription,
  alternates: {
    canonical: page.path,
  },
};

export default function CompareWaybackPage() {
  return (
    <>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Compare", path: "/compare" },
          { name: "Wayback Machine", path: page.path },
        ])}
      />

      <PageHero
        eyebrow="Honest comparison"
        title={page.heroTitle}
        lede={page.heroLede}
        align="start"
        actions={
          <>
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
            >
              Create your free account
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<Link href="/pricing" />}
            >
              See pricing
            </Button>
          </>
        }
      />

      {/* What the competitor is great at — required honest framing */}
      <Section
        id="strengths"
        title={page.framing.title}
        subtitle={page.framing.body}
        align="start"
      >
        <ul className="grid gap-3 sm:grid-cols-1">
          {page.framing.bullets.map((bullet) => (
            <li
              key={bullet}
              className="text-muted-foreground flex items-start gap-2 text-sm leading-relaxed"
            >
              <Check
                aria-hidden="true"
                className="text-muted-foreground mt-0.5 size-4 shrink-0"
              />
              {bullet}
            </li>
          ))}
        </ul>
      </Section>

      {/* Feature comparison table */}
      <Section id="comparison" title="Feature comparison" spacing="md">
        <ComparisonTable
          columns={page.columns}
          rows={page.rows}
          highlightColumn="pagepocket"
          caption={page.tableCaption}
        />
        <div className="text-muted-foreground mt-4 space-y-1 text-xs leading-relaxed">
          <p className="font-medium">Sources</p>
          <ol className="list-none space-y-0.5">
            {page.sources.map((source, index) => (
              <li key={source.url}>
                [{index + 1}]{" "}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-foreground underline underline-offset-2"
                >
                  {source.label}
                </a>
              </li>
            ))}
          </ol>
          <p>
            PagePocket claims on this page come from our own{" "}
            <Link
              href="/features"
              className="hover:text-foreground underline underline-offset-2"
            >
              features
            </Link>{" "}
            and{" "}
            <Link
              href="/pricing"
              className="hover:text-foreground underline underline-offset-2"
            >
              pricing
            </Link>{" "}
            pages.
          </p>
        </div>
      </Section>

      {/* When the competitor is the better choice — required section */}
      <Section
        id="when-wayback-wins"
        eyebrow="Straight talk"
        title="When the Wayback Machine is the better choice"
        subtitle={page.betterChoiceIntro}
      >
        <div className="grid gap-4 text-left md:grid-cols-3">
          {page.betterChoice.map((scenario) => (
            <div
              key={scenario.title}
              className="border-border bg-card rounded-xl border p-5"
            >
              <h3 className="text-foreground text-sm font-semibold">
                {scenario.title}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {scenario.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* Where PagePocket fits + CTA */}
      <Section
        id="where-pagepocket-fits"
        eyebrow="The PagePocket angle"
        title="Where PagePocket fits"
        align="start"
        className="bg-muted/30"
      >
        <div className="max-w-2xl space-y-4">
          {page.fits.map((paragraph) => (
            <p
              key={paragraph.slice(0, 32)}
              className="text-muted-foreground leading-relaxed"
            >
              {paragraph}
            </p>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
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
            render={<Link href="/features" />}
          >
            Explore the features
          </Button>
        </div>
      </Section>

      {/* FAQ — FaqList emits matching FAQPage JSON-LD */}
      <Section
        id="faq"
        title="Frequently asked questions"
        containerSize="narrow"
      >
        <FaqList items={page.faqs} />
      </Section>

      {/* Cross-links: the other comparisons + related use-case pages */}
      <Section
        id="related"
        eyebrow="Keep exploring"
        title="More comparisons and use cases"
      >
        <div className="grid gap-4 text-left sm:grid-cols-2">
          <div className="border-border bg-card rounded-xl border p-5">
            <h3 className="text-foreground text-sm font-semibold">
              More comparisons
            </h3>
            <ul className="mt-3 space-y-2">
              {page.related.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-2"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/compare"
                  className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-2"
                >
                  All comparisons
                </Link>
              </li>
            </ul>
          </div>
          <div className="border-border bg-card rounded-xl border p-5">
            <h3 className="text-foreground text-sm font-semibold">
              Related use cases
            </h3>
            <ul className="mt-3 space-y-2">
              {page.useCases.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-2"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>
    </>
  );
}
