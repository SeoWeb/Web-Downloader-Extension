import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

// og:image / twitter:image come from the sibling opengraph-image.tsx /
// twitter-image.tsx routes. metadataBase keeps canonical + image URLs absolute.
export const metadata: Metadata = {
  metadataBase: new URL("https://pagepocket.app"),
  title: "Pricing — PagePocket",
  description: "Choose the plan that fits your research needs.",
  alternates: {
    canonical: "/pricing",
  },
  openGraph: {
    title: "Pricing — PagePocket",
    description: "Choose the plan that fits your research needs.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — PagePocket",
    description: "Choose the plan that fits your research needs.",
  },
};

const plans = [
  {
    name: "Free",
    price: "Free",
    period: "",
    quota: "50 pages/month · 500 MB storage",
    features: ["Full-text search", "5 collections", "Share links with expiry"],
    cta: "Get started",
    ctaHref: "/register",
    disabled: false,
  },
  {
    name: "Pro",
    price: "$2",
    period: "/mo",
    note: "billed yearly · $24/yr",
    quota: "99,999 pages · 10 GB storage",
    features: [
      "Unlimited collections",
      "Priority support",
      "Advanced search filters",
      "Custom share expiry",
    ],
    cta: "Coming soon",
    ctaHref: "#",
    disabled: true,
  },
  {
    name: "Team",
    price: "$10",
    period: "/mo",
    quota: "99,999 pages · 50 GB storage",
    features: [
      "Everything in Pro",
      "Shared collections",
      "Team search",
      "Admin dashboard",
      "API access",
    ],
    cta: "Coming soon",
    ctaHref: "#",
    disabled: true,
  },
];

export default function PricingPage() {
  return (
    <section className="px-4 py-16">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-4 text-center text-3xl font-bold">Pricing</h1>
        <p className="text-muted-foreground mb-12 text-center">
          Choose the plan that fits your research needs.
        </p>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className="border-border bg-card flex flex-col rounded-lg border p-6"
            >
              <h2 className="text-xl font-semibold">{plan.name}</h2>
              <div className="mt-4">
                <span className="text-3xl font-bold">{plan.price}</span>
                {plan.period && (
                  <span className="text-muted-foreground ml-1">
                    {plan.period}
                  </span>
                )}
              </div>
              {plan.note && (
                <p className="text-muted-foreground text-xs">{plan.note}</p>
              )}
              <p className="text-muted-foreground mt-2 text-sm">{plan.quota}</p>
              <ul className="mt-6 flex-1 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="text-primary mt-0.5 size-4 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="mt-6 w-full"
                variant={plan.name === "Free" ? "default" : "outline"}
                disabled={plan.disabled}
              >
                {!plan.disabled ? (
                  <Link href={plan.ctaHref}>{plan.cta}</Link>
                ) : (
                  plan.cta
                )}
              </Button>
              {plan.disabled && (
                <p className="text-muted-foreground mt-2 text-center text-xs">
                  Billing launches Q3
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
