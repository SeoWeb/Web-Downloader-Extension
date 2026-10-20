import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FaqList } from "@/components/marketing/faq-list";
import { JsonLd } from "@/components/marketing/json-ld";
import { PageHero } from "@/components/marketing/page-hero";
import { Section } from "@/components/marketing/section";
import { cn } from "@/lib/utils";
import {
  CTA_MICROCOPY,
  breadcrumbJsonLd,
  otherPersonas,
  type Persona,
} from "./personas";

/**
 * Shared RSC body for the four persona landing pages (design D6 — one
 * implementation so the pages can never drift apart; the content itself is
 * data-driven from `./personas`). Static server rendering only: no "use
 * client" here, the FAQ uses native <details> and every CTA is a link.
 */

function SignupButton({ label }: { label: string }) {
  return (
    <Button
      size="lg"
      nativeButton={false}
      render={<Link href="/register" />}
      className="bg-accent-warm text-accent-warm-foreground hover:bg-accent-warm/90"
    >
      {label}
    </Button>
  );
}

/** Card linking to a persona page — used on /use-cases and in cross-links. */
export function PersonaCard({
  persona,
  heading = "h3",
}: {
  persona: Persona;
  /** Heading level: h2 on the index page, h3 inside persona pages. */
  heading?: "h2" | "h3";
}) {
  const HeadingTag = heading;
  return (
    <Link
      href={`/use-cases/${persona.slug}`}
      className="group border-border bg-card hover:border-primary/30 flex h-full flex-col rounded-xl border p-6 transition-all hover:shadow-lg"
    >
      <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
        <persona.icon className="size-5" aria-hidden="true" />
      </div>
      <HeadingTag className="mt-4 font-semibold">{persona.name}</HeadingTag>
      <p className="text-muted-foreground mt-2 flex-1 text-sm leading-relaxed">
        {persona.tagline}
      </p>
      <span className="text-primary mt-4 inline-flex items-center gap-1.5 text-sm font-medium">
        See how {persona.name.toLowerCase()} use it
        <ArrowRight
          className="size-4 transition-transform group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
    </Link>
  );
}

/** Closing CTA band — honest microcopy, links to /register. */
export function MarketingCtaBand({
  title,
  label,
}: {
  title: string;
  label: string;
}) {
  return (
    <section className="py-section-sm md:py-section px-4">
      <div className="from-primary/10 via-primary/5 border-primary/20 mx-auto max-w-3xl rounded-3xl border bg-gradient-to-br to-teal-400/10 px-8 py-12 text-center sm:py-16">
        <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-4">{CTA_MICROCOPY}</p>
        <div className="mt-8 flex justify-center">
          <SignupButton label={label} />
        </div>
      </div>
    </section>
  );
}

export function PersonaPage({ persona }: { persona: Persona }) {
  const others = otherPersonas(persona);

  return (
    <>
      {/* Task 3.3 — BreadcrumbList: Home → Use cases → Persona. */}
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Use cases", path: "/use-cases" },
          { name: persona.name },
        ])}
      />

      <PageHero
        align="center"
        eyebrow={
          <Link
            href="/use-cases"
            className="inline-flex items-center gap-1.5 hover:underline"
          >
            <ArrowLeft className="size-3" aria-hidden="true" />
            All use cases
          </Link>
        }
        title={persona.heroTitle}
        lede={persona.heroLede}
        actions={<SignupButton label={persona.ctaLabel} />}
      />

      <Section
        eyebrow={persona.heroEyebrow}
        title={`How ${persona.name.toLowerCase()} use PagePocket`}
        subtitle={persona.tagline}
        align="center"
      >
        <div className="space-y-16 sm:space-y-20">
          {persona.useCases.map((useCase, index) => (
            <article
              key={useCase.title}
              className="grid items-center gap-8 md:grid-cols-2 md:gap-12"
            >
              <div>
                <h3 className="text-h3 text-foreground font-semibold tracking-tight">
                  {useCase.title}
                </h3>
                <p className="text-muted-foreground mt-4 leading-relaxed">
                  {useCase.description}
                </p>
              </div>
              <figure className={cn(index % 2 === 1 && "md:order-first")}>
                <Image
                  src={useCase.screenshot.src}
                  alt={useCase.screenshot.alt}
                  width={useCase.screenshot.width}
                  height={useCase.screenshot.height}
                  sizes={useCase.screenshot.sizes}
                  preload={index === 0}
                  className="border-border bg-card h-auto w-full rounded-xl border shadow-sm"
                />
                <figcaption className="text-muted-foreground mt-3 text-xs leading-relaxed">
                  {useCase.screenshot.caption}
                </figcaption>
              </figure>
            </article>
          ))}
        </div>
      </Section>

      <Section
        eyebrow="FAQ"
        title={`Common questions from ${persona.name.toLowerCase()}`}
        containerSize="narrow"
        className="bg-muted/30"
      >
        <FaqList items={persona.faqs} />
      </Section>

      <Section
        eyebrow="More workflows"
        title="Other ways to use PagePocket"
        subtitle="Same product, four workflows: full-fidelity saves, a private library, full-text search, and shareable links."
      >
        <div className="grid gap-5 sm:grid-cols-3">
          {others.map((other) => (
            <PersonaCard key={other.slug} persona={other} />
          ))}
        </div>
      </Section>

      <MarketingCtaBand title={persona.ctaTitle} label={persona.ctaLabel} />
    </>
  );
}
