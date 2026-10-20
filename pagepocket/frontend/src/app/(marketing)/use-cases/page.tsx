import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { MarketingCtaBand, PersonaCard } from "./persona-page";
import { PERSONAS } from "./personas";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  title: "Use cases",
  description:
    "How researchers, journalists, developers, and archivists use PagePocket: full-fidelity page saves, private by default, full-text search, and shareable links.",
  alternates: {
    canonical: "https://pagepocket.app/use-cases",
  },
  openGraph: {
    title: "Use cases · PagePocket",
    description:
      "How researchers, journalists, developers, and archivists use PagePocket: full-fidelity page saves, private by default, full-text search, and shareable links.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Use cases · PagePocket",
    description:
      "How researchers, journalists, developers, and archivists use PagePocket: full-fidelity page saves, private by default, full-text search, and shareable links.",
  },
};

export default function UseCasesPage() {
  return (
    <>
      <PageHero
        align="center"
        eyebrow="Use cases"
        title="Your private web archive, for the work you do"
        lede="Researchers, journalists, developers, and archivists all depend on pages staying exactly as they were. PagePocket saves full-fidelity copies into a private, searchable library — here is how it fits four professional workflows."
        actions={
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/register" />}
            className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
          >
            Create free account
          </Button>
        }
      />

      <Section spacing="sm">
        <div className="grid gap-5 sm:grid-cols-2">
          {PERSONAS.map((persona) => (
            <PersonaCard key={persona.slug} persona={persona} heading="h2" />
          ))}
        </div>
      </Section>

      <MarketingCtaBand
        title="Put your web archive to work"
        label="Create free account"
      />
    </>
  );
}
