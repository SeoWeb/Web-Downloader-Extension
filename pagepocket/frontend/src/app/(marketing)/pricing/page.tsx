import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";

export const metadata: Metadata = {
  title: "Pricing — PagePocket",
  description: "Choose the plan that fits your research needs.",
  openGraph: {
    title: "Pricing — PagePocket",
    description: "Choose the plan that fits your research needs.",
    images: [{ url: "https://pagepocket.app/og-pricing.png", width: 1200, height: 630 }],
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
    features: [
      "Full-text search",
      "5 collections",
      "Share links with expiry",
    ],
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
    <section className="py-16 px-4">
      <div className="mx-auto max-w-5xl">
        <h1 className="text-3xl font-bold text-center mb-4">Pricing</h1>
        <p className="text-center text-muted-foreground mb-12">
          Choose the plan that fits your research needs.
        </p>
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className="rounded-lg border border-border bg-card p-6 flex flex-col"
            >
              <h2 className="text-xl font-semibold">{plan.name}</h2>
              <div className="mt-4">
                <span className="text-3xl font-bold">{plan.price}</span>
                {plan.period && (
                  <span className="text-muted-foreground ml-1">{plan.period}</span>
                )}
              </div>
              {plan.note && (
                <p className="text-xs text-muted-foreground">{plan.note}</p>
              )}
              <p className="mt-2 text-sm text-muted-foreground">{plan.quota}</p>
              <ul className="mt-6 space-y-3 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm">
                    <Check className="size-4 text-primary shrink-0 mt-0.5" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full mt-6"
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
                <p className="text-xs text-muted-foreground text-center mt-2">
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
