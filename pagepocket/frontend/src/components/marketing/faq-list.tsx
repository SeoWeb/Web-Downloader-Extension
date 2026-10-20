import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { JsonLd } from "./json-ld";

/**
 * FaqList — accessible `<details>`/`<summary>` FAQ with matching FAQPage
 * JSON-LD emitted by the same component (design D5 + content-engine spec).
 *
 * Server component (no "use client"): `<details>` needs no JavaScript, so
 * the expand/collapse stays native and the JS budget is untouched.
 *
 * Because the schema is derived from the same `items` array that renders
 * the visible questions, the on-page FAQ and the FAQPage structured data
 * can never drift apart. No items → renders nothing at all (an empty
 * `mainEntity` would be invalid FAQPage data).
 */

export interface FaqItem {
  question: string;
  answer: string;
}

export function FaqList({
  items,
  className,
}: {
  items: readonly FaqItem[];
  className?: string;
}) {
  if (items.length === 0) {
    return null;
  }

  const faqPageJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };

  return (
    <div data-slot="faq-list" className={cn("space-y-3", className)}>
      <JsonLd data={faqPageJsonLd} />
      {items.map((item) => (
        <details
          key={item.question}
          data-slot="faq-item"
          className="group border-border bg-card rounded-xl border"
        >
          <summary className="hover:text-foreground flex cursor-pointer list-none items-center justify-between gap-4 p-4 text-sm font-medium transition-colors select-none [&::-webkit-details-marker]:hidden">
            {item.question}
            <ChevronDown
              aria-hidden="true"
              className="text-muted-foreground size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="text-muted-foreground px-4 pb-4 text-sm leading-relaxed">
            {item.answer}
          </div>
        </details>
      ))}
    </div>
  );
}
