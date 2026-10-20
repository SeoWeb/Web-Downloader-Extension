import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Archive,
  Search,
  FolderTree,
  Share2,
  Eye,
  Download,
  Sparkles,
  Link2,
  SearchX,
  LayoutGrid,
  ChevronDown,
  Shield,
  Fingerprint,
  Globe,
} from "lucide-react";
import { ProductMockup } from "@/components/marketing/product-mockup";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  title: {
    absolute: "PagePocket — Save, organise, search, and share web pages",
  },
  description:
    "The web archive that works for you. Save any page instantly, organise into collections, search full text, and share with links.",
  alternates: {
    canonical: "https://pagepocket.app",
  },
  openGraph: {
    title: "PagePocket",
    description: "Save, organise, search, and share web pages",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "PagePocket",
    description: "Save, organise, search, and share web pages",
  },
};

const painPoints = [
  {
    icon: Link2,
    title: "Link rot",
    description: "That article you bookmarked? Gone. 404.",
  },
  {
    icon: LayoutGrid,
    title: "Tab overload",
    description: "37 open tabs and you still can\u2019t find the one you need.",
  },
  {
    icon: SearchX,
    title: "No search",
    description:
      "Bookmarks save URLs, not content. Good luck finding that quote.",
  },
];

const steps = [
  {
    icon: Download,
    label: "Install",
    description: "Add the browser extension in one click.",
  },
  {
    icon: Archive,
    label: "Save",
    description: "Capture any page to your cloud archive instantly.",
  },
  {
    icon: Search,
    label: "Find & share",
    description: "Search full text and share with a link.",
  },
];

const testimonials = [
  {
    quote:
      "I save 20+ papers a week. PagePocket is my searchable reading list.",
    name: "Dr. Sarah Chen",
    role: "Researcher",
  },
  {
    quote: "Sources disappear overnight. My archive doesn\u2019t.",
    name: "Marcus Webb",
    role: "Journalist",
  },
  {
    quote: "Bookmark folders are chaos. Collections are the answer.",
    name: "Aiko Tanaka",
    role: "Developer",
  },
];

const faqs = [
  {
    question: "What browsers are supported?",
    answer:
      "PagePocket works on Chrome, Edge, Brave, and any Chromium-based browser. A Firefox version is planned.",
  },
  {
    question: "Is it really free?",
    answer:
      "Yes \u2014 the Free plan gives you 50 page saves per month with 500 MB of cloud storage, full-text search, and shareable links. No credit card required.",
  },
  {
    question: "What happens if the original page goes offline?",
    answer:
      "Your saved copy is preserved exactly as it was \u2014 HTML, CSS, images, and all. You can always view it in the clean reader, even if the source disappears.",
  },
  {
    question: "Can I share pages with people who don\u2019t have an account?",
    answer:
      "Absolutely. Generate a shareable link and anyone can view the saved page. You can set an expiry time and track how many times it\u2019s been viewed.",
  },
  {
    question: "How is this different from bookmarks or the Wayback Machine?",
    answer:
      "Bookmarks only save URLs \u2014 if the page changes or disappears, you lose the content. The Wayback Machine archives the public web, not pages you care about. PagePocket gives you a personal, searchable archive of the pages you choose.",
  },
];

export default function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden px-4 py-28">
        {/* Background glow + grid */}
        <div className="absolute inset-0 -z-10">
          <div className="bg-primary/8 absolute top-0 left-1/2 h-[600px] w-[900px] -translate-x-1/2 rounded-full blur-3xl" />
          <div
            className="absolute inset-0 opacity-[0.03]"
            style={{
              backgroundImage:
                "radial-gradient(circle, currentColor 1px, transparent 1px)",
              backgroundSize: "24px 24px",
            }}
          />
        </div>

        <div className="relative mx-auto max-w-3xl text-center">
          <div className="border-primary/20 bg-primary/5 text-primary mb-6 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3" />
            Browser extension for Chrome
          </div>
          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Web pages vanish.
            <br />
            <span className="from-primary bg-gradient-to-r to-teal-400 bg-clip-text text-transparent">
              Your archive doesn&apos;t.
            </span>
          </h1>
          <p className="text-muted-foreground mx-auto mt-6 max-w-xl text-lg leading-relaxed">
            Save any page instantly, organise into collections, search full
            text, and share with links. The web archive that works for you.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <Button
              size="lg"
              nativeButton={false}
              render={<Link href="/register" />}
              className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
            >
              Save your first page &mdash; it&apos;s free
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
          <p className="text-muted-foreground mt-3 text-xs">
            Free forever &middot; No credit card required
          </p>
        </div>

        <div className="mt-16 px-4">
          <ProductMockup />
        </div>
      </section>

      {/* Pain / Solution */}
      <section className="px-4 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-semibold">
            Sound familiar?
          </h2>
          <p className="text-muted-foreground mx-auto mb-12 max-w-lg text-center">
            The modern web is fragile. PagePocket isn&apos;t.
          </p>
          <div className="mb-12 grid gap-6 sm:grid-cols-3">
            {painPoints.map((pain) => (
              <div
                key={pain.title}
                className="border-border bg-card rounded-xl border p-6 text-center"
              >
                <div className="bg-destructive/10 text-destructive mx-auto mb-4 flex size-12 items-center justify-center rounded-full">
                  <pain.icon className="size-5" />
                </div>
                <h3 className="mb-1 font-semibold">{pain.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {pain.description}
                </p>
              </div>
            ))}
          </div>
          <div className="text-center">
            <span className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium">
              <Archive className="size-4" />
              PagePocket solves all three.
            </span>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="bg-muted/30 px-4 py-20">
        <div className="mx-auto max-w-4xl">
          <h2 className="mb-4 text-center text-2xl font-semibold">
            Three steps to your personal web archive
          </h2>
          <p className="text-muted-foreground mx-auto mb-14 max-w-md text-center">
            From browser tab to searchable archive in seconds.
          </p>
          <div className="relative grid gap-8 sm:grid-cols-3">
            {/* Connecting line */}
            <div className="border-primary/30 absolute top-6 right-[20%] left-[20%] hidden border-t border-dashed sm:block" />
            {steps.map((step, i) => (
              <div key={step.label} className="relative text-center">
                <div className="bg-primary text-primary-foreground shadow-primary/20 relative mx-auto mb-4 flex size-12 items-center justify-center rounded-full text-lg font-bold shadow-lg">
                  {i + 1}
                </div>
                <div className="mb-2 flex items-center justify-center gap-2">
                  <step.icon className="text-primary size-4" />
                  <h3 className="font-semibold">{step.label}</h3>
                </div>
                <p className="text-muted-foreground text-sm">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Bento Grid */}
      <section className="px-4 py-24">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-semibold">
            Everything you need to never lose a web page again
          </h2>
          <p className="text-muted-foreground mx-auto mb-12 max-w-lg text-center">
            Save, read, search, and share &mdash; all from a single extension.
          </p>
          <div className="grid auto-rows-fr grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {/* Cloud Save — large card, spans 2 cols */}
            <div className="group border-border bg-card hover:border-primary/30 relative overflow-hidden rounded-xl border p-6 transition-all hover:shadow-lg sm:col-span-2">
              <div className="bg-primary/5 absolute top-0 right-0 -z-0 h-48 w-48 rounded-bl-full" />
              <div className="relative">
                <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
                  <Archive className="size-5" />
                </div>
                <h3 className="mb-2 font-semibold">Cloud Save</h3>
                <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
                  Save any web page with one click. Full HTML, styles, and
                  images stored securely in the cloud &mdash; even if the
                  original goes offline.
                </p>
                {/* Mini illustration */}
                <div className="bg-muted/50 border-border mt-4 flex items-center gap-3 rounded-lg border px-3 py-2">
                  <div className="bg-primary/10 flex size-8 items-center justify-center rounded">
                    <Archive className="text-primary size-4" />
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
                <Search className="size-5" />
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
                <Eye className="size-5" />
              </div>
              <h3 className="mb-2 font-semibold">Clean Viewer</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Read saved pages in a distraction-free reader that strips
                trackers while preserving layout.
              </p>
            </div>

            {/* Collections — large card, spans 2 cols */}
            <div className="group border-border bg-card hover:border-primary/30 relative overflow-hidden rounded-xl border p-6 transition-all hover:shadow-lg sm:col-span-2">
              <div className="bg-primary/5 absolute bottom-0 left-0 -z-0 h-48 w-48 rounded-tr-full" />
              <div className="relative">
                <div className="bg-primary/10 text-primary group-hover:bg-primary/15 mb-4 flex size-10 items-center justify-center rounded-lg transition-colors">
                  <FolderTree className="size-5" />
                </div>
                <h3 className="mb-2 font-semibold">Collections</h3>
                <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
                  Organise pages into nested collections with drag and drop.
                  Colour-code, rename, and navigate your archive effortlessly.
                </p>
                {/* Mini illustration */}
                <div className="bg-muted/50 border-border mt-4 flex items-center gap-2 rounded-lg border px-3 py-2">
                  <FolderTree className="text-primary size-4" />
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
                <Share2 className="size-5" />
              </div>
              <h3 className="mb-2 font-semibold">Shareable Links</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Share any saved page with a public or private link. Set expiry,
                control access, and track views.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof — Testimonials */}
      <section className="bg-muted/30 px-4 py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="mb-4 text-center text-2xl font-semibold">
            Trusted by archivers everywhere
          </h2>
          <p className="text-muted-foreground mx-auto mb-12 max-w-md text-center">
            Researchers, journalists, developers, and writers who can&apos;t
            afford to lose a page.
          </p>
          <div className="mb-12 grid gap-6 sm:grid-cols-3">
            {testimonials.map((t) => (
              <div
                key={t.name}
                className="border-border bg-card rounded-xl border p-6"
              >
                <div className="text-primary/30 mb-3 font-serif text-2xl leading-none">
                  &ldquo;
                </div>
                <p className="text-foreground mb-4 text-sm leading-relaxed">
                  {t.quote}
                </p>
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-muted-foreground text-xs">{t.role}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-6 text-sm">
            <span className="flex items-center gap-1.5">
              <Shield className="text-primary size-4" />
              Your data is encrypted
            </span>
            <span className="flex items-center gap-1.5">
              <Fingerprint className="text-primary size-4" />
              No tracking
            </span>
            <span className="flex items-center gap-1.5">
              <Globe className="text-primary size-4" />
              Open-source core
            </span>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-4 py-20">
        <div className="mx-auto max-w-2xl">
          <h2 className="mb-4 text-center text-2xl font-semibold">
            Frequently asked questions
          </h2>
          <p className="text-muted-foreground mb-12 text-center">
            Can&apos;t find what you&apos;re looking for?{" "}
            <Link
              href="https://github.com/anomalyco/opencode/issues"
              className="text-primary hover:underline"
            >
              Open an issue
            </Link>
            .
          </p>
          <div className="space-y-3">
            {faqs.map((faq) => (
              <details
                key={faq.question}
                className="group border-border bg-card rounded-xl border"
              >
                <summary className="[&::-webkit-details-marker]:hover:text-foreground flex cursor-pointer items-center justify-between gap-4 p-4 text-sm font-medium transition-colors select-none">
                  {faq.question}
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="text-muted-foreground px-4 pb-4 text-sm leading-relaxed">
                  {faq.answer}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Band */}
      <section className="px-4 py-24">
        <div className="from-primary/10 via-primary/5 border-primary/20 mx-auto max-w-3xl rounded-3xl border bg-gradient-to-br to-teal-400/10 px-8 py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Never lose a web page again
          </h2>
          <p className="text-muted-foreground mt-4 text-lg">
            Free forever. No credit card. Start archiving in 30 seconds.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-4">
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
