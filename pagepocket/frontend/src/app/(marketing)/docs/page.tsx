import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, BookOpen } from "lucide-react";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { getDocSummaries } from "@/lib/docs";
import { marketingUrl } from "@/lib/marketing-routes";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "PagePocket documentation: install the extension, save your first page, organize collections, search your archive, share links, and fix common problems.",
  alternates: {
    canonical: marketingUrl("/docs"),
  },
  openGraph: {
    title: "Docs",
    description:
      "PagePocket documentation: install the extension, save your first page, organize collections, search your archive, share links, and fix common problems.",
  },
  // og:image / twitter:image come from the sibling opengraph-image.tsx /
  // twitter-image.tsx routes; metadataBase keeps the URLs absolute.
  twitter: {
    card: "summary_large_image",
    title: "Docs",
    description:
      "PagePocket documentation: install the extension, save your first page, organize collections, search your archive, share links, and fix common problems.",
  },
};

export default async function DocsIndexPage() {
  const docs = await getDocSummaries();

  return (
    <>
      <PageHero
        align="center"
        eyebrow="Docs"
        title="PagePocket documentation"
        lede="Everything you need to run your private web archive — from your first save to sharing, search, and the fixes for when something misbehaves."
      />
      <Section spacing="sm" containerSize="wide" className="pt-0">
        <ol className="grid gap-4 sm:grid-cols-2">
          {docs.map((doc, index) => (
            <li key={doc.slug}>
              <Link
                href={`/docs/${doc.slug}`}
                className="group border-border bg-card hover:border-primary/40 flex h-full flex-col rounded-2xl border p-6 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className="border-primary/20 bg-primary/5 text-primary inline-flex size-8 items-center justify-center rounded-lg border text-sm font-semibold">
                    {index + 1}
                  </span>
                  <BookOpen className="text-muted-foreground size-4" />
                </div>
                <h2 className="text-foreground group-hover:text-primary mt-4 text-lg font-semibold tracking-tight transition-colors">
                  {doc.title}
                </h2>
                <p className="text-muted-foreground mt-2 flex-1 text-sm leading-relaxed">
                  {doc.description}
                </p>
                <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
                  Read guide
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ol>
        <p className="text-muted-foreground mt-8 text-center text-sm">
          New to PagePocket? Start with{" "}
          <Link
            href="/docs/getting-started"
            className="text-primary font-medium hover:underline"
          >
            Getting started
          </Link>
          .
        </p>
      </Section>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: marketingUrl("/"),
            },
            {
              "@type": "ListItem",
              position: 2,
              name: "Docs",
              item: marketingUrl("/docs"),
            },
          ],
        }}
      />
    </>
  );
}
