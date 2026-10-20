import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container, type ContainerSize } from "./container";

/**
 * PageHero — hero band for core marketing pages and content pages
 * (design D2/D7: "Your private Wayback Machine" positioning, calm and
 * professional — no animation-heavy hero).
 *
 * Server component (no "use client"). Composes: an optional eyebrow badge,
 * the page's single `h1`, a lede paragraph, a CTA slot (`actions`), and an
 * optional `children` slot rendered below the hero copy (e.g. a product
 * mockup or annotated screenshot).
 *
 * Uses the `display` type-scale token on large screens; below `lg` it steps
 * down through the responsive Tailwind sizes so headlines stay readable on
 * mobile.
 */
export function PageHero({
  eyebrow,
  title,
  lede,
  actions,
  children,
  align = "center",
  containerSize,
  id,
  className,
}: {
  /** Short badge text (or badge content, e.g. icon + text) above the title. */
  eyebrow?: ReactNode;
  /** Page headline — rendered as the page's `h1`. */
  title: ReactNode;
  /** Supporting paragraph under the headline. */
  lede?: ReactNode;
  /** CTA slot — typically one or two `Button` components. */
  actions?: ReactNode;
  /** Optional content below the hero copy (mockup, screenshot, media). */
  children?: ReactNode;
  align?: "center" | "start";
  /** Defaults to "narrow" for centered heroes, "default" for start-aligned. */
  containerSize?: ContainerSize;
  id?: string;
  /** Applied to the `<section>` (use for background glow/bands). */
  className?: string;
}) {
  const resolvedContainerSize: ContainerSize =
    containerSize ?? (align === "center" ? "narrow" : "default");

  return (
    <section
      id={id}
      data-slot="page-hero"
      className={cn(
        "py-section-sm md:py-section-lg relative overflow-hidden",
        className,
      )}
    >
      <Container size={resolvedContainerSize}>
        <div className={align === "center" ? "text-center" : "text-left"}>
          {eyebrow ? (
            <div
              className={cn(
                "border-primary/20 bg-primary/5 text-primary mb-6 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                align === "center" && "mx-auto",
              )}
            >
              {eyebrow}
            </div>
          ) : null}
          <h1 className="text-foreground lg:text-display text-4xl font-bold tracking-tight sm:text-5xl">
            {title}
          </h1>
          {lede ? (
            <p
              className={cn(
                "text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed sm:text-xl",
                align === "center" && "mx-auto",
              )}
            >
              {lede}
            </p>
          ) : null}
          {actions ? (
            <div
              className={cn(
                "mt-8 flex flex-col items-center gap-3 sm:flex-row sm:gap-4",
                align === "center" ? "sm:justify-center" : "sm:justify-start",
              )}
            >
              {actions}
            </div>
          ) : null}
        </div>
        {children}
      </Container>
    </section>
  );
}
