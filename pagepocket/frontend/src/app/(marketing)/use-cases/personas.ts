import type { Metadata } from "next";
import type { LucideIcon } from "lucide-react";
import { Code2, GraduationCap, Landmark, Newspaper } from "lucide-react";
import type { FaqItem } from "@/components/marketing/faq-list";
import type { JsonLdObject } from "@/components/marketing/json-ld";
import { MARKETING_SITE_URL, marketingUrl } from "@/lib/marketing-routes";

/**
 * Shared content for the four persona landing pages (design D6: use-case
 * pages "/use-cases/{researchers,journalists,developers,archivists}" —
 * persona pain → workflow with screenshots → FAQ → CTA; cross-linked).
 *
 * Single source of truth so the four pages (and the /use-cases index) stay
 * consistent: metadata, hero copy, workflow use cases with real screenshots
 * (public/screenshots/, see its README), and FAQ items all live here.
 *
 * Honesty policy (content-engine spec): every claim below is limited to what
 * the product actually does — full-fidelity saves, private by default,
 * full-text search, collections, share links with expiry/revoke, free plan
 * (50 pages/month · 500 MB), Pro $2/mo billed yearly. No statistics, no
 * testimonials.
 */

export type PersonaSlug =
  | "researchers"
  | "journalists"
  | "developers"
  | "archivists";

/** A real product capture from `public/screenshots/` (see its README). */
export type PersonaScreenshot = {
  /** Public path served via next/image. */
  src: string;
  alt: string;
  /** Display width/height — aspect-true against the capture's real pixels. */
  width: number;
  height: number;
  /** Responsive sizes hint for next/image. */
  sizes: string;
  /** Factual caption describing exactly what the capture shows. */
  caption: string;
};

export type PersonaUseCase = {
  title: string;
  description: string;
  screenshot: PersonaScreenshot;
};

export type Persona = {
  slug: PersonaSlug;
  /** Display name, plural ("Researchers"). */
  name: string;
  /** Keyword phrases this page targets (primary, secondary). */
  keywords: readonly string[];
  /** Metadata (title feeds the root "%s · PagePocket" template). */
  metaTitle: string;
  metaDescription: string;
  /** Hero copy. */
  heroEyebrow: string;
  heroTitle: string;
  heroLede: string;
  /** Signup CTA (button label, then closing band headline). */
  ctaLabel: string;
  ctaTitle: string;
  /** One-liner for index cards and cross-links. */
  tagline: string;
  /** lucide icon representing the persona. */
  icon: LucideIcon;
  useCases: readonly PersonaUseCase[];
  faqs: readonly FaqItem[];
};

/** App captures are 2880×1800 @2x — displayed at 1024×640 (8:5). */
const APP_SHOT_SIZES = "(min-width: 768px) 480px, 100vw";

const COST_FAQ: FaqItem = {
  question: "What does PagePocket cost?",
  answer:
    "The Free plan covers 50 page saves a month with 500 MB of storage, including full-text search, collections, and share links — enough to run the workflows on this page. Pro is $2/month (billed yearly, $24/yr) when you need a bigger library: more pages, 10 GB, and unlimited collections.",
};

export const PERSONAS: readonly Persona[] = [
  {
    slug: "researchers",
    name: "Researchers",
    keywords: [
      "save web pages for research",
      "cite web pages that don't change",
    ],
    metaTitle: "Save web pages for research — cite pages that don't change",
    metaDescription:
      "Save web pages for research in a private, searchable archive — full-fidelity copies of the papers and references you cite that never change or vanish.",
    heroEyebrow: "For researchers",
    heroTitle: "Save web pages for research",
    heroLede:
      "Build a private, searchable archive of the papers, reports, and references behind your work — and cite web pages that don't change under you after publication.",
    ctaLabel: "Start your research archive",
    ctaTitle: "Never lose a source you cited",
    tagline: "Save web pages for research and cite pages that don't change.",
    icon: GraduationCap,
    useCases: [
      {
        title: "Archive the papers you cite before they move",
        description:
          "Journal pages get paywalled, restructured, or quietly corrected — often shortly after you read them. One click from your browser saves the exact version you are looking at, so the figure, paragraph, or dataset you cited stays exactly where you left it.",
        screenshot: {
          src: "/screenshots/viewer-light.png",
          alt: "PagePocket viewer showing an archived Wikipedia article rendered with its original layout",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket viewer rendering an archived page with its original layout and styling — the demo library's saved copy of Wikipedia's “Web archiving” article.",
        },
      },
      {
        title: "Build a searchable reading list",
        description:
          "Every saved page is full-text indexed, so “that passage about preservation” is one query away instead of buried in a bookmarks folder. Skim highlighted snippets, filter by collection, and open the saved page without re-googling it.",
        screenshot: {
          src: "/screenshots/library-light.png",
          alt: "PagePocket library showing the Research sources collection with three saved pages",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket library: the demo account's “Research sources” collection with three saved pages in the sidebar and list.",
        },
      },
      {
        title: "Keep the evidence in your literature review intact",
        description:
          "When a reviewer asks which version of a source you read, your archive answers. Search your library for a quoted phrase years later and reopen the saved copy — it shows precisely what the page said on the day you captured it.",
        screenshot: {
          src: "/screenshots/search-light.png",
          alt: "PagePocket full-text search results for a query with highlighted snippets",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "Full-text search in PagePocket: the query “preservation” returns the two demo pages that mention it, with highlighted snippets.",
        },
      },
    ],
    faqs: [
      {
        question: "Can I cite a PagePocket link in a paper or report?",
        answer:
          "Your library itself is private, but any saved page can be shared with a public link — and share links can be set to never expire. If readers need to see a source you cite, share the snapshot and cite that link: it shows exactly what you saved, not whatever the live page says later. For formally certified citation archives, a dedicated service like Perma.cc may still be the better fit.",
      },
      {
        question: "Does the saved copy keep figures, tables, and layout?",
        answer:
          "PagePocket saves the whole page as you can see it in your browser — HTML, CSS, and images — and the viewer renders it with the original layout and styling intact. One honest limit: for paywalled papers, you can only save what you are able to open.",
      },
      {
        question: "Is my research library private?",
        answer:
          "Yes. Saved pages belong to your account and nothing is published to a public archive. The only way anyone else sees a saved page is a share link you create — which you can revoke at any time.",
      },
      COST_FAQ,
    ],
  },
  {
    slug: "journalists",
    name: "Journalists",
    keywords: [
      "archive web pages as evidence",
      "capture sources before they disappear",
    ],
    metaTitle: "Archive web pages as evidence — before sources disappear",
    metaDescription:
      "Archive web pages as evidence — snapshot sources before they're edited or deleted, keep receipts for fact-check, and share the exact copy with editors.",
    heroEyebrow: "For journalists",
    heroTitle: "Archive web pages as evidence",
    heroLede:
      "You report on what a page said when you saw it. PagePocket captures sources before they're edited or deleted — a dated, searchable record that stays private until you share it.",
    ctaLabel: "Start archiving your sources",
    ctaTitle: "Never lose a source again",
    tagline: "Archive web pages as evidence before sources disappear.",
    icon: Newspaper,
    useCases: [
      {
        title: "Snapshot sources before they're edited or deleted",
        description:
          "Press pages get rewritten, posts get taken down, and whole sites vanish mid-story. While you are reading, one click in the extension saves the full page — text, images, and layout — to your private library before anything can change.",
        screenshot: {
          src: "/screenshots/extension-sidepanel-ready.png",
          alt: "PagePocket extension side panel ready to save the current page",
          width: 336,
          height: 624,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket extension side panel in its ready state, staged against the live page it is about to save with one click.",
        },
      },
      {
        title: "Preserve the receipts for fact-check",
        description:
          "Every snapshot keeps the content as it was when you saved it, with the save time recorded in your library. During fact-check, search your archive for a phrase and pull up the exact page — so the quote in your draft matches what the source actually published.",
        screenshot: {
          src: "/screenshots/search-preview-light.png",
          alt: "PagePocket search bar with a live preview of matching saved pages",
          width: 980,
          height: 260,
          sizes: APP_SHOT_SIZES,
          caption:
            "Searching the archive from the top bar: typing “preservation” surfaces matching saved pages with a live preview.",
        },
      },
      {
        title: "Give editors a link to the exact copy",
        description:
          "Share a link and your editor sees the archived page itself — not the live URL, which may have changed by the time they open it. Recipients need no account, links can carry an expiry, and you can revoke access when the story runs.",
        screenshot: {
          src: "/screenshots/share-light.png",
          alt: "A shared PagePocket archive page viewed without an account",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "A shared PagePocket page opened logged-out: the full archived article behind a “Shared via PagePocket” banner.",
        },
      },
    ],
    faqs: [
      {
        question: "Can a PagePocket snapshot serve as evidence?",
        answer:
          "It preserves exactly what a page said when you saved it — full content, with the save time recorded — which makes it a solid working record for reporting and fact-checking. It is not a certified or notarised capture; if you need third-party attestation, pair PagePocket with a dedicated evidence service.",
      },
      {
        question: "Do my saved sources stay private?",
        answer:
          "Yes — your archive is private by default. Nothing is published anywhere unless you create a share link, and links can carry an expiry date and be revoked at any time.",
      },
      {
        question: "What happens when a source page disappears?",
        answer:
          "Your saved copy keeps working. Archived pages are stored as self-contained copies in your cloud library, so you can open and read them whether or not the source site still exists.",
      },
      COST_FAQ,
    ],
  },
  {
    slug: "developers",
    name: "Developers",
    keywords: [
      "save documentation pages offline",
      "pin documentation versions",
    ],
    metaTitle: "Pin documentation versions — save docs & API references",
    metaDescription:
      "Pin documentation versions — save the docs, API references, and pricing pages you depend on to a private, searchable archive that never changes under you.",
    heroEyebrow: "For developers",
    heroTitle: "Pin documentation versions before they change",
    heroLede:
      "Save the documentation pages, API references, and release notes you code against into a private, full-text-searchable library — so when the live docs move, your copy doesn't.",
    ctaLabel: "Pin your first page — it's free",
    ctaTitle: "Never debug from a dead link again",
    tagline: "Pin documentation versions and the pages you debug against.",
    icon: Code2,
    useCases: [
      {
        title: "Pin docs and API references that change under you",
        description:
          "The MDN page, the framework guide, the endpoint reference you implemented against — all get rewritten without notice. Save the version you are working from; months later, the archived copy still shows the exact signatures and behaviour your code depends on.",
        screenshot: {
          src: "/screenshots/library-light.png",
          alt: "PagePocket library with a saved MDN Fetch API documentation page",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket library holding the demo account's saved copy of MDN's Fetch API reference, alongside other saved pages.",
        },
      },
      {
        title: "Archive the pages you debug against",
        description:
          "Stack Overflow answers get deleted, GitHub issues get locked and hidden, and the bug tracker you diffed against moves to another vendor. Capture them while they are open, and full-text search your archive the next time the same error surfaces.",
        screenshot: {
          src: "/screenshots/search-light.png",
          alt: "PagePocket search results with highlighted snippets",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "Full-text search across every saved page, with highlighted snippets — here finding the two demo pages mentioning “preservation”.",
        },
      },
      {
        title: "Snapshot the pricing and dependency pages you rely on",
        description:
          "Vendor pricing pages, terms of service, and dependency release notes all change silently. A saved copy is your record of what a plan cost — or what a licence said — on the day you made the decision that depended on it.",
        screenshot: {
          src: "/screenshots/viewer-light.png",
          alt: "PagePocket viewer rendering an archived page with its original styling",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket viewer rendering an archived page exactly as saved — the demo copy of Wikipedia's “Web archiving” article.",
        },
      },
    ],
    faqs: [
      {
        question: "Can I read saved documentation offline?",
        answer:
          "Not today. PagePocket is a cloud library, so reading a saved page needs a connection. What it protects you from is the other offline problem: the doc you saved doesn't change or disappear out from under you, and it's full-text searchable wherever you sign in.",
      },
      {
        question: "Does the archive keep code blocks and formatting?",
        answer:
          "Yes. PagePocket saves the full page — HTML, CSS, and images — and the sandboxed viewer renders it with the original layout and styling, with the page's tracking scripts stripped out.",
      },
      {
        question: "How is this different from bookmarking a doc page?",
        answer:
          "A bookmark stores a URL — when the docs move or get rewritten, the bookmark silently follows the new version or breaks. PagePocket stores the page itself, at the version you saved, searchable across everything you have captured.",
      },
      COST_FAQ,
    ],
  },
  {
    slug: "archivists",
    name: "Archivists",
    keywords: ["full fidelity web archive", "personal web archiving tool"],
    metaTitle: "Personal web archiving — a full-fidelity web archive",
    metaDescription:
      "A personal web archiving tool — capture pages with full fidelity, organise them into collections, and share snapshots only when you choose.",
    heroEyebrow: "For archivists & librarians",
    heroTitle: "A full-fidelity web archive you control",
    heroLede:
      "PagePocket is a personal web archiving tool: capture pages with their styles, fonts, and layout intact, organise them into collections, and share the exact snapshot — only when you choose to.",
    ctaLabel: "Start your web archive",
    ctaTitle: "Start the archive you control",
    tagline: "A full-fidelity, personal web archive you control.",
    icon: Landmark,
    useCases: [
      {
        title: "Capture pages with full fidelity",
        description:
          "A save is a self-contained copy of the page — its HTML, CSS, and images — rendered with the original design in the sandboxed viewer, not a stripped-back screenshot. What you captured is what you will see, even if the site redesigns or disappears.",
        screenshot: {
          src: "/screenshots/viewer-light.png",
          alt: "PagePocket viewer showing an archived page rendered at full fidelity",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket viewer rendering the demo account's archived copy of Wikipedia's “Web archiving” article, with styles and images inlined.",
        },
      },
      {
        title: "Organise by collection, project, or event",
        description:
          "Structure the archive the way you curate: nested collections you can rename and colour-code, with drag-and-drop filing. Coverage captured around one event becomes a single collection you can browse — and search within.",
        screenshot: {
          src: "/screenshots/collections-light.png",
          alt: "PagePocket collection view showing the Research sources collection",
          width: 1024,
          height: 640,
          sizes: APP_SHOT_SIZES,
          caption:
            "The demo account's “Research sources” collection view in PagePocket, holding three archived pages.",
        },
      },
      {
        title: "Share snapshots on your terms",
        description:
          "Your archive is private by default. When you do want to make an item available, a share link serves the archived copy itself — with an optional expiry — and can be revoked at any time. Recipients need no account.",
        screenshot: {
          src: "/screenshots/share-dialog-light.png",
          alt: "PagePocket share dialog with expiry options",
          width: 768,
          height: 288,
          sizes: APP_SHOT_SIZES,
          caption:
            "The PagePocket share dialog: pick a link expiry, then create a share link for a saved page.",
        },
      },
    ],
    faqs: [
      {
        question: "What does “full fidelity” mean in practice?",
        answer:
          "Each save is a self-contained copy of the page — its HTML, CSS, and images — and the viewer renders it with the original layout and styling. Pages that lean heavily on client-side scripting may not behave identically to the live site; what PagePocket preserves is the page as a document.",
      },
      {
        question: "Am I contributing to a public archive?",
        answer:
          "No. PagePocket is a personal archive: nothing you save is published or visible to other users. That is the difference from community archives like the Wayback Machine — you decide exactly what is kept, and only you can read it until you explicitly share a link.",
      },
      {
        question: "Can colleagues search the same archive?",
        answer:
          "Not yet — the library is per-account for now, and shared team collections are not part of the launch plans. Individual snapshots can be shared with a link whenever needed.",
      },
      COST_FAQ,
    ],
  },
];

const PERSONAS_BY_SLUG: ReadonlyMap<PersonaSlug, Persona> = new Map(
  PERSONAS.map((persona) => [persona.slug, persona]),
);

export function getPersona(slug: PersonaSlug): Persona {
  const persona = PERSONAS_BY_SLUG.get(slug);
  if (!persona) {
    throw new Error(`Unknown persona: ${slug}`);
  }
  return persona;
}

/** The other three personas, in canonical order — for cross-link sections. */
export function otherPersonas(persona: Persona): readonly Persona[] {
  return PERSONAS.filter((other) => other.slug !== persona.slug);
}

/** Metadata for a persona page (title flows through the root template). */
export function personaMetadata(persona: Persona): Metadata {
  const canonical = marketingUrl(`/use-cases/${persona.slug}`);
  return {
    metadataBase: new URL(MARKETING_SITE_URL),
    title: persona.metaTitle,
    description: persona.metaDescription,
    alternates: { canonical },
    openGraph: {
      title: persona.metaTitle,
      description: persona.metaDescription,
      url: canonical,
    },
    // No OG image route exists for these pages yet — claim the honest small
    // card instead of summary_large_image with a missing image.
    twitter: {
      card: "summary",
      title: persona.metaTitle,
      description: persona.metaDescription,
    },
  };
}

/** BreadcrumbList JSON-LD for nested routes (design D5, task 3.3). */
export function breadcrumbJsonLd(
  crumbs: readonly { name: string; path?: string }[],
): JsonLdObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      // The current page may omit `item` per Google's structured-data
      // general guidelines.
      ...(crumb.path ? { item: marketingUrl(crumb.path) } : {}),
    })),
  };
}

/** Microcopy under the closing CTA — mirrors the real /pricing quotas. */
export const CTA_MICROCOPY =
  "Start free — 50 pages/month, no credit card. Pro is $2/mo when you need more.";
