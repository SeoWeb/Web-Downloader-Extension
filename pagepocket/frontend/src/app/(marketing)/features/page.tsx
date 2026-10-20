import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Archive, Eye, FolderTree, Info, Search, Share2 } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { Container } from "@/components/marketing/container";
import { Button } from "@/components/ui/button";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  // absolute: the root layout template ("%s · PagePocket") would otherwise
  // double the brand ("Features — PagePocket · PagePocket").
  title: { absolute: "Features — PagePocket" },
  description:
    "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
  alternates: {
    canonical: "/features",
  },
  openGraph: {
    title: "Features — PagePocket",
    description:
      "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Features — PagePocket",
    description:
      "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
  },
};

interface Feature {
  id: string;
  icon: LucideIcon;
  verb: string;
  title: string;
  /** What it does — concrete. */
  lead: string;
  /** How it works — honest mechanics. */
  how: string;
  /** Honesty note body (rendered after a "Good to know:" lead-in). */
  note?: string;
}

// Every mechanic below is verified against the product:
//  - save → sanitise → Cloudflare R2 storage   (services/archive-service)
//  - sandboxed viewer, scripts never run       (components/app/page-viewer-shell.tsx)
//  - nested + colour-coded collections         (services/library-service/models.py)
//  - full-text index over extracted text       (services/search-service)
//  - share links: optional expiry, revoke,
//    view counts, dead once the page is gone   (services/share-service)
const features: Feature[] = [
  {
    id: "cloud-save",
    icon: Archive,
    verb: "Save",
    title: "Cloud Save",
    lead: "Save any web page to your private cloud archive in one click — the full page, not a link to it.",
    how: "From the extension's side panel, one click copies the page's HTML, styles, and images to PagePocket's archive storage (Cloudflare R2) and files the snapshot in your library. It's yours from any browser and any device — even after the original page is gone.",
    note: "saved pages are static snapshots. Content, layout, and styling are preserved, but scripts don't run — pages that need a login or JavaScript won't be interactive in the archive.",
  },
  {
    id: "clean-viewer",
    icon: Eye,
    verb: "Read",
    title: "Clean Page Viewer",
    lead: "Read saved pages in a faithful viewer — the archived article renders just like the original, without reloading ads or tracking scripts.",
    how: "The viewer serves your archived HTML inside a strictly sandboxed frame: scripts never execute, and the archive runs on its own isolated origin, separate from your PagePocket session. Pages are also sanitised server-side at save time — event handlers and dangerous URLs are stripped.",
    note: "because scripts never run, interactive elements — embedded players, maps, comment widgets — appear frozen as they were at save time. That's the trade-off that makes reading archived pages safe.",
  },
  {
    id: "collections",
    icon: FolderTree,
    verb: "Organise",
    title: "Collections & Organization",
    lead: "Keep a growing archive navigable: group pages into collections, nest collections inside each other, and colour-code them at a glance.",
    how: "A collection holds pages and other collections, each with its own name and colour. Pages move between collections by drag and drop in the library sidebar.",
    note: "collections are private to your account. Sharing is per page — a share link never exposes a whole collection.",
  },
  {
    id: "full-text-search",
    icon: Search,
    verb: "Find",
    title: "Full-Text Search",
    lead: "Search inside your saved pages — not just their titles — and find the page you half-remember in seconds.",
    how: "Saving a page extracts its text into a full-text index of your library. Searches match titles and body text, can be narrowed to a single collection, and results show the matching snippet in context.",
    note: "the index is built from the text PagePocket extracts when you save, so results come from your own archive alone.",
  },
  {
    id: "shareable-links",
    icon: Share2,
    verb: "Share",
    title: "Shareable Links",
    lead: "Send any saved page as a link. Recipients see the full archived page in their browser — no account, no install.",
    how: "Create a link from any saved page, set an expiry if you want one, and revoke it whenever you like. PagePocket counts how often a link has been viewed, and expired or revoked links stop resolving immediately.",
    note: "a share link serves the archived copy of the page from your library — delete the page and the link goes with it.",
  },
];

/**
 * Screenshot — real product capture (design D3/D4: proof, not mockups).
 *
 * Light and dark captures of the same screen are rendered as a pair; the
 * hidden variant is `loading="lazy"` (next/image default), so the browser
 * only fetches the image for the active theme. Both variants carry explicit
 * intrinsic dimensions — no layout shift.
 */
function Screenshot({
  light,
  dark,
  width,
  height,
  alt,
  caption,
  sizes,
  frameClassName,
  imgClassName,
}: {
  light: string;
  dark?: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  sizes: string;
  frameClassName?: string;
  imgClassName?: string;
}) {
  return (
    <figure className="mt-8">
      <div
        className={`border-border bg-card overflow-hidden rounded-xl border shadow-sm ${
          frameClassName ?? ""
        }`}
      >
        <Image
          src={light}
          alt={alt}
          width={width}
          height={height}
          sizes={sizes}
          className={`h-auto w-full dark:hidden ${imgClassName ?? ""}`}
        />
        {dark ? (
          <Image
            src={dark}
            alt=""
            aria-hidden="true"
            width={width}
            height={height}
            sizes={sizes}
            className={`hidden h-auto w-full dark:block ${imgClassName ?? ""}`}
          />
        ) : null}
      </div>
      <figcaption className="text-muted-foreground mt-3 text-center text-xs">
        {caption}
      </figcaption>
    </figure>
  );
}

function GoodToKnow({ children }: { children: ReactNode }) {
  return (
    <aside className="border-border bg-muted/40 text-muted-foreground mt-6 flex max-w-2xl items-start gap-2.5 rounded-lg border px-4 py-3 text-sm leading-relaxed">
      <Info
        aria-hidden="true"
        className="text-primary mt-0.5 size-4 shrink-0"
      />
      <p>
        <strong className="text-foreground font-medium">Good to know:</strong>{" "}
        {children}
      </p>
    </aside>
  );
}

/** Screenshot geometry per capability — all captures live in public/screenshots. */
const WIDE_SIZES = "(min-width: 1064px) 1024px, calc(100vw - 2rem)";

const featureMedia: Record<string, ReactNode> = {
  "cloud-save": (
    <Screenshot
      light="/screenshots/extension-sidepanel-ready.png"
      width={420}
      height={780}
      sizes="320px"
      frameClassName="mx-auto max-w-[320px] p-2"
      alt="The PagePocket browser extension side panel connected to a web page, showing the Start download button and the save progress steps"
      caption="The extension side panel: one click saves the page you're reading to your archive."
    />
  ),
  "clean-viewer": (
    <Screenshot
      light="/screenshots/viewer-light.png"
      dark="/screenshots/viewer-dark.png"
      width={2880}
      height={1800}
      sizes={WIDE_SIZES}
      alt="A saved Wikipedia article on web archiving shown in the PagePocket viewer, with the original layout and images intact"
      caption="An archived Wikipedia article in the viewer — original layout and images, no running code."
    />
  ),
  collections: (
    <Screenshot
      light="/screenshots/collections-light.png"
      dark="/screenshots/collections-dark.png"
      width={2880}
      height={1800}
      sizes={WIDE_SIZES}
      alt="A PagePocket collection view listing three saved pages inside the Research sources collection"
      caption="A collection view in the library: saved pages grouped and colour-coded."
    />
  ),
  "full-text-search": (
    <Screenshot
      light="/screenshots/search-light.png"
      dark="/screenshots/search-dark.png"
      width={2880}
      height={1800}
      sizes={WIDE_SIZES}
      alt="PagePocket full-text search results for the query preservation, showing two saved pages with matching text snippets"
      caption="Full-text search for “preservation”: two saved pages match, with snippets in context."
    />
  ),
  "shareable-links": (
    <Screenshot
      light="/screenshots/share-light.png"
      dark="/screenshots/share-dark.png"
      width={2880}
      height={1800}
      sizes={WIDE_SIZES}
      alt="A shared PagePocket page as recipients see it: the archived Wikipedia article on web archiving under a Shared via PagePocket banner"
      caption="What a recipient sees: the archived page on its public link, signed out."
    />
  ),
};

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Capabilities"
        title="Keep the pages that matter — exactly as you saw them"
        lede="PagePocket saves any web page to your private, searchable cloud archive in one click, then keeps it readable, organised, and shareable long after the original disappears."
        actions={
          <>
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Create a free account
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

      {/* Table of contents */}
      <Container size="default" className="pb-4 sm:pb-8">
        <nav
          aria-label="On this page"
          className="border-border bg-card rounded-xl border p-4 sm:p-6"
        >
          <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
            On this page
          </p>
          <ul className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <li key={feature.id}>
                <a
                  href={`#${feature.id}`}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm transition-colors"
                >
                  <feature.icon className="text-primary size-4 shrink-0" />
                  {feature.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </Container>

      {/* Feature sections */}
      {features.map((feature) => (
        <Section
          key={feature.id}
          id={feature.id}
          className="scroll-mt-24"
          align="start"
          eyebrow={
            <span className="inline-flex items-center gap-1.5">
              <feature.icon aria-hidden="true" className="size-3.5" />
              {feature.verb}
            </span>
          }
          title={feature.title}
          subtitle={feature.lead}
        >
          <p className="text-muted-foreground max-w-2xl leading-relaxed">
            {feature.how}
          </p>
          {featureMedia[feature.id]}
          {feature.note ? <GoodToKnow>{feature.note}</GoodToKnow> : null}
        </Section>
      ))}

      {/* CTA band */}
      <Section spacing="lg">
        <div className="border-primary/20 from-primary/10 via-primary/5 rounded-3xl border bg-gradient-to-br to-teal-400/10 px-8 py-16 text-center">
          <h2 className="text-foreground text-3xl font-bold tracking-tight">
            Start your archive today
          </h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-lg">
            Free gives you 50 saves a month and 500 MB — no credit card. Pro is
            $2/month when you outgrow it.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Create a free account
            </Button>
            <Button
              size="lg"
              variant="ghost"
              nativeButton={false}
              render={<Link href="/pricing" />}
            >
              See pricing
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
