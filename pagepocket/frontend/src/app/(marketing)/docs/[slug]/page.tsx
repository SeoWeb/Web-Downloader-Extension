import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { FaqList } from "@/components/marketing/faq-list";
import { JsonLd } from "@/components/marketing/json-ld";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import {
  DOC_ORDER,
  getAdjacentDocs,
  getDoc,
  getDocFaqs,
  getDocSlugs,
  type DocSummary,
} from "@/lib/docs";
import { marketingUrl } from "@/lib/marketing-routes";

/** Only the slugs in `content/docs` exist — anything else 404s (design D6). */
export const dynamicParams = false;

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) return {};
  const canonical = marketingUrl(`/docs/${slug}`);

  return {
    title: doc.title,
    description: doc.description,
    alternates: {
      canonical,
    },
    openGraph: {
      title: doc.title,
      description: doc.description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title: doc.title,
      description: doc.description,
    },
  };
}

function AdjacentDocCard({
  label,
  doc,
  align,
}: {
  label: string;
  doc: DocSummary;
  align: "start" | "end";
}) {
  return (
    <Link
      href={`/docs/${doc.slug}`}
      className={`group border-border bg-card hover:border-primary/40 flex flex-col rounded-2xl border p-6 transition-colors ${
        align === "end" ? "items-end text-right" : ""
      }`}
    >
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-sm">
        {align === "start" ? (
          <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" />
        ) : null}
        {label}
        {align === "end" ? (
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        ) : null}
      </span>
      <span className="text-foreground group-hover:text-primary mt-2 font-semibold tracking-tight transition-colors">
        {doc.title}
      </span>
    </Link>
  );
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  if (!doc) notFound();

  const { previous, next } = getAdjacentDocs(slug);
  const faqs = getDocFaqs(slug);
  const canonical = marketingUrl(`/docs/${slug}`);
  // Resolve neighbouring summaries for the prev/next cards (slugs in TOC
  // order — see getAdjacentDocs).
  const summaries = new Map(
    (
      await Promise.all(
        DOC_ORDER.map(async (s) => [s, await getDoc(s)] as const),
      )
    ).map(([s, d]) => [s, d as DocSummary]),
  );

  return (
    <article>
      {/* Doc header */}
      <Section spacing="sm" containerSize="prose" className="pb-0">
        <nav
          aria-label="Breadcrumb"
          className="text-muted-foreground mb-8 flex flex-wrap items-center gap-2 text-sm"
        >
          <Link href="/" className="hover:text-foreground transition-colors">
            Home
          </Link>
          <span aria-hidden>/</span>
          <Link
            href="/docs"
            className="hover:text-foreground transition-colors"
          >
            Docs
          </Link>
          <span aria-hidden>/</span>
          <span className="text-foreground truncate">{doc.title}</span>
        </nav>
        <h1 className="text-foreground text-h1 font-bold tracking-tight">
          {doc.title}
        </h1>
        <p className="text-muted-foreground mt-5 text-lg leading-relaxed">
          {doc.description}
        </p>
        <p className="text-muted-foreground mt-6 text-sm">
          Last updated{" "}
          <time dateTime={doc.date}>
            {format(new Date(doc.date), "MMMM d, yyyy")}
          </time>
        </p>
      </Section>

      {/* MDX body — styled by the scoped .prose-blog class (design D6/D7) */}
      <Section spacing="sm" containerSize="prose">
        <div className="prose-blog">
          <doc.Content />
        </div>
      </Section>

      {/* Optional per-doc FAQ (emits FAQPage JSON-LD — design D5) */}
      {faqs.length > 0 ? (
        <Section spacing="sm" containerSize="narrow">
          <h2 className="text-h3 text-foreground font-bold tracking-tight">
            Frequently asked questions
          </h2>
          <div className="mt-6">
            <FaqList items={faqs} />
          </div>
        </Section>
      ) : null}

      {/* Prev/next navigation (reading order) */}
      {previous || next ? (
        <Section spacing="sm" containerSize="wide">
          <div className="grid gap-4 sm:grid-cols-2">
            {previous && summaries.get(previous) ? (
              <AdjacentDocCard
                label="Previous"
                doc={summaries.get(previous)!}
                align="start"
              />
            ) : (
              <span aria-hidden />
            )}
            {next && summaries.get(next) ? (
              <AdjacentDocCard
                label="Next"
                doc={summaries.get(next)!}
                align="end"
              />
            ) : (
              <span aria-hidden />
            )}
          </div>
        </Section>
      ) : null}

      {/* CTA */}
      <Section spacing="sm" containerSize="narrow">
        <div className="from-primary/5 to-accent-warm/5 border-primary/15 rounded-2xl border bg-gradient-to-br p-8 text-center sm:p-10">
          <h2 className="text-h3 text-foreground font-bold tracking-tight">
            Put your archive to work
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            PagePocket saves full-fidelity pages to a private, searchable
            library you can share with a link. Free to start.
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Create free account
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<Link href="/docs" />}
            >
              Back to all docs
            </Button>
          </div>
        </div>
      </Section>

      {/* FAQPage JSON-LD (design D5) is emitted by <FaqList> itself, derived
          from the same items it renders. */}
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
            {
              "@type": "ListItem",
              position: 3,
              name: doc.title,
              item: canonical,
            },
          ],
        }}
      />
    </article>
  );
}
