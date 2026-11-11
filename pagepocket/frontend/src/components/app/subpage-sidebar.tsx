"use client";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Viewer-side subpage navigation (multipage-download-fixes 8.3/D8).
 *
 * The shells own everything except this drawer: the burger button (placed
 * where each shell's header conventions allow), the active-document
 * derivation from the `?page=` URL param, and the pane swap. The drawer is
 * a pure listing: one entry per stored document, title + host/path, the
 * active one highlighted.
 */

export type ViewerDocumentEntry = {
  /**
   * Manifest path of the document under `pages/` — "" selects the page's
   * own documents (the scraped first page, `index.*`), clearing `?page=`.
   */
  path: string;
  /** Primary label. Callers substitute a fallback for empty titles. */
  title: string;
  /** Secondary host/path line — omitted from the DOM when empty. */
  secondary: string;
};

/**
 * Secondary sidebar line for a document's source URL: `host + path` per the
 * spec ("title and host/path"). Unparseable input renders verbatim (the CSS
 * truncates), empty input yields "" and the caller substitutes a fallback.
 */
export function hostPathLine(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${path}`;
  } catch {
    return url;
  }
}

type SubpageSidebarProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: ViewerDocumentEntry[];
  /** Active entry's path ("" = the page's own documents). */
  activePath: string;
  /** Selection handler — receives the entry's path ("" = main documents). */
  onSelect: (path: string) => void;
};

export function SubpageSidebar({
  open,
  onOpenChange,
  entries,
  activePath,
  onSelect,
}: SubpageSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="gap-0">
        <SheetHeader>
          <SheetTitle>Pages</SheetTitle>
          <SheetDescription>Documents stored in this archive</SheetDescription>
        </SheetHeader>
        <nav
          aria-label="Pages"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-4"
        >
          <ul className="space-y-0.5">
            {entries.map((entry, index) => {
              const active = entry.path === activePath;
              return (
                <li key={entry.path || `__main_${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelect(entry.path)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <span className="w-full truncate font-medium">
                      {entry.title}
                    </span>
                    {entry.secondary && (
                      <span className="text-muted-foreground w-full truncate text-xs">
                        {entry.secondary}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
