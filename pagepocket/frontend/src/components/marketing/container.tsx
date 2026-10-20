import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Container — shared max-width wrapper for marketing layouts.
 *
 * Server component (no "use client"). Matches the existing marketing
 * gutters (`px-4`) and the content widths already used across the
 * `(marketing)` pages (nav/footer use `max-w-6xl`, body sections use
 * `max-w-3xl`–`max-w-5xl`).
 *
 * Sizes:
 *  - "prose"   → max-w-2xl (long-form copy, legal pages)
 *  - "narrow"  → max-w-3xl (centered heroes, FAQ columns)
 *  - "default" → max-w-5xl (standard content sections)
 *  - "wide"    → max-w-6xl (comparison tables, page chrome)
 */
export type ContainerSize = "prose" | "narrow" | "default" | "wide";

const containerSizes: Record<ContainerSize, string> = {
  prose: "max-w-2xl",
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  wide: "max-w-6xl",
};

export function Container({
  size = "default",
  className,
  children,
}: {
  size?: ContainerSize;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="container"
      className={cn("mx-auto w-full px-4", containerSizes[size], className)}
    >
      {children}
    </div>
  );
}
