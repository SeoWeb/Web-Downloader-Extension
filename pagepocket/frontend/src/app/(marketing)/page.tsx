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

export const metadata: Metadata = {
  title: "PagePocket — Save, organise, search, and share web pages",
  description:
    "The web archive that works for you. Save any page instantly, organise into collections, search full text, and share with links.",
  openGraph: {
    title: "PagePocket",
    description: "Save, organise, search, and share web pages",
    type: "website",
    images: [
      {
        url: "https://pagepocket.app/og-landing.png",
        width: 1200,
        height: 630,
      },
    ],
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
    quote:
      "Sources disappear overnight. My archive doesn\u2019t.",
    name: "Marcus Webb",
    role: "Journalist",
  },
  {
    quote:
      "Bookmark folders are chaos. Collections are the answer.",
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
      <section className="relative overflow-hidden py-28 px-4">
        {/* Background glow + grid */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[600px] w-[900px] rounded-full bg-primary/8 blur-3xl" />
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
          <div className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            <Sparkles className="size-3" />
            Browser extension for Chrome
          </div>
          <h1 className="text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Web pages vanish.
            <br />
            <span className="bg-gradient-to-r from-primary to-teal-400 bg-clip-text text-transparent">
              Your archive doesn&apos;t.
            </span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
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
          <p className="mt-3 text-xs text-muted-foreground">
            Free forever &middot; No credit card required
          </p>
        </div>

        <div className="mt-16 px-4">
          <ProductMockup />
        </div>
      </section>

      {/* Pain / Solution */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold text-center mb-4">
            Sound familiar?
          </h2>
          <p className="text-center text-muted-foreground mb-12 max-w-lg mx-auto">
            The modern web is fragile. PagePocket isn&apos;t.
          </p>
          <div className="grid gap-6 sm:grid-cols-3 mb-12">
            {painPoints.map((pain) => (
              <div
                key={pain.title}
                className="rounded-xl border border-border bg-card p-6 text-center"
              >
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <pain.icon className="size-5" />
                </div>
                <h3 className="font-semibold mb-1">{pain.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {pain.description}
                </p>
              </div>
            ))}
          </div>
          <div className="text-center">
            <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-4 py-2 text-sm font-medium text-primary">
              <Archive className="size-4" />
              PagePocket solves all three.
            </span>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 px-4 bg-muted/30">
        <div className="mx-auto max-w-4xl">
          <h2 className="text-2xl font-semibold text-center mb-4">
            Three steps to your personal web archive
          </h2>
          <p className="text-center text-muted-foreground mb-14 max-w-md mx-auto">
            From browser tab to searchable archive in seconds.
          </p>
          <div className="grid gap-8 sm:grid-cols-3 relative">
            {/* Connecting line */}
            <div className="absolute top-6 left-[20%] right-[20%] hidden sm:block border-t border-dashed border-primary/30" />
            {steps.map((step, i) => (
              <div key={step.label} className="text-center relative">
                <div className="relative mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-lg shadow-lg shadow-primary/20">
                  {i + 1}
                </div>
                <div className="flex items-center justify-center gap-2 mb-2">
                  <step.icon className="size-4 text-primary" />
                  <h3 className="font-semibold">{step.label}</h3>
                </div>
                <p className="text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Bento Grid */}
      <section className="py-24 px-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold text-center mb-4">
            Everything you need to never lose a web page again
          </h2>
          <p className="text-center text-muted-foreground mb-12 max-w-lg mx-auto">
            Save, read, search, and share &mdash; all from a single extension.
          </p>
          <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr">
            {/* Cloud Save — large card, spans 2 cols */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-lg hover:border-primary/30 sm:col-span-2 relative overflow-hidden">
              <div className="absolute right-0 top-0 w-48 h-48 bg-primary/5 rounded-bl-full -z-0" />
              <div className="relative">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                  <Archive className="size-5" />
                </div>
                <h3 className="font-semibold mb-2">Cloud Save</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
                  Save any web page with one click. Full HTML, styles, and
                  images stored securely in the cloud &mdash; even if the
                  original goes offline.
                </p>
                {/* Mini illustration */}
                <div className="mt-4 flex items-center gap-3 rounded-lg bg-muted/50 border border-border px-3 py-2">
                  <div className="flex size-8 items-center justify-center rounded bg-primary/10">
                    <Archive className="size-4 text-primary" />
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="h-1.5 w-3/4 rounded bg-muted" />
                    <div className="h-1.5 w-1/2 rounded bg-muted" />
                  </div>
                  <div className="text-[10px] font-medium text-primary">Saved</div>
                </div>
              </div>
            </div>

            {/* Search — standard card */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-lg hover:border-primary/30">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Search className="size-5" />
              </div>
              <h3 className="font-semibold mb-2">Full-Text Search</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Search across every saved page with instant results and
                highlighted snippets.
              </p>
            </div>

            {/* Clean Viewer — standard card */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-lg hover:border-primary/30">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Eye className="size-5" />
              </div>
              <h3 className="font-semibold mb-2">Clean Viewer</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Read saved pages in a distraction-free reader that strips
                trackers while preserving layout.
              </p>
            </div>

            {/* Collections — large card, spans 2 cols */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-lg hover:border-primary/30 sm:col-span-2 relative overflow-hidden">
              <div className="absolute left-0 bottom-0 w-48 h-48 bg-primary/5 rounded-tr-full -z-0" />
              <div className="relative">
                <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                  <FolderTree className="size-5" />
                </div>
                <h3 className="font-semibold mb-2">Collections</h3>
                <p className="text-sm text-muted-foreground leading-relaxed max-w-md">
                  Organise pages into nested collections with drag and drop.
                  Colour-code, rename, and navigate your archive effortlessly.
                </p>
                {/* Mini illustration */}
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted/50 border border-border px-3 py-2">
                  <FolderTree className="size-4 text-primary" />
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <div className="size-2 rounded-full bg-primary/60" />
                      <div className="h-1.5 w-20 rounded bg-muted" />
                    </div>
                    <div className="flex items-center gap-1.5 pl-3">
                      <div className="size-1.5 rounded-full bg-muted-foreground/30" />
                      <div className="h-1.5 w-16 rounded bg-muted" />
                    </div>
                    <div className="flex items-center gap-1.5 pl-3">
                      <div className="size-1.5 rounded-full bg-muted-foreground/30" />
                      <div className="h-1.5 w-24 rounded bg-muted" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Shareable Links — standard card */}
            <div className="group rounded-xl border border-border bg-card p-6 transition-all hover:shadow-lg hover:border-primary/30">
              <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
                <Share2 className="size-5" />
              </div>
              <h3 className="font-semibold mb-2">Shareable Links</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Share any saved page with a public or private link. Set
                expiry, control access, and track views.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof — Testimonials */}
      <section className="py-20 px-4 bg-muted/30">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold text-center mb-4">
            Trusted by archivers everywhere
          </h2>
          <p className="text-center text-muted-foreground mb-12 max-w-md mx-auto">
            Researchers, journalists, developers, and writers who can&apos;t
            afford to lose a page.
          </p>
          <div className="grid gap-6 sm:grid-cols-3 mb-12">
            {testimonials.map((t) => (
              <div
                key={t.name}
                className="rounded-xl border border-border bg-card p-6"
              >
                <div className="mb-3 text-2xl leading-none text-primary/30 font-serif">
                  &ldquo;
                </div>
                <p className="text-sm text-foreground leading-relaxed mb-4">
                  {t.quote}
                </p>
                <div>
                  <div className="text-sm font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground">{t.role}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Shield className="size-4 text-primary" />
              Your data is encrypted
            </span>
            <span className="flex items-center gap-1.5">
              <Fingerprint className="size-4 text-primary" />
              No tracking
            </span>
            <span className="flex items-center gap-1.5">
              <Globe className="size-4 text-primary" />
              Open-source core
            </span>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-2xl font-semibold text-center mb-4">
            Frequently asked questions
          </h2>
          <p className="text-center text-muted-foreground mb-12">
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
                className="group rounded-xl border border-border bg-card"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 p-4 text-sm font-medium select-none [&::-webkit-details-marker]:hover:text-foreground transition-colors">
                  {faq.question}
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-4 text-sm text-muted-foreground leading-relaxed">
                  {faq.answer}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Band */}
      <section className="py-24 px-4">
        <div className="mx-auto max-w-3xl rounded-3xl bg-gradient-to-br from-primary/10 via-primary/5 to-teal-400/10 border border-primary/20 px-8 py-16 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Never lose a web page again
          </h2>
          <p className="mt-4 text-muted-foreground text-lg">
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
