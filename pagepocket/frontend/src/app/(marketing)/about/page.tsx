import type { Metadata } from "next";
import Link from "next/link";
import { Eye, FolderTree, Lock, Search, Share2 } from "lucide-react";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { Button } from "@/components/ui/button";
import { marketingUrl } from "@/lib/marketing-routes";

export const metadata: Metadata = {
  title: "About",
  description:
    "PagePocket is your private Wayback Machine: an open-source browser extension and cloud library that saves full-fidelity web pages you can search and share.",
  alternates: {
    canonical: marketingUrl("/about"),
  },
  openGraph: {
    title: "About",
    description:
      "PagePocket is your private Wayback Machine: an open-source browser extension and cloud library that saves full-fidelity web pages you can search and share.",
  },
  // og:image / twitter:image come from the sibling opengraph-image.tsx /
  // twitter-image.tsx routes; metadataBase keeps the URLs absolute.
  twitter: {
    card: "summary_large_image",
    title: "About",
    description:
      "PagePocket is your private Wayback Machine: an open-source browser extension and cloud library that saves full-fidelity web pages you can search and share.",
  },
};

const GITHUB_URL = "https://github.com/SeoWeb/Web-Downloader-Extension";
const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk";

const PILLARS = [
  {
    icon: Eye,
    title: "What you see is what was saved",
    body: "A save is a self-contained copy of the page — HTML, CSS, images — rendered in a sandboxed viewer where scripts never run. That is not a limitation we hid; it is the feature: archived pages can't change, can't track you, and can't execute anything.",
  },
  {
    icon: Lock,
    title: "Private by default",
    body: "Nothing you save is published or visible to anyone else. The only way another person sees a page is a share link you create — with an optional expiry, a view count, and a revoke button that works immediately.",
  },
  {
    icon: Search,
    title: "Findable, not just stored",
    body: "Every page is full-text indexed — titles and body text — with highlighted snippets and collection filters. An archive you cannot search is a shoebox.",
  },
  {
    icon: FolderTree,
    title: "Organized your way",
    body: "Nested, color-coded collections mirror how you actually work: per project, per story, per case. Drag and drop filing keeps the structure alive as the work moves.",
  },
  {
    icon: Share2,
    title: "Share the exact copy",
    body: 'Recipients open the archived page itself — no account needed — under a "Shared via PagePocket" banner. The live page can change; your link shows what you saved.',
  },
];

export default function AboutPage() {
  return (
    <>
      <PageHero
        align="center"
        eyebrow="About"
        title="Web pages vanish. Yours don't have to."
        lede="PagePocket is your private Wayback Machine — a browser extension and cloud library that saves the pages you read, exactly as you read them, so you can find and share them years later."
        actions={
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/register" />}
            className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
          >
            Start your archive — free
          </Button>
        }
      />

      {/* The problem */}
      <Section
        spacing="md"
        containerSize="narrow"
        align="start"
        eyebrow="Why we built it"
        title="Every professional depends on pages that don't sit still"
        subtitle="Sources get edited, docs get rewritten, pricing pages change, articles disappear. Bookmarks follow the change; screenshots lose the words. PagePocket keeps the page itself."
      >
        <div className="prose-blog">
          <p>
            The tools for this have existed on the public web for years — but a
            shared archive only keeps what its crawlers happened to visit, and
            it saves pages for everyone, visible to everyone. Professionals need
            the opposite: <strong>you</strong> decide what is kept, and only{" "}
            <strong>you</strong> can read it until you choose to share.
          </p>
          <p>
            PagePocket is that archive: one click in your browser saves the
            full-fidelity page to your private, searchable library — with share
            links when you want someone else to see the exact copy.
          </p>
        </div>
      </Section>

      {/* Honest tech story */}
      <Section
        spacing="md"
        className="bg-muted/30"
        eyebrow="How it works"
        title="A small, honest pipeline"
        subtitle="A browser extension that captures, a cloud library that keeps, a viewer that renders what was saved — and nothing else."
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {PILLARS.map((pillar) => (
            <div
              key={pillar.title}
              className="border-border bg-card rounded-2xl border p-6"
            >
              <pillar.icon className="text-primary size-5" aria-hidden />
              <h3 className="text-foreground mt-3 font-semibold tracking-tight">
                {pillar.title}
              </h3>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                {pillar.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* Open source + where to get it */}
      <Section
        spacing="md"
        containerSize="narrow"
        align="start"
        eyebrow="Open source"
        title="The code is public"
      >
        <div className="prose-blog">
          <p>
            PagePocket&rsquo;s extension and platform are developed in the open
            at{" "}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              github.com/SeoWeb/Web-Downloader-Extension
            </a>
            . You can read how saves, storage, and sharing actually work, file
            issues, and follow development — no black boxes, no claims you
            can&rsquo;t check.
          </p>
          <p>
            The extension is available on the{" "}
            <a
              href={CHROME_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Chrome Web Store
            </a>{" "}
            (listed under its earlier name, Web Page Downloader — a rebrand is
            in progress). The library lives at{" "}
            <a
              href="https://app.pagepocket.app/app"
              target="_blank"
              rel="noopener noreferrer"
            >
              app.pagepocket.app
            </a>
            .
          </p>
        </div>
      </Section>

      {/* Who builds it — neutral, no invented people */}
      <Section
        spacing="md"
        containerSize="narrow"
        align="start"
        eyebrow="Who builds it"
        title="A small, independent project"
      >
        <div className="prose-blog">
          <p>
            PagePocket is built and maintained by a small, distributed team of
            engineers and archivists who needed this tool themselves and
            couldn&rsquo;t find it. It is independent: no advertising, no
            investor story, no data business — the product is funded by its
            subscriptions, and Free exists so anyone can start.
          </p>
          <p>
            We keep a simple rule about honesty: this site only makes claims you
            can verify from the product, the repository, and the store listing.
            If you find a claim you can&rsquo;t, tell us on GitHub.
          </p>
        </div>
      </Section>

      {/* CTA */}
      <Section spacing="sm" containerSize="narrow">
        <div className="from-primary/5 to-accent-warm/5 border-primary/15 rounded-2xl border bg-gradient-to-br p-8 text-center sm:p-10">
          <h2 className="text-h3 text-foreground font-bold tracking-tight">
            Start keeping the pages you can&rsquo;t afford to lose
          </h2>
          <p className="text-muted-foreground mx-auto mt-3 max-w-md">
            Free: 50 saves per month, 500 MB. Pro: $2/mo for a bigger library.
            No credit card to start.
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
              render={<Link href="/features" />}
            >
              See how it works
            </Button>
          </div>
        </div>
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
              name: "About",
              item: marketingUrl("/about"),
            },
          ],
        }}
      />
    </>
  );
}
