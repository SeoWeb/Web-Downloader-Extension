import type { Metadata } from "next";
import Link from "next/link";
import { Check } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { Container } from "@/components/marketing/container";
import { FaqList, type FaqItem } from "@/components/marketing/faq-list";
import { Button } from "@/components/ui/button";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  // absolute: the root layout template ("%s · PagePocket") would otherwise
  // double the brand ("Pricing — PagePocket · PagePocket").
  title: { absolute: "Pricing — PagePocket" },
  description:
    "Start free: 50 saves a month and 500 MB of storage. Pro is $2/month, billed yearly, with effectively unlimited saves and 10 GB.",
  alternates: {
    canonical: "/pricing",
  },
  openGraph: {
    title: "Pricing — PagePocket",
    description:
      "Start free: 50 saves a month and 500 MB of storage. Pro is $2/month, billed yearly, with effectively unlimited saves and 10 GB.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — PagePocket",
    description:
      "Start free: 50 saves a month and 500 MB of storage. Pro is $2/month, billed yearly, with effectively unlimited saves and 10 GB.",
  },
};

// Quotas are the real server-enforced limits, not marketing numbers:
// services/archive-service/models.py:57-60 (PLAN_LIMITS) —
//   free: 50 pages/month, 500 MB; pro: 99,999 pages/month, 10 GB.
// The window rolls every 30 days (services/archive-service/quota.py).
const plans = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    tagline: "50 saves / month · 500 MB storage",
    features: [
      "50 page saves per month",
      "500 MB of cloud storage",
      "Full-text search with snippets",
      "Nested, colour-coded collections",
      "Share links with expiry & view counts",
      "Browser extension (Chrome, Edge, Brave)",
    ],
    cta: "Create free account",
    href: "/register",
    highlight: false,
  },
  {
    name: "Pro",
    price: "$2",
    period: "/mo",
    note: "billed yearly — $24/year",
    tagline: "Effectively unlimited saves · 10 GB storage",
    features: [
      "Everything in Free",
      "99,999 saves/month — effectively unlimited",
      "10 GB of cloud storage",
      "No feature paywalls — Pro raises limits, not features",
    ],
    cta: "Get Pro",
    href: "/register",
    highlight: true,
  },
];

// Answered against the actual enforcement code — see the quota table below.
const faqs: FaqItem[] = [
  {
    question: "What counts as a page?",
    answer:
      "Every page you successfully save counts once toward your monthly limit — 50 on Free. Storage is counted separately, by the size of the archived files. Deleting a page frees its storage right away, but it doesn't restore the save for the current period.",
  },
  {
    question: "What happens when I hit my limit?",
    answer:
      "New saves are declined with a clear “monthly limit reached” message until your quota resets on its rolling 30-day window. Nothing is deleted: every page you've already saved stays viewable, searchable, and shareable.",
  },
  {
    question: "How do I upgrade to Pro?",
    answer:
      "Pro costs $2/month, billed yearly at $24. Self-service billing isn't live yet: create your free account, then contact us on GitHub and we'll switch your account to Pro.",
  },
  {
    question: "Can I go back to Free?",
    answer:
      "Yes — ask us to downgrade and your account returns to the Free plan. Your pages stay right where they are. If you're above Free's limits (50 saves/month, 500 MB), new saves pause until you're back under them, but existing pages remain fully viewable.",
  },
];

function PlanCard({ plan }: { plan: (typeof plans)[number] }) {
  return (
    <div
      className={`bg-card relative flex flex-col rounded-xl border p-6 ${
        plan.highlight
          ? "border-primary/40 shadow-primary/5 shadow-lg"
          : "border-border"
      }`}
    >
      {plan.highlight ? (
        <span className="bg-primary text-primary-foreground absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-xs font-medium whitespace-nowrap">
          Best value
        </span>
      ) : null}
      <h2 className="text-foreground text-lg font-semibold">{plan.name}</h2>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-foreground text-4xl font-bold tracking-tight">
          {plan.price}
        </span>
        <span className="text-muted-foreground text-sm">{plan.period}</span>
      </div>
      {plan.note ? (
        <p className="text-muted-foreground mt-1 text-xs">{plan.note}</p>
      ) : null}
      <p className="text-foreground mt-4 text-sm font-medium">{plan.tagline}</p>
      <ul className="mt-5 flex-1 space-y-3">
        {plan.features.map((feature) => (
          <li
            key={feature}
            className="text-muted-foreground flex items-start gap-2 text-sm"
          >
            <Check
              aria-hidden="true"
              className="text-primary mt-0.5 size-4 shrink-0"
            />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Button
        className="mt-6 w-full"
        size="lg"
        variant={plan.highlight ? "default" : "outline"}
        nativeButton={false}
        render={<Link href={plan.href} />}
      >
        {plan.cta}
      </Button>
    </div>
  );
}

function QuotaTable() {
  const rows: Array<[string, string, string]> = [
    ["Price", "Free forever", "$2/mo, billed yearly ($24/yr)"],
    ["Monthly page saves", "50", "99,999 — effectively unlimited"],
    ["Cloud storage", "500 MB", "10 GB"],
    ["Quota reset", "Rolling 30-day window", "Rolling 30-day window"],
    ["Full-text search", "Included", "Included"],
    ["Collections & organization", "Included", "Included"],
    ["Shareable links", "Included", "Included"],
  ];
  return (
    <div className="border-border bg-card overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          PagePocket plan quotas: Free versus Pro
        </caption>
        <thead>
          <tr className="border-border bg-muted/30 border-b">
            <th
              scope="col"
              className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wider uppercase"
            >
              Quota
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">
              Free
            </th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">
              Pro
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([quota, free, pro]) => (
            <tr key={quota} className="border-border border-b last:border-b-0">
              <th
                scope="row"
                className="text-foreground px-4 py-3 text-left align-top font-medium"
              >
                {quota}
              </th>
              <td className="text-muted-foreground px-4 py-3 align-top leading-relaxed">
                {free}
              </td>
              <td className="text-muted-foreground px-4 py-3 align-top leading-relaxed">
                {pro}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PricingPage() {
  return (
    <>
      <PageHero
        eyebrow="Pricing"
        title="Simple pricing, honest limits"
        lede="Start free with 50 saves a month and 500 MB of storage. Upgrade to Pro — $2 a month, billed yearly — when your archive outgrows it."
        actions={
          <Button
            size="lg"
            nativeButton={false}
            render={<Link href="/register" />}
            className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
          >
            Create a free account
          </Button>
        }
      />

      {/* Plan cards */}
      <Container size="default" className="pb-4 sm:pb-8">
        <div className="mx-auto grid max-w-3xl gap-6 pt-3 sm:grid-cols-2 sm:gap-8">
          {plans.map((plan) => (
            <PlanCard key={plan.name} plan={plan} />
          ))}
        </div>
        <p className="text-muted-foreground mx-auto mt-8 max-w-2xl text-center text-sm">
          Every plan includes the full feature set — search, collections,
          sharing, and the browser extension. Plans differ only in how much you
          can save.
        </p>
        <p className="text-muted-foreground mx-auto mt-3 max-w-2xl text-center text-xs">
          No self-service billing yet: after registering, contact us on{" "}
          <a
            href="https://github.com/SeoWeb/Web-Downloader-Extension"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            GitHub
          </a>{" "}
          and we&apos;ll enable Pro on your account.
        </p>
      </Container>

      {/* Quota table */}
      <Section
        eyebrow="Details"
        title="The quotas, in plain numbers"
        subtitle="Both plans are enforced by the same server limits — nothing here is estimated."
      >
        <QuotaTable />
        <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
          Deleting a page frees its storage immediately. The monthly save count
          applies to new saves only — saved pages are never removed for hitting
          a limit.
        </p>
      </Section>

      {/* Price context */}
      <Section eyebrow="Context" title="How $2 compares" align="start">
        <div className="border-border bg-card max-w-2xl rounded-xl border p-6 text-sm leading-relaxed">
          <p className="text-muted-foreground">
            Institutional permalink services charge considerably more:{" "}
            <a
              href="https://www.perma.cc/pricing"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Perma.cc starts at $10/month
            </a>{" "}
            for individuals. PagePocket Pro is $2/month — built for personal
            archiving rather than institutions.
          </p>
        </div>
      </Section>

      {/* FAQ */}
      <Section
        eyebrow="FAQ"
        title="Pricing questions"
        subtitle="Short answers, no asterisks."
      >
        <FaqList items={faqs} className="mx-auto max-w-3xl" />
      </Section>

      {/* CTA band */}
      <Section spacing="lg">
        <div className="border-primary/20 from-primary/10 via-primary/5 rounded-3xl border bg-gradient-to-br to-teal-400/10 px-8 py-16 text-center">
          <h2 className="text-foreground text-3xl font-bold tracking-tight">
            Start free — upgrade when it pays for itself
          </h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-lg">
            Your first 50 pages cost nothing and stay yours. Pro is there when
            your archive grows.
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
              render={<Link href="/features" />}
            >
              See the features
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
