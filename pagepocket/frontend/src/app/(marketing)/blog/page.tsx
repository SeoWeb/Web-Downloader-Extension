import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowRight } from "lucide-react";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { getPostSummaries } from "@/lib/blog";
import { marketingUrl } from "@/lib/marketing-routes";

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Practical guides on saving, searching, and sharing web pages — web-archiving methods and workflows from the PagePocket team.",
  alternates: {
    canonical: marketingUrl("/blog"),
  },
  openGraph: {
    title: "Blog",
    description:
      "Practical guides on saving, searching, and sharing web pages — web-archiving methods and workflows from the PagePocket team.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog",
    description:
      "Practical guides on saving, searching, and sharing web pages — web-archiving methods and workflows from the PagePocket team.",
  },
};

export default async function BlogIndexPage() {
  const posts = await getPostSummaries();

  return (
    <>
      <PageHero
        eyebrow="Blog"
        title="Notes on keeping the web readable"
        lede="Methods, workflows, and honest tool talk for people who need web pages to still be there — and still be findable — later."
      />
      <Section spacing="sm" containerSize="wide" className="pt-0">
        {posts.length === 0 ? (
          <div className="border-border bg-card/40 mx-auto max-w-2xl rounded-2xl border border-dashed p-10 text-center">
            <p className="text-foreground text-lg font-medium">
              First articles are being written.
            </p>
            <p className="text-muted-foreground mt-2">
              Guides on saving and sharing web pages are on their way — check
              back soon.
            </p>
          </div>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <Link
                key={post.slug}
                href={`/blog/${post.slug}`}
                className="group border-border bg-card hover:border-primary/40 flex flex-col rounded-2xl border p-6 transition-colors"
              >
                <p className="text-muted-foreground text-sm">
                  <time dateTime={post.date}>
                    {format(new Date(post.date), "MMMM d, yyyy")}
                  </time>{" "}
                  · {post.readingMinutes} min read
                </p>
                <h2 className="text-foreground group-hover:text-primary mt-3 text-lg font-semibold tracking-tight transition-colors">
                  {post.title}
                </h2>
                <p className="text-muted-foreground mt-2 line-clamp-3 flex-1 text-sm leading-relaxed">
                  {post.description}
                </p>
                <span className="text-primary mt-4 inline-flex items-center gap-1 text-sm font-medium">
                  Read article
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            ))}
          </div>
        )}
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
              name: "Blog",
              item: marketingUrl("/blog"),
            },
          ],
        }}
      />
    </>
  );
}
