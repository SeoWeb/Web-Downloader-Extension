import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Archive, Eye, FolderTree, Search, Share2 } from "lucide-react";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  title: "Features — PagePocket",
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
    <section className="px-4 py-16">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-4 text-center text-3xl font-bold">Features</h1>
        <p className="text-muted-foreground mb-12 text-center">
          Five capabilities that make PagePocket your web archive.
        </p>

        {/* Table of Contents */}
        <nav className="border-border bg-muted/50 mb-12 rounded-lg border p-4">
          <ul className="space-y-2">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="flex items-center gap-2 text-sm hover:underline"
                >
                  <section.icon className="text-primary size-4" />
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
              <div className="mb-4 flex items-center gap-3">
                <div className="bg-primary text-primary-foreground flex h-10 w-10 items-center justify-center rounded-lg">
                  <section.icon className="size-5" />
                </div>
                <h2 className="text-2xl font-semibold">{section.title}</h2>
              </div>
              <p className="text-muted-foreground leading-relaxed">
                {section.description}
              </p>
              <div className="border-border bg-muted/40 text-muted-foreground mt-6 flex h-48 items-center justify-center rounded-lg border border-dashed text-sm">
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
