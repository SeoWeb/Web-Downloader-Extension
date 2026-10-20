import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { getChangelogEntries } from "@/lib/changelog";
import { marketingUrl } from "@/lib/marketing-routes";

export const metadata: Metadata = {
  title: "Changelog",
  description:
    "What's new in PagePocket — user-visible highlights from each release: save reliability, the cloud library, sharing, and search.",
  alternates: {
    canonical: marketingUrl("/changelog"),
  },
  openGraph: {
    title: "Changelog",
    description:
      "What's new in PagePocket — user-visible highlights from each release: save reliability, the cloud library, sharing, and search.",
  },
  // og:image / twitter:image come from the sibling opengraph-image.tsx /
  // twitter-image.tsx routes; metadataBase keeps the URLs absolute.
  twitter: {
    card: "summary_large_image",
    title: "Changelog",
    description:
      "What's new in PagePocket — user-visible highlights from each release: save reliability, the cloud library, sharing, and search.",
  },
};

export default async function ChangelogPage() {
  const entries = await getChangelogEntries();

  return (
    <>
      <PageHero
        align="center"
        eyebrow="Changelog"
        title="What's new in PagePocket"
        lede={
          <>
            Highlights, newest first — the changes that are visible from the
            outside. For the complete development history,{" "}
            <Link
              href="https://github.com/SeoWeb/Web-Downloader-Extension"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary font-medium hover:underline"
            >
              browse the open-source repository
            </Link>
            .
          </>
        }
      />
      <Section spacing="sm" containerSize="narrow">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-center">
            Release notes are being written. Check back soon.
          </p>
        ) : (
          <div className="space-y-14">
            {entries.map((entry) => (
              <article
                key={entry.slug}
                aria-labelledby={`changelog-${entry.slug}`}
              >
                <header>
                  <p className="text-muted-foreground text-sm">
                    <time dateTime={entry.date}>
                      {format(new Date(entry.date), "MMMM d, yyyy")}
                    </time>
                  </p>
                  <h2
                    id={`changelog-${entry.slug}`}
                    className="text-h3 text-foreground mt-1 font-bold tracking-tight"
                  >
                    {entry.title}
                  </h2>
                </header>
                <div className="prose-blog mt-5">
                  <entry.Content />
                </div>
              </article>
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
              name: "Changelog",
              item: marketingUrl("/changelog"),
            },
          ],
        }}
      />
    </>
  );
}
