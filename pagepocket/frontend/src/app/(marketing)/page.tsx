import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Archive, Search, FolderTree, Share2, Eye } from "lucide-react";

export const metadata: Metadata = {
  title: "PagePocket — Save, organise, search, and share web pages",
  description:
    "The web archive that works for you. Save any page instantly, organise into collections, search full text, and share with links.",
  openGraph: {
    title: "PagePocket",
    description: "Save, organise, search, and share web pages",
    type: "website",
    images: [{ url: "https://pagepocket.app/og-landing.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PagePocket",
    description: "Save, organise, search, and share web pages",
  },
};

const primaryFeatures = [
  {
    icon: Archive,
    title: "Cloud Save",
    description:
      "Save any web page with one click. Full HTML, styles, and images stored securely in the cloud.",
  },
  {
    icon: Eye,
    title: "Clean Viewer",
    description:
      "View saved pages in a clean, distraction-free reader — even when the original is gone.",
  },
  {
    icon: Search,
    title: "Full-Text Search",
    description:
      "Search across every saved page with highlighted snippets. Your personal search engine.",
  },
];

const secondaryFeatures = [
  {
    icon: FolderTree,
    title: "Collections",
    description:
      "Organise pages into nested collections with drag-and-drop. Find what you need, fast.",
  },
  {
    icon: Share2,
    title: "Shareable Links",
    description:
      "Share any saved page with a link. Set expiry, control access, and track views.",
  },
];

export default function LandingPage() {
  return (
    <>
      {/* Hero */}
      <section className="py-20 px-4 text-center">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            Save any web page.
            <br />
            <span className="text-muted-foreground">
              Find it later. Share it anywhere.
            </span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-xl mx-auto">
            PagePocket is the web archive that works for you. Save pages
            instantly, organise into collections, search full text, and share
            with links.
          </p>
          <div className="mt-8 flex items-center justify-center gap-4">
            <Button size="lg" nativeButton={false} render={<Link href="/register" />}>
              Sign up free
            </Button>
            <Button size="lg" variant="outline" nativeButton={false} render={<Link href="/features" />}>
              Install extension
            </Button>
          </div>
        </div>
      </section>

      {/* Feature Grid */}
      <section className="py-16 px-4 bg-muted/50">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold text-center mb-10">
            Everything you need to never lose a web page again
          </h2>
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
            {primaryFeatures.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <feature.icon className="size-8 text-primary mb-4" />
                <h3 className="font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Secondary Features */}
      <section className="py-16 px-4">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold text-center mb-10">
            And more ways to organise &amp; share
          </h2>
          <div className="grid gap-8 sm:grid-cols-2">
            {secondaryFeatures.map((feature) => (
              <div
                key={feature.title}
                className="rounded-lg border border-border bg-card p-6"
              >
                <feature.icon className="size-8 text-primary mb-4" />
                <h3 className="font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Band */}
      <section className="py-16 px-4 text-center">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-2xl font-semibold">
            Start building your web archive today
          </h2>
          <p className="mt-4 text-muted-foreground">
            Free to start. No credit card required.
          </p>
          <div className="mt-6">
            <Button size="lg">
              <Link href="/register">Create free account</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
