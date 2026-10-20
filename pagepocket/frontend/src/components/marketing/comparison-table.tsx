import { Fragment } from "react";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * ComparisonTable — honest, props-driven feature comparison for
 * /compare/* pages (design D6 + content-engine spec).
 *
 * Server component (no "use client"): a plain semantic `<table>` — no
 * client JS, sortable columns are deliberately out of scope to keep the
 * 120 KB route budget.
 *
 * Honesty rules baked in:
 *  - Highlighting (`highlightColumn`) is a calm primary tint, never a
 *    fabricated "BEST" badge.
 *  - Boolean cells render as lucide Check/X with `sr-only` accessible
 *    labels ("Included" / "Not included").
 *  - `undefined` values render as an em dash — "not applicable" is never
 *    shown as a win or a loss.
 *  - Rows may carry a `note` rendered as small print under the feature row
 *    (e.g. "when the competitor is the better choice" context).
 */

export interface ComparisonColumn {
  /** Stable key used to look up row values and match `highlightColumn`. */
  id: string;
  /** Product name shown in the column header. */
  name: string;
}

export type ComparisonCellValue = boolean | string;

export interface ComparisonRow {
  /** Feature name shown in the row header (`th[scope="row"]`). */
  feature: string;
  /** Cell values keyed by column id; `undefined` renders an em dash. */
  values: Record<string, ComparisonCellValue | undefined>;
  /** Optional small-print note rendered as a full-width row under this feature. */
  note?: string;
}

export function ComparisonTable({
  columns,
  rows,
  highlightColumn,
  caption,
  className,
}: {
  columns: readonly ComparisonColumn[];
  rows: readonly ComparisonRow[];
  /** Column id to highlight (PagePocket). No column is highlighted when omitted. */
  highlightColumn?: string;
  /** Accessible table description (rendered as an `sr-only` caption). */
  caption?: string;
  className?: string;
}) {
  return (
    <div
      data-slot="comparison-table"
      className={cn(
        "border-border bg-card overflow-x-auto rounded-xl border",
        className,
      )}
    >
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr className="border-border bg-muted/30 border-b">
            <th
              scope="col"
              className="text-muted-foreground px-4 py-3 text-left text-xs font-medium tracking-wider uppercase"
            >
              Feature
            </th>
            {columns.map((column) => {
              const highlighted = column.id === highlightColumn;
              return (
                <th
                  key={column.id}
                  scope="col"
                  data-highlight={highlighted || undefined}
                  className={cn(
                    "px-4 py-3 text-left font-semibold",
                    highlighted && "bg-primary/5 text-primary",
                  )}
                >
                  {column.name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.feature}>
              <tr
                className={cn(
                  "border-border border-b",
                  row.note && "border-b-0",
                )}
              >
                <th
                  scope="row"
                  className="text-foreground px-4 py-3 text-left align-top font-medium"
                >
                  {row.feature}
                </th>
                {columns.map((column) => {
                  const value = row.values[column.id];
                  const highlighted = column.id === highlightColumn;
                  return (
                    <td
                      key={column.id}
                      data-highlight={highlighted || undefined}
                      className={cn(
                        "px-4 py-3 align-top leading-relaxed",
                        highlighted && "bg-primary/5 font-medium",
                      )}
                    >
                      <ComparisonCell value={value} />
                    </td>
                  );
                })}
              </tr>
              {row.note ? (
                <tr className="border-border bg-muted/20 border-b">
                  <td
                    colSpan={columns.length + 1}
                    className="text-muted-foreground px-4 py-2 text-xs leading-relaxed"
                  >
                    {row.note}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonCell({ value }: { value: ComparisonCellValue | undefined }) {
  if (value === undefined) {
    return (
      <span className="text-muted-foreground">
        &mdash;<span className="sr-only">Not applicable</span>
      </span>
    );
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="text-primary inline-flex items-center">
        <Check aria-hidden="true" className="size-4" />
        <span className="sr-only">Included</span>
      </span>
    ) : (
      <span className="text-muted-foreground inline-flex items-center">
        <X aria-hidden="true" className="size-4" />
        <span className="sr-only">Not included</span>
      </span>
    );
  }
  return <span>{value}</span>;
}
