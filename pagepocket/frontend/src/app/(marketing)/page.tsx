import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  Archive,
  Search,
  FolderTree,
  Share2,
  Eye,
  Link2,
  SearchX,
  LayoutGrid,
  ArrowRight,
  FlaskConical,
  Newspaper,
  Code2,
  LibraryBig,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/marketing/section";
import { CHROME_WEB_STORE_URL } from "@/components/marketing/site-json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { FaqList } from "@/components/marketing/faq-list";
import {
  ComparisonTable,
  type ComparisonColumn,
  type ComparisonRow,
} from "@/components/marketing/comparison-table";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  title: {
    absolute: "PagePocket — Your private Wayback Machine",
  },
  description:
    "Save any web page in full fidelity — HTML, CSS, images, fonts — to a private, full-text searchable cloud archive. Organise collections, share with clean links. Free to start.",
  alternates: {
    canonical: "https://pagepocket.app",
  },
  openGraph: {
    title: "PagePocket — Your private Wayback Machine",
    description: "Save, organise, search, and share web pages.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PagePocket — Your private Wayback Machine",
    description: "Save, organise, search, and share web pages.",
  },
};

/* ------------------------------------------------------------------------ */
/* Pain recognition                                                          */
/* ------------------------------------------------------------------------ */

const painPoints = [
  {
    icon: Link2,
    title: "Link rot",
    description:
      "The source you cited is a 404. Pages disappear or get rewritten without notice — and your work depends on what they said.",
  },
  {
    icon: LayoutGrid,
    title: "Tab overload",
    description:
      "37 open tabs “to read later”, gone the moment the browser crashes. Tabs are a to-do list, not an archive.",
  },
  {
    icon: SearchX,
    title: "Unsearchable bookmarks",
    description:
      "Bookmarks store URLs, not content. You know the page said it — good luck finding where.",
  },
];

/* ------------------------------------------------------------------------ */
/* How it works                                                              */
/* ------------------------------------------------------------------------ */

const steps = [
  {
    label: "Save",
    description:
      "Open any page and hit save in the PagePocket extension. The full page — HTML, CSS, images, fonts — goes straight to your cloud archive.",
    image: {
      src: "/screenshots/extension-onboarding.png",
      alt: "PagePocket extension onboarding: “Save pages with PagePocket” — drop any web page into your personal cloud archive",
      width: 420,
      height: 780,
      className: "mx-auto w-full max-w-64",
    },
  },
  {
    label: "Organise",
    description:
      "Every saved page lands in your library. Group related pages into collections so the material stays yours to navigate.",
    image: {
      src: "/screenshots/library-light.png",
      srcDark: "/screenshots/library-dark.png",
      alt: "PagePocket library: three archived pages grouped in the “Research sources” collection",
      width: 2880,
      height: 1800,
      className: "w-full",
      sizes: "(min-width: 640px) 33vw, 100vw",
    },
  },
  {
    label: "Find & share",
    description:
      "Search every word of every saved page, then share any page with a clean link — with an optional expiry.",
    image: {
      src: "/screenshots/share-light.png",
      srcDark: "/screenshots/share-dark.png",
      alt: "A PagePocket shared link: the full archived Wikipedia article with a “Shared via PagePocket” banner",
      width: 2880,
      height: 1800,
      className: "w-full",
      sizes: "(min-width: 640px) 33vw, 100vw",
    },
  },
] as const;

/* ------------------------------------------------------------------------ */
/* Persona strip                                                             */
/* ------------------------------------------------------------------------ */

const personas = [
  {
    icon: FlaskConical,
    href: "/use-cases/researchers",
    title: "Researchers",
    description:
      "Papers, preprints, and sources that are still there — unchanged — when you cite them.",
  },
  {
    icon: Newspaper,
    href: "/use-cases/journalists",
    title: "Journalists",
    description:
      "Keep every source exactly as it read on the day you reported it.",
  },
  {
    icon: Code2,
    href: "/use-cases/developers",
    title: "Developers",
    description:
      "Freeze docs, issues, and changelogs before the next redesign erases them.",
  },
  {
    icon: LibraryBig,
    href: "/use-cases/archivists",
    title: "Archivists",
    description:
      "Curate web history into private, searchable, shareable collections.",
  },
];

/* ------------------------------------------------------------------------ */
/* Comparison                                                                */
/* ------------------------------------------------------------------------ */

const comparisonColumns: readonly ComparisonColumn[] = [
  { id: "pagepocket", name: "PagePocket" },
  { id: "bookmarks", name: "Browser bookmarks" },
  { id: "singlefile", name: "Local-only saver (SingleFile)" },
  { id: "wayback", name: "Public archive (Wayback Machine)" },
];

const comparisonRows: readonly ComparisonRow[] = [
  {
    feature: "Saves the full page — styles, images, fonts",
    values: {
      pagepocket: true,
      bookmarks: false,
      singlefile: true,
      wayback: true,
    },
    note: "SingleFile genuinely saves complete pages — as local files on one device. Wayback captures are automated and can miss assets or be blocked by a site’s robots rules.",
  },
  {
    feature: "Private — only you see what you saved",
    values: {
      pagepocket: true,
      bookmarks: true,
      singlefile: true,
      wayback: false,
    },
    note: "Local tools are private too. What they can’t do is follow you across devices, stay searchable, or turn into a shareable link.",
  },
  {
    feature: "Full-text search of everything you saved",
    values: {
      pagepocket: true,
      bookmarks: false,
      singlefile: false,
      wayback: "Archive-wide, not your collection",
    },
  },
  {
    feature: "Share via a clean link",
    values: {
      pagepocket: true,
      bookmarks: false,
      singlefile: "You’d send the file",
      wayback: "If a capture exists",
    },
  },
  {
    feature: "Works when the original site dies",
    values: {
      pagepocket: true,
      bookmarks: false,
      singlefile: true,
      wayback: "Only what they captured",
    },
  },
  {
    feature: "Organised collections",
    values: {
      pagepocket: true,
      bookmarks: "Folders only",
      singlefile: "Manual file folders",
      wayback: false,
    },
  },
];

/* ------------------------------------------------------------------------ */
/* FAQ                                                                       */
/* ------------------------------------------------------------------------ */

const faqs = [
  {
    question: "What browsers are supported?",
    answer:
      "PagePocket is built for Chrome and works in any Chromium-based browser — Chrome, Edge, Brave, Arc, and others. It’s published on the Chrome Web Store. There is no Firefox version.",
  },
  {
    question: "Is it really free?",
    answer:
      "Yes — the Free plan gives you 50 page saves per month and 500 MB of cloud storage, with full-text search and shareable links included. No credit card required. If you need more, Pro raises storage to 10 GB for $2/month (billed yearly).",
  },
  {
    question: "What exactly gets saved when I save a page?",
    answer:
      "The complete page: HTML, CSS, images, and fonts are captured into a single-file archive in your cloud library. What you read later is the page as it was when you saved it — not a screenshot and not a summary.",
  },
  {
    question: "What happens if the original page goes offline?",
    answer:
      "Your saved copy is preserved exactly as it was — HTML, CSS, images, and all. You can always view it in the clean reader, even if the source disappears.",
  },
  {
    question: "Who can see the pages I save?",
    answer:
      "Only you. Your library is private to your account. A page becomes visible to someone else only when you create a share link — and you decide whether that link expires.",
  },
  {
    question: "Can I share pages with people who don’t have an account?",
    answer:
      "Yes. Generate a shareable link and anyone can view the saved page — no account needed. You can set an expiry (from 24 hours to never) and see how many times the link has been viewed.",
  },
  {
    question: "Can I keep a local copy of my pages?",
    answer:
      "Yes — alongside the cloud archive, the extension can save the full page structure as a ZIP archive to your device, and you can download any saved page as a ZIP from your dashboard at any time. The cloud library is for search and sharing; the local export is yours to keep.",
  },
  {
    question: "How is this different from bookmarks or the Wayback Machine?",
    answer:
      "Bookmarks store URLs — if the page changes or disappears, the content is gone. The Wayback Machine archives the public web at scale, but it decides what gets captured and every capture is public. PagePocket is your own archive: you choose the pages, they stay private, and every word is searchable.",
  },
  {
    question: "Is PagePocket open source?",
    answer:
      "The browser extension is open source — you can read exactly what it captures at github.com/SeoWeb/Web-Downloader-Extension.",
  },
];

/* ------------------------------------------------------------------------ */
/* Hero screenshot annotations                                               */
/* ------------------------------------------------------------------------ */

const heroCallouts = [
  {
    label: "Searches every page you’ve saved",
    dot: "left-[21%] top-[2.4%]",
    chip: "left-[24%] top-[0.6%]",
  },
  {
    label: "Organised into collections",
    dot: "left-[5%] top-[12.2%]",
    chip: "left-[3%] top-[16.5%]",
  },
  {
    label: "Full page — styles, images & text intact",
    dot: "left-[36%] top-[35%]",
    chip: "left-[38.5%] top-[32.5%]",
  },
] as const;

export default function LandingPage() {
  return (
    <>
      {/* 1 + 2 · Hero + annotated real screenshot */}
      <PageHero
        eyebrow={
          <>
            <Archive className="size-3" aria-hidden="true" />
            Private web archiving for professionals
          </>
        }
        title="Your private Wayback Machine"
        lede="PagePocket saves any web page in full fidelity — HTML, CSS, images, fonts — into a private, full-text searchable archive you own. Revisit it forever, or share it with a clean link."
        actions={
          <>
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Start free
            </Button>
            <Button
              size="lg"
              variant="outline"
              nativeButton={false}
              render={<Link href="/features" />}
            >
              Explore features
            </Button>
          </>
        }
        containerSize="default"
        className="relative"
      >
        <p className="text-muted-foreground mx-auto mt-3 w-fit text-xs">
          Free &middot; No credit card
        </p>

        {/* Annotated product screenshot — the real viewer, not a mockup */}
        <div className="relative mx-auto mt-12 max-w-4xl sm:mt-16">
          <figure
            data-slot="hero-screenshot"
            className="border-border bg-card relative overflow-hidden rounded-xl border shadow-2xl"
          >
            {/* Both themes ship; the hidden variant never downloads because
                lazy-loaded images with no layout box never intersect. */}
            <Image
              src="/screenshots/viewer-light.png"
              alt="The PagePocket viewer: an archived Wikipedia article on web archiving, rendered with full fidelity beside the “Research sources” collection"
              width={2880}
              height={1800}
              sizes="(min-width: 1024px) 896px, 100vw"
              className="dark:hidden"
            />
            <Image
              src="/screenshots/viewer-dark.png"
              alt=""
              aria-hidden="true"
              width={2880}
              height={1800}
              sizes="(min-width: 1024px) 896px, 100vw"
              className="hidden dark:block"
            />

            {/* Annotation callouts — CSS-positioned, decorative */}
            <div className="pointer-events-none absolute inset-0 hidden sm:block">
              {heroCallouts.map((callout) => (
                <div key={callout.label}>
                  <span
                    aria-hidden="true"
                    className={`bg-primary absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-teal-500/20 ${callout.dot}`}
                  />
                  <span
                    className={`border-border bg-background/95 text-foreground absolute rounded-full border px-2.5 py-1 text-[11px] leading-none font-medium shadow-sm ${callout.chip}`}
                  >
                    {callout.label}
                  </span>
                </div>
              ))}
            </div>

            <figcaption className="sr-only">
              The saved page renders exactly as the original: styles, images,
              and text intact, searchable from the bar at the top, filed under
              your collections in the sidebar.
            </figcaption>
          </figure>

          {/* Callout list for small screens, where the chips won&apos;t fit */}
          <ul className="text-muted-foreground mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs sm:hidden">
            {heroCallouts.map((callout) => (
              <li key={callout.label} className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="bg-primary size-1.5 rounded-full"
                />
                {callout.label}
              </li>
            ))}
          </ul>
        </div>
      </PageHero>

      {/* 3 · Pain recognition */}
      <Section
        eyebrow="Sound familiar?"
        title="Your work depends on pages the web won’t keep"
        subtitle="The modern web is fragile. Citations rot, redesigns rewrite history, and “save for later” habits keep none of it."
      >
        <div className="grid gap-6 sm:grid-cols-3">
          {painPoints.map((pain) => (
            <div
              key={pain.title}
              className="border-border bg-card rounded-xl border p-6 text-center"
            >
              <div className="bg-destructive/10 text-destructive mx-auto mb-4 flex size-12 items-center justify-center rounded-full">
                <pain.icon className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mb-1 font-semibold">{pain.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {pain.description}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-10 text-center">
          <span className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium">
            <Archive className="size-4" aria-hidden="true" />
            PagePocket fixes all three.
          </span>
        </div>
      </Section>

      {/* 4 · How it works — real captures */}
      <Section
        eyebrow="How it works"
        title="From open tab to permanent page in three steps"
        subtitle="No import rituals, no manual filing. Save from the page you’re already reading."
        className="bg-muted/30"
      >
        <ol className="grid gap-10 sm:grid-cols-3 sm:gap-8">
          {steps.map((step, i) => (
            <li key={step.label} className="flex flex-col">
              <div className="mb-4 flex items-center gap-3">
                <span className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold">
                  {i + 1}
                </span>
                <h3 className="font-semibold">{step.label}</h3>
              </div>
              <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
                {step.description}
              </p>
              <div className="border-border bg-card mt-auto overflow-hidden rounded-xl border shadow-sm">
                {"srcDark" in step.image ? (
                  <>
                    <Image
                      src={step.image.src}
                      alt={step.image.alt}
                      width={step.image.width}
                      height={step.image.height}
                      sizes={step.image.sizes}
                      className={`${step.image.className} dark:hidden`}
                    />
                    <Image
                      src={step.image.srcDark}
                      alt=""
                      aria-hidden="true"
                      width={step.image.width}
                      height={step.image.height}
                      sizes={step.image.sizes}
                      className={`${step.image.className} hidden dark:block`}
                    />
                  </>
                ) : (
                  <Image
                    src={step.image.src}
                    alt={step.image.alt}
                    width={step.image.width}
                    height={step.image.height}
                    className={step.image.className}
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* 5 · Feature bento */}
      <Section
        eyebrow="Features"
        title="Everything a personal archive needs"
        subtitle="Save, read, search, organise, and share — one extension, one library."
      >
        <div className="grid auto-rows-fr grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {/* Cloud Save — large card, spans 2 cols */}
          <div className="group border-border bg-card hover:border-primary/30 relative overflow-hidden rounded-xl border p-6 transition-all hover:shadow-lg sm:col-span-2">
            <div className="bg-primary/5 absolute top-0 right-0 -z-0 h-48 w-48 rounded-bl-full" />
            <div className="relative">
              <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
                <Archive className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mb-2 font-semibold">Cloud Save</h3>
              <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
                Save any web page with one click. Full HTML, styles, and images
                stored securely in the cloud — even if the original goes
                offline.
              </p>
              <div className="bg-muted/50 border-border mt-4 flex items-center gap-3 rounded-lg border px-3 py-2">
                <div className="bg-primary/10 flex size-8 items-center justify-center rounded">
                  <Archive className="text-primary size-4" aria-hidden="true" />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="bg-muted h-1.5 w-3/4 rounded" />
                  <div className="bg-muted h-1.5 w-1/2 rounded" />
                </div>
                <div className="text-primary text-[10px] font-medium">
                  Saved
                </div>
              </div>
            </div>
          </div>

          {/* Search — standard card */}
          <div className="group border-border bg-card hover:border-primary/30 rounded-xl border p-6 transition-all hover:shadow-lg">
            <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
              <Search className="size-5" aria-hidden="true" />
            </div>
            <h3 className="mb-2 font-semibold">Full-Text Search</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Search across every saved page with instant results and
              highlighted snippets.
            </p>
          </div>

          {/* Clean Viewer — standard card */}
          <div className="group border-border bg-card hover:border-primary/30 rounded-xl border p-6 transition-all hover:shadow-lg">
            <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
              <Eye className="size-5" aria-hidden="true" />
            </div>
            <h3 className="mb-2 font-semibold">Clean Viewer</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Read saved pages in a distraction-free reader that strips trackers
              while preserving layout.
            </p>
          </div>

          {/* Collections — large card, spans 2 cols */}
          <div className="group border-border bg-card hover:border-primary/30 relative overflow-hidden rounded-xl border p-6 transition-all hover:shadow-lg sm:col-span-2">
            <div className="bg-primary/5 absolute bottom-0 left-0 -z-0 h-48 w-48 rounded-tr-full" />
            <div className="relative">
              <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
                <FolderTree className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mb-2 font-semibold">Collections</h3>
              <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
                Organise pages into nested collections with drag and drop.
                Colour-code, rename, and navigate your archive effortlessly.
              </p>
              <div className="bg-muted/50 border-border mt-4 flex items-center gap-2 rounded-lg border px-3 py-2">
                <FolderTree
                  className="text-primary size-4"
                  aria-hidden="true"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <div className="bg-primary/60 size-2 rounded-full" />
                    <div className="bg-muted h-1.5 w-20 rounded" />
                  </div>
                  <div className="flex items-center gap-1.5 pl-3">
                    <div className="bg-muted-foreground/30 size-1.5 rounded-full" />
                    <div className="bg-muted h-1.5 w-16 rounded" />
                  </div>
                  <div className="flex items-center gap-1.5 pl-3">
                    <div className="bg-muted-foreground/30 size-1.5 rounded-full" />
                    <div className="bg-muted h-1.5 w-24 rounded" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Shareable Links — standard card */}
          <div className="group border-border bg-card hover:border-primary/30 rounded-xl border p-6 transition-all hover:shadow-lg">
            <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
              <Share2 className="size-5" aria-hidden="true" />
            </div>
            <h3 className="mb-2 font-semibold">Shareable Links</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              Share any saved page with a public or private link. Set expiry,
              control access, and track views.
            </p>
          </div>
        </div>
      </Section>

      {/* 5b · Browser extension — one click from reading to archived */}
      <Section
        eyebrow="Browser extension"
        title="One click from any page to your archive"
        subtitle="The PagePocket extension adds a side panel to Chrome: while you read, one click saves the full page — HTML, CSS, images, fonts — to your private, full-text searchable archive."
        id="extension"
      >
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <ul className="text-muted-foreground space-y-3 text-sm leading-relaxed">
              <li className="flex items-start gap-2.5">
                <Check
                  className="text-primary mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                Full-fidelity capture — the page as it was, not a screenshot.
              </li>
              <li className="flex items-start gap-2.5">
                <Check
                  className="text-primary mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                Everything lands in your own library — no account sharing, no
                public by default.
              </li>
              <li className="flex items-start gap-2.5">
                <Check
                  className="text-primary mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                Save without interrupting your reading — the panel sits beside
                the page.
              </li>
            </ul>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                nativeButton={false}
                render={
                  <a
                    href={CHROME_WEB_STORE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  />
                }
              >
                Install for Chrome
              </Button>
              <Button
                size="lg"
                variant="outline"
                nativeButton={false}
                render={<Link href="/features" />}
              >
                Explore features
              </Button>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">
              Free to start &middot; No credit card
            </p>
          </div>

          {/* Real side-panel capture (proof, not mockups). No dark variant
              exists for this PNG, so the light capture renders in both
              themes — no dark:hidden pair here. */}
          <figure>
            <div className="border-border bg-card mx-auto max-w-[360px] overflow-hidden rounded-xl border p-2 shadow-sm">
              <Image
                src="/screenshots/extension-sidepanel-ready.png"
                alt="The PagePocket browser extension side panel connected to a web page, showing the Start download button and the save progress steps"
                width={420}
                height={780}
                sizes="(min-width: 1024px) 360px, (min-width: 640px) 50vw, calc(100vw - 2rem)"
                className="h-auto w-full"
              />
            </div>
            <figcaption className="text-muted-foreground mt-3 text-center text-xs">
              The PagePocket side panel — save and read anywhere.
            </figcaption>
          </figure>
        </div>
      </Section>

      {/* 6 · Persona strip */}
      <Section
        eyebrow="Built for professionals"
        title="Made for people whose work has to hold up"
        subtitle="Different professions, same requirement: the page must still be there — and say what it said."
        className="bg-muted/30"
      >
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {personas.map((persona) => (
            <Link
              key={persona.href}
              href={persona.href}
              className="group border-border bg-card hover:border-primary/30 flex flex-col rounded-xl border p-6 transition-all hover:shadow-lg"
            >
              <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
                <persona.icon className="size-5" aria-hidden="true" />
              </div>
              <h3 className="mb-1.5 font-semibold">{persona.title}</h3>
              <p className="text-muted-foreground mb-4 text-sm leading-relaxed">
                {persona.description}
              </p>
              <span className="text-primary mt-auto inline-flex items-center gap-1 text-sm font-medium">
                See the workflow
                <ArrowRight
                  className="size-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden="true"
                />
              </span>
            </Link>
          ))}
        </div>
      </Section>

      {/* 7 · Honest comparison */}
      <Section
        eyebrow="Honest comparison"
        title="How PagePocket compares"
        subtitle="Every tool here is good at something. Here is what each does well — and where it stops."
        containerSize="wide"
      >
        <ComparisonTable
          columns={comparisonColumns}
          rows={comparisonRows}
          highlightColumn="pagepocket"
          caption="PagePocket compared with browser bookmarks, local-only savers such as SingleFile, and public archives such as the Wayback Machine"
        />
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed">
          Bookmarks are instant and universal. SingleFile is excellent at what
          it does — complete local copies. The Wayback Machine preserves the
          public web at a scale no individual could. PagePocket combines the
          pieces professionals need: full fidelity plus privacy, search,
          organisation, and sharing.{" "}
          <Link
            href="/compare/singlefile"
            className="text-primary hover:underline"
          >
            PagePocket vs SingleFile
          </Link>{" "}
          and{" "}
          <Link
            href="/compare/wayback"
            className="text-primary hover:underline"
          >
            PagePocket vs the Wayback Machine
          </Link>{" "}
          go deeper.
        </p>
      </Section>

      {/* 8 · FAQ */}
      <Section
        eyebrow="FAQ"
        title="Frequently asked questions"
        subtitle={
          <>
            Can’t find what you’re looking for?{" "}
            <Link
              href="https://github.com/SeoWeb/Web-Downloader-Extension/issues"
              className="text-primary hover:underline"
            >
              Open an issue
            </Link>
            .
          </>
        }
        containerSize="narrow"
        className="bg-muted/30"
      >
        <FaqList items={faqs} />
      </Section>

      {/* 9 · CTA band */}
      <section className="py-section">
        <div className="from-primary/10 via-primary/5 border-primary/20 mx-auto max-w-3xl rounded-3xl border bg-gradient-to-br to-teal-400/10 px-8 py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Start your private archive today
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            Free plan &middot; No credit card &middot; Your first page saved in
            under a minute.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Start free
            </Button>
            <Button
              size="lg"
              variant="ghost"
              nativeButton={false}
              render={<Link href="/features" />}
            >
              See it in action
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
