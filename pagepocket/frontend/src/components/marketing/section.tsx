import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Container, type ContainerSize } from "./container";

/**
 * Section — vertical rhythm wrapper for marketing page sections (design D7).
 *
 * Server component (no "use client"). Implements the section spacing scale
 * defined in `globals.css` (`py-section-sm` / `py-section` / `py-section-lg`)
 * and standardises the header block: uppercase eyebrow (kicker), an `h2`
 * title, and an optional subtitle — so every marketing section shares one
 * heading hierarchy and one rhythm.
 *
 * Section background bands (e.g. `bg-muted/30`) are passed via `className`
 * so the component stays token-driven and content-agnostic.
 */
export type SectionSpacing = "sm" | "md" | "lg";

const sectionSpacing: Record<SectionSpacing, string> = {
  sm: "py-section-sm",
  md: "py-section-sm md:py-section",
  lg: "py-section md:py-section-lg",
};

export function Section({
  eyebrow,
  title,
  subtitle,
  children,
  align = "center",
  spacing = "md",
  containerSize = "default",
  id,
  className,
  headerClassName,
}: {
  /** Small kicker rendered above the title. */
  eyebrow?: ReactNode;
  /** Section heading — always an `h2` to keep the heading hierarchy flat and consistent. */
  title?: ReactNode;
  /** Supporting sentence under the title. */
  subtitle?: ReactNode;
  /** Section content. */
  children?: ReactNode;
  align?: "center" | "start";
  spacing?: SectionSpacing;
  containerSize?: ContainerSize;
  /** Anchor id for in-page TOC links (e.g. features page sections). */
  id?: string;
  /** Applied to the `<section>` (use for background bands). */
  className?: string;
  /** Applied to the header block (use to override widths/spacing). */
  headerClassName?: string;
}) {
  const hasHeader = Boolean(eyebrow || title || subtitle);

  return (
    <section id={id} className={cn(sectionSpacing[spacing], className)}>
      <Container size={containerSize}>
        {hasHeader ? (
          <div
            className={cn(
              "mb-10 sm:mb-12",
              align === "center"
                ? "mx-auto max-w-2xl text-center"
                : "max-w-2xl text-left",
              headerClassName,
            )}
          >
            {eyebrow ? (
              <p className="text-primary mb-3 text-xs font-medium tracking-wider uppercase">
                {eyebrow}
              </p>
            ) : null}
            {title ? (
              <h2 className="text-h2 text-foreground font-bold tracking-tight">
                {title}
              </h2>
            ) : null}
            {subtitle ? (
              <p className="text-muted-foreground mt-4 text-lg leading-relaxed">
                {subtitle}
              </p>
            ) : null}
          </div>
        ) : null}
        {children}
      </Container>
    </section>
  );
}
