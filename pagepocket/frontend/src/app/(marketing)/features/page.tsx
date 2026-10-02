import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Archive, Eye, FolderTree, Search, Share2 } from "lucide-react";

export const metadata: Metadata = {
  title: "Features — PagePocket",
  description:
    "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
  openGraph: {
    title: "Features — PagePocket",
    description:
      "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
    images: [{ url: "https://pagepocket.app/og-features.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Features — PagePocket",
    description:
      "Explore PagePocket features: cloud save, clean viewer, collections, search, and sharing.",
  },
};

const sections = [
  {
    id: "cloud-save",
    icon: Archive,
    title: "Cloud Save",
    description:
      "Save any web page with a single click from your browser. The full HTML, CSS, images, and other assets are archived to cloud storage. Pages are preserved exactly as you saw them — even if the original site goes offline.",
  },
  {
    id: "clean-viewer",
    icon: Eye,
    title: "Clean Page Viewer",
    description:
      "View saved pages in a secure, sandboxed viewer that strips out tracking scripts while preserving the original layout and styles. Perfect for reading research, articles, and documentation without distractions.",
  },
  {
    id: "collections",
    icon: FolderTree,
    title: "Collections & Organization",
    description:
      "Organise saved pages into nested collections. Drag and drop pages between collections, rename and colour-code your folders, and navigate your archive effortlessly. Keyboard shortcuts keep power users fast.",
  },
  {
    id: "full-text-search",
    icon: Search,
    title: "Full-Text Search",
    description:
      "Search across every saved page with instant results and highlighted snippets. Filter by collection, navigate with arrow keys, and find exactly what you need in seconds. Your personal search engine for the web.",
  },
  {
    id: "shareable-links",
    icon: Share2,
    title: "Shareable Links",
    description:
      "Share any saved page with a public or private link. Set custom expiry times, track view counts, and revoke access at any time. Recipients don't need an account to view shared pages.",
  },
];

export default function FeaturesPage() {
  return (
    <section className="py-16 px-4">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-3xl font-bold text-center mb-4">Features</h1>
        <p className="text-center text-muted-foreground mb-12">
          Five capabilities that make PagePocket your web archive.
        </p>

        {/* Table of Contents */}
        <nav className="mb-12 rounded-lg border border-border bg-muted/50 p-4">
          <ul className="space-y-2">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="flex items-center gap-2 text-sm hover:underline"
                >
                  <section.icon className="size-4 text-primary" />
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Feature Sections */}
        <div className="space-y-16">
          {sections.map((section) => (
            <article key={section.id} id={section.id} className="scroll-mt-20">
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <section.icon className="size-5" />
                </div>
                <h2 className="text-2xl font-semibold">{section.title}</h2>
              </div>
              <p className="text-muted-foreground leading-relaxed">
                {section.description}
              </p>
              <div className="mt-6 h-48 rounded-lg border border-dashed border-border bg-muted/40 flex items-center justify-center text-sm text-muted-foreground">
                Screenshot placeholder
              </div>
            </article>
          ))}
        </div>

        <div className="mt-16 text-center">
          <Button size="lg">
            <Link href="/register">Get started free</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
