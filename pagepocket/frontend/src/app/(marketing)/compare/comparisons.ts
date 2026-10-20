import type { FaqItem } from "@/components/marketing/faq-list";
import type {
  ComparisonColumn,
  ComparisonRow,
} from "@/components/marketing/comparison-table";
import { MARKETING_SITE_URL } from "@/lib/marketing-routes";

/**
 * Shared data for the /compare/* pages (tasks 3.2/3.3 of the
 * professional-marketing-site change).
 *
 * Honesty rules (spec: "Fair comparison" + content-honesty policy):
 *  - Every competitor fact here is verifiable from the competitor's own
 *    public materials — each page renders a numbered "Sources" footnote
 *    block, and table notes cite those numbers as [1], [2], [3].
 *  - Cells that favour the competitor are stated plainly: SingleFile wins
 *    offline/one-file portability, the Wayback Machine wins "free +
 *    public record", Perma.cc wins institutional citation trust.
 *  - No aggregateRating, no invented numbers, no disparagement.
 */

export interface CompareSource {
  label: string;
  url: string;
}

export interface CompareScenario {
  title: string;
  body: string;
}

export interface CompareLink {
  href: string;
  label: string;
}

export type CompareSlug = "singlefile" | "wayback" | "perma-cc";

export interface ComparePageData {
  slug: CompareSlug;
  /** Canonical path, e.g. "/compare/singlefile". */
  path: string;
  /** Display name of the competitor, e.g. "SingleFile". */
  competitor: string;
  metaTitle: string;
  metaDescription: string;
  heroTitle: string;
  heroLede: string;
  /** "What <competitor> is great at" framing section. */
  framing: {
    title: string;
    body: string;
    bullets: readonly string[];
  };
  tableCaption: string;
  columns: readonly [ComparisonColumn, ComparisonColumn];
  rows: readonly ComparisonRow[];
  betterChoiceIntro: string;
  betterChoice: readonly CompareScenario[];
  /** "Where PagePocket fits" paragraphs. */
  fits: readonly string[];
  faqs: readonly FaqItem[];
  /** Numbered footnote sources; table notes reference them as [1], [2]… */
  sources: readonly CompareSource[];
  /** The other two comparison pages, for cross-linking. */
  related: readonly CompareLink[];
  /** Relevant persona pages under /use-cases/. */
  useCases: readonly CompareLink[];
}

/** PagePocket column shared by every comparison table. */
export const PAGEPOCKET_COLUMN: ComparisonColumn = {
  id: "pagepocket",
  name: "PagePocket",
};

/** Breadcrumb trail item used by the BreadcrumbList JSON-LD helper. */
interface BreadcrumbItem {
  name: string;
  path: string;
}

/**
 * BreadcrumbList JSON-LD (task 3.3) for a nested route.
 * Positions are 1-based per schema.org; `item` URLs are absolute so the
 * data is valid regardless of the serving origin (design D1/D5).
 */
export function breadcrumbJsonLd(trail: readonly BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path, MARKETING_SITE_URL).toString(),
    })),
  };
}

const SINGLEFILE_SOURCES: readonly CompareSource[] = [
  {
    label: "SingleFile — official site",
    url: "https://www.getsinglefile.com/",
  },
  {
    label: "SingleFile on GitHub (gildas-lormeau/SingleFile)",
    url: "https://github.com/gildas-lormeau/SingleFile",
  },
  {
    label: "SingleFile — Chrome Web Store listing",
    url: "https://chromewebstore.google.com/detail/singlefile/mpiodijhokgodhhofbcjdecpffjipkle",
  },
];

const WAYBACK_SOURCES: readonly CompareSource[] = [
  {
    label: "Save Pages in the Wayback Machine — Internet Archive Help",
    url: "https://help.archive.org/help/save-pages-in-the-wayback-machine/",
  },
  {
    label: "Using the Wayback Machine — Internet Archive Help",
    url: "https://help.archive.org/help/using-the-wayback-machine/",
  },
  {
    label: "Save Page Now — web.archive.org",
    url: "https://web.archive.org/save/",
  },
];

const PERMA_SOURCES: readonly CompareSource[] = [
  {
    label: "Perma.cc Docs — Accounts and Usage Plans",
    url: "https://perma.cc/docs/accounts",
  },
  { label: "Perma.cc — individual sign-up", url: "https://perma.cc/sign-up" },
  { label: "Perma.cc — homepage", url: "https://perma.cc/" },
];

/** PagePocket price cells — kept in one place so all pages agree. */
const PAGEPOCKET_PRICE =
  "Free plan: 50 pages/mo · 500 MB. Pro: $2/mo (billed yearly).";

export const comparePages: Record<CompareSlug, ComparePageData> = {
  singlefile: {
    slug: "singlefile",
    path: "/compare/singlefile",
    competitor: "SingleFile",
    metaTitle:
      "PagePocket vs SingleFile — local HTML files vs a private cloud archive",
    metaDescription:
      "An honest, sourced comparison of SingleFile and PagePocket: one-file offline portability vs a private, searchable, cross-device page library.",
    heroTitle: "PagePocket vs SingleFile",
    heroLede:
      "SingleFile saves a complete page as one HTML file on your computer — free, open source, genuinely excellent. PagePocket turns saves into a private, searchable cloud library. Here is where each one wins, with sources.",
    framing: {
      title: "What SingleFile is great at",
      body: "SingleFile is a browser extension (with a companion CLI) that saves an entire web page — images, stylesheets, fonts, frames — as a single standard HTML file. It is free and open source, works in Chrome, Edge, Firefox, and Safari, and by design it keeps everything on your machine: no account, no cloud service, nothing sent anywhere [1][2]. For one-off, fully offline copies, it is a superb tool.",
      bullets: [
        "One self-contained HTML file — download it, disconnect from the network, open it from disk, and it displays exactly the same [1]",
        "Free and open source, with millions of installs across Chrome, Edge, Firefox, and Safari [1][3]",
        "Nothing leaves your computer — no account, no cloud, nothing sent anywhere [1]",
      ],
    },
    tableCaption:
      "Feature comparison between PagePocket and SingleFile. Cells state plain facts; SingleFile genuinely wins offline use and one-file portability.",
    columns: [PAGEPOCKET_COLUMN, { id: "singlefile", name: "SingleFile" }],
    rows: [
      {
        feature: "Saves the full page — text, layout, images, fonts",
        values: { pagepocket: true, singlefile: true },
        note: "SingleFile embeds images, stylesheets and fonts into one standard HTML file [1]. PagePocket archives the full page — HTML, CSS, images — to your cloud library.",
      },
      {
        feature: "One-file portability — open it anywhere, decades later",
        values: { pagepocket: false, singlefile: true },
        note: "A saved SingleFile file opens in any browser, from disk, with no service or extension needed [1]. PagePocket pages are viewed in its sandboxed web viewer.",
      },
      {
        feature: "Works fully offline",
        values: { pagepocket: false, singlefile: true },
        note: "SingleFile saves and displays without a network, by design [1]. PagePocket is a cloud service — saving and reading need a connection.",
      },
      {
        feature: "Keeps your archive private",
        values: { pagepocket: true, singlefile: true },
        note: "SingleFile stays on your computer — nothing is sent anywhere [1]. PagePocket pages are private to your account unless you share a link.",
      },
      {
        feature: "Private cloud library across devices",
        values: { pagepocket: true, singlefile: false },
        note: "SingleFile files live in a folder on your machine — syncing is up to you. PagePocket keeps every save in one private library, available on any device.",
      },
      {
        feature: "Full-text search across everything you save",
        values: { pagepocket: true, singlefile: false },
        note: "With SingleFile, finding text inside saved files is left to your operating system's file search.",
      },
      {
        feature: "Share with a clean link",
        values: { pagepocket: true, singlefile: false },
        note: "PagePocket share links work with optional expiry and revocation. With SingleFile you send the file itself.",
      },
      {
        feature: "Price",
        values: {
          pagepocket: PAGEPOCKET_PRICE,
          singlefile: "Free · open source [1]",
        },
      },
    ],
    betterChoiceIntro:
      "SingleFile is the better tool in real, common situations. If any of these describe you, use it with confidence — we mean it.",
    betterChoice: [
      {
        title: "You need copies that outlive every service",
        body: "A saved SingleFile page is one standard HTML file on your disk. It opens offline in any browser, today or in twenty years, with no account and no service behind it [1].",
      },
      {
        title: "You archive sensitive material",
        body: "By design nothing leaves your machine: no account, no cloud service, nothing sent anywhere [1]. If a page must never touch someone else's server, local saving is the right call.",
      },
      {
        title: "You want a zero-cost, zero-signup tool",
        body: "SingleFile is free and open source [1]. For the occasional one-off save, installing it beats creating any account.",
      },
    ],
    fits: [
      "PagePocket is for the step after saving: keeping hundreds or thousands of pages private, findable, and shareable. Instead of managing a growing folder of files, every save lands in one private library that is full-text searchable, organised in collections, and available on every device.",
      "Many people use both: SingleFile for the occasional file that must live on disk forever, PagePocket for the working archive of research, sources, and documentation. If your saves matter at any volume, a searchable library beats a folder — the Free plan (50 pages/mo) is enough to feel the difference.",
    ],
    faqs: [
      {
        question: "Is SingleFile really free?",
        answer:
          "Yes. SingleFile is free and open source and is available for Chrome, Edge, Firefox, and Safari [1]. PagePocket does not compete on that axis: PagePocket is a cloud service with a Free plan (50 pages/month, 500 MB) and a Pro plan at $2/mo billed yearly.",
      },
      {
        question: "So which one should I use?",
        answer:
          "They solve different halves of the problem. SingleFile produces a single HTML file that lives on your computer and works offline forever [1]. PagePocket turns saves into a private cloud library that is searchable and shareable. Choose SingleFile for one-off local copies; choose PagePocket when your archive needs to be findable and shareable.",
      },
      {
        question: "Can PagePocket export single HTML files like SingleFile?",
        answer:
          "No. PagePocket archives pages to your private cloud library and displays them in a sandboxed viewer. If one-file portability is your top priority, SingleFile is the better fit — that is its core strength [1].",
      },
    ],
    sources: SINGLEFILE_SOURCES,
    related: [
      { href: "/compare/wayback", label: "PagePocket vs the Wayback Machine" },
      { href: "/compare/perma-cc", label: "PagePocket vs Perma.cc" },
    ],
    useCases: [
      { href: "/use-cases/researchers", label: "For researchers" },
      { href: "/use-cases/archivists", label: "For archivists" },
    ],
  },

  wayback: {
    slug: "wayback",
    path: "/compare/wayback",
    competitor: "the Wayback Machine",
    metaTitle:
      "PagePocket vs the Wayback Machine — public archive vs your private archive",
    metaDescription:
      "An honest, sourced comparison of the Wayback Machine and PagePocket: a free public archive for everyone vs a private, searchable archive for you.",
    heroTitle: "PagePocket vs the Wayback Machine",
    heroLede:
      "The Wayback Machine is the web's public memory — free, run by a non-profit, and irreplaceable. PagePocket is a private Wayback Machine for the pages you personally care about. What each does best, stated plainly, with sources.",
    framing: {
      title: "What the Wayback Machine is great at",
      body: "The Wayback Machine, run by the Internet Archive (a 501(c)(3) non-profit), preserves the web for everyone. Its Save Page Now captures a page — including images and CSS — and instantly gives it a permanent web.archive.org URL that anyone can cite, share, and link to, free of charge [1]. Saved pages become part of a public collection that researchers, historians, and the curious can access at no cost [2].",
      bullets: [
        "Free for anyone — Save Page Now gives you a permanent public URL in seconds [1]",
        "Contributes to the public record: saved pages can be cited, shared, and linked to [1]",
        "Decades of crawl history for popular URLs — history no personal tool can reconstruct [2]",
      ],
    },
    tableCaption:
      "Feature comparison between PagePocket and the Wayback Machine. The Wayback Machine genuinely wins on being free and contributing to the public record.",
    columns: [PAGEPOCKET_COLUMN, { id: "wayback", name: "Wayback Machine" }],
    rows: [
      {
        feature: "Saves the full page — text, layout, images",
        values: { pagepocket: true, wayback: true },
        note: "Save Page Now saves the page you enter including its images and CSS, and gives it a permanent URL. It captures a single page, not a whole site [1].",
      },
      {
        feature: "Free",
        values: {
          pagepocket: PAGEPOCKET_PRICE,
          wayback: "Free — run by a non-profit [1]",
        },
        note: "The Wayback Machine is an initiative of the Internet Archive, a 501(c)(3) non-profit. Its subscription service for organisations building curated collections is Archive-It [1].",
      },
      {
        feature: "Keeps your archive private",
        values: { pagepocket: true, wayback: false },
        note: "The Wayback Machine is a public archive — anyone can access the collections [2], and site owners can request that pages be excluded or removed [2]. PagePocket pages are private to your account unless you share a link.",
      },
      {
        feature: "Contributes to the public record",
        values: { pagepocket: false, wayback: true },
        note: "Every Wayback save helps preserve the open web for everyone — a genuinely unique strength no private tool offers.",
      },
      {
        feature: "Private, organised library of your saves",
        values: { pagepocket: true, wayback: false },
        note: "Signed-in Save Page Now can list your captures in a personal 'my web archive' [3], but saved pages join the shared public archive — there are no private collections.",
      },
      {
        feature: "Full-text search across everything you save",
        values: { pagepocket: true, wayback: false },
        note: "The Wayback Machine helps you locate archived URLs; there is no private per-user index of your own captures' contents [2].",
      },
      {
        feature: "Share with a clean link",
        values: { pagepocket: true, wayback: true },
        note: "Wayback gives every capture a permanent public URL [1]. PagePocket links are private-by-default, with optional expiry and revocation.",
      },
      {
        feature: "Works offline",
        values: { pagepocket: false, wayback: false },
        note: "Both need a connection — Wayback captures live on web.archive.org, PagePocket is a cloud app. For fully offline copies, a tool like SingleFile is the better fit.",
      },
    ],
    betterChoiceIntro:
      "The Wayback Machine is the better tool in real situations. If any of these describe you, use it with confidence — we mean it.",
    betterChoice: [
      {
        title: "The save should be public",
        body: "A Wayback save is a citable public URL in a non-profit's archive that anyone can visit [1]. For transparency journalism, fact-checking, or anything in the public interest, being public is the point.",
      },
      {
        title: "You are researching a page's history",
        body: "The Wayback Machine holds years of captures of popular URLs made by broad crawls [2] — history no personal archiving tool can reconstruct.",
      },
      {
        title: "You need it free, with no account at all",
        body: "Save Page Now works for anyone, free of charge [1]. For a single capture of a single page, nothing beats it.",
      },
    ],
    fits: [
      "PagePocket is a private Wayback Machine for the pages you care about: full-fidelity copies land in your own library — not a public archive — organised in collections, full-text searchable across everything you have saved, and shareable with a link you can expire or revoke.",
      "The two tools complement each other. Use the Wayback Machine when the save should be part of the public record; use PagePocket when it should stay yours. The Free plan (50 pages/mo, 500 MB) needs only an account to start.",
    ],
    faqs: [
      {
        question: "Is the Wayback Machine free?",
        answer:
          "Yes. It is run by the Internet Archive, a non-profit, and Save Page Now is free for anyone [1]. PagePocket also has a free plan, and its Pro plan is $2/mo billed yearly — the difference is what you get: a private, searchable library vs a public archive.",
      },
      {
        question: "Are pages I save in the Wayback Machine public?",
        answer:
          "Yes. Saved pages join a public collection anyone can access [2], and site owners can request exclusion or removal of pages [2]. PagePocket is the opposite by design: pages stay private until you share a link.",
      },
      {
        question: "Can the Wayback Machine replace a personal archive?",
        answer:
          "Not quite. Save Page Now captures single pages [1], there are no private collections, and there is no private full-text search across your own captures. PagePocket is built exactly for that: a personal, organised, searchable archive.",
      },
    ],
    sources: WAYBACK_SOURCES,
    related: [
      { href: "/compare/singlefile", label: "PagePocket vs SingleFile" },
      { href: "/compare/perma-cc", label: "PagePocket vs Perma.cc" },
    ],
    useCases: [
      { href: "/use-cases/journalists", label: "For journalists" },
      { href: "/use-cases/researchers", label: "For researchers" },
    ],
  },

  "perma-cc": {
    slug: "perma-cc",
    path: "/compare/perma-cc",
    competitor: "Perma.cc",
    metaTitle:
      "PagePocket vs Perma.cc — citation registry vs a private research archive",
    metaDescription:
      "An honest, sourced comparison of Perma.cc and PagePocket: permanent public records for legal citations vs a private, full-text-searchable archive for everyday research.",
    heroTitle: "PagePocket vs Perma.cc",
    heroLede:
      "Perma.cc is the gold standard for permanent legal citations — built and supported by libraries. PagePocket is a private, searchable archive for everyday professional research. Different jobs; here is the honest breakdown, with sources.",
    framing: {
      title: "What Perma.cc is great at",
      body: "Perma.cc helps scholars, journals, courts, and others create permanent records of the web sources they cite — so citations never rot [3]. It is built and supported by libraries, with records preserved by the Harvard Law School Library, and it is free for courts and for academic communities affiliated with a Perma registrar [2]. When a citation must not break, Perma.cc is the recognised choice.",
      bullets: [
        "Purpose-built for legal and scholarly citations — 'Websites change. Perma Links don't.' [3]",
        "Built and supported by libraries; records preserved by the Harvard Law School Library [2]",
        "Free unlimited service for affiliated academics and for courts [1]",
      ],
    },
    tableCaption:
      "Feature comparison between PagePocket and Perma.cc. Perma.cc genuinely wins for legal-institution trust and citation permanence.",
    columns: [PAGEPOCKET_COLUMN, { id: "perma", name: "Perma.cc" }],
    rows: [
      {
        feature: "Saves the full page — text, layout, images",
        values: { pagepocket: true, perma: true },
        note: "Perma.cc creates a permanent record of the cited page, preserved in its registry [3].",
      },
      {
        feature: "Purpose-built for legal and scholarly citations",
        values: { pagepocket: false, perma: true },
        note: "Perma.cc is built and supported by libraries and used by courts and law reviews — the recognised choice when a citation must not break [2][3].",
      },
      {
        feature: "Keeps your archive private",
        values: { pagepocket: true, perma: false },
        note: "Perma Links are permanent public records, meant to be cited and viewed by others [3]. PagePocket pages are private to your account unless you share a link.",
      },
      {
        feature: "Full-text search across everything you save",
        values: { pagepocket: true, perma: false },
        note: "Perma.cc is organised around cited links rather than a searchable personal library.",
      },
      {
        feature: "Where your archive lives",
        values: {
          pagepocket: "Your private library on PagePocket",
          perma:
            "Perma.cc's registry, preserved by the Harvard Law School Library [2]",
        },
        note: "Third-party institutional preservation is Perma's core value: your records outlive you, independent of any account you hold.",
      },
      {
        feature: "Share with a clean link",
        values: { pagepocket: true, perma: true },
        note: "Sharing a permanent public record is the core of Perma.cc [3]. PagePocket links are private-by-default, with optional expiry and revocation.",
      },
      {
        feature: "Works offline",
        values: { pagepocket: false, perma: false },
        note: "Both are online services. For fully offline copies, a tool like SingleFile is the better fit.",
      },
      {
        feature: "Price",
        values: {
          pagepocket: PAGEPOCKET_PRICE,
          perma:
            "10 free trial links, then from $10/mo for 10 links/mo; free unlimited via many libraries and courts [1]",
        },
        note: "Perma.cc individual subscriptions: 10 links/mo $10, 100 links/mo $25, 500 links/mo $100; one-time link packs also available [1].",
      },
    ],
    betterChoiceIntro:
      "Perma.cc is the better tool in real situations. If any of these describe you, use it with confidence — we mean it.",
    betterChoice: [
      {
        title: "You are citing sources in legal or academic work",
        body: "Perma.cc exists so citations in court opinions and law reviews do not rot, with records preserved by the Harvard Law School Library [2][3]. For that job it is the recognised standard — PagePocket will not pretend otherwise.",
      },
      {
        title: "Your institution provides it",
        body: "Many academic libraries and courts are Perma registrars, and affiliated students, faculty, and staff get free unlimited service [1]. If you qualify, use it.",
      },
      {
        title: "You need third-party institutional permanence",
        body: "Perma records are hosted and preserved by an independent institution [2] — a guarantee that matters for citations with legal weight and that a self-serve cloud archive cannot honestly replicate.",
      },
    ],
    fits: [
      "For legal citations, Perma.cc is the right tool. PagePocket is built for the broader research workflow around it: privately archiving sources at working volume, keeping them organised in collections, finding anything again with full-text search, and sharing with expiring links — all at $2/mo on Pro.",
      "They also differ in visibility: Perma records are public by design [3], while PagePocket pages are private until you deliberately share a link. If you archive material that should not be public, that distinction matters. Start on the Free plan (50 pages/mo) to see the workflow.",
    ],
    faqs: [
      {
        question: "How much does Perma.cc cost?",
        answer:
          "New individual accounts get ten free trial links [2]. After that, subscriptions are $10/mo for 10 links, $25/mo for 100 links, or $100/mo for 500 links, with one-time link packs also available [1]. Many academic users and courts get free unlimited service through a Perma registrar [1].",
      },
      {
        question: "Is PagePocket a Perma.cc replacement?",
        answer:
          "Not for legal citation — Perma.cc is the recognised tool for that, and rightly so [3]. PagePocket serves the broader job: privately archiving, searching, and sharing pages at working volume, from $2/mo on Pro.",
      },
      {
        question: "What does PagePocket do that Perma.cc does not?",
        answer:
          "PagePocket is a private library: pages stay yours unless you share them, everything you save is full-text searchable, and saves are organised in collections. Perma.cc records are public by design and priced per link [1][3] — a different model for a different job.",
      },
    ],
    sources: PERMA_SOURCES,
    related: [
      { href: "/compare/singlefile", label: "PagePocket vs SingleFile" },
      { href: "/compare/wayback", label: "PagePocket vs the Wayback Machine" },
    ],
    useCases: [
      { href: "/use-cases/journalists", label: "For journalists" },
      { href: "/use-cases/researchers", label: "For researchers" },
    ],
  },
};

/** Stable, display-friendly order for the /compare index and page lists. */
export const compareOrder: readonly CompareSlug[] = [
  "singlefile",
  "wayback",
  "perma-cc",
];

/** One-line summaries used on the /compare index cards. */
export const compareSummaries: Record<CompareSlug, string> = {
  singlefile:
    "Saves a complete page as one HTML file on your computer. Free, open source, and unbeatable for offline copies — but the library is a folder on your machine.",
  wayback:
    "The web's public memory. Free, run by a non-profit, and everyone can see what you save — history for the world, not a private library for you.",
  "perma-cc":
    "Permanent public records for legal citations, preserved by libraries. The recognised standard for citations — and priced per link.",
};
