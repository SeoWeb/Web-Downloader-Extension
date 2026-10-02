import { Archive, Check, Search, Folder } from "lucide-react";

export function ProductMockup() {
  return (
    <div className="relative mx-auto max-w-3xl animate-fade-in-up animation-delay-200">
      {/* Glow behind mockup */}
      <div className="absolute -inset-8 -z-10 rounded-3xl bg-primary/10 blur-2xl" />

      {/* Browser frame */}
      <div className="rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        {/* Title bar */}
        <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="size-3 rounded-full bg-red-400/80" />
            <span className="size-3 rounded-full bg-yellow-400/80" />
            <span className="size-3 rounded-full bg-green-400/80" />
          </div>
          <div className="flex-1 mx-4">
            <div className="mx-auto flex max-w-md items-center gap-2 rounded-md bg-background px-3 py-1.5 text-xs text-muted-foreground border border-border">
              <Search className="size-3 shrink-0" />
              <span>pagepocket.app/app/pages/example</span>
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="flex">
          {/* Sidebar */}
          <div className="hidden sm:block w-48 border-r border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary">
              <Folder className="size-3" />
              Research
            </div>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground">
              <Folder className="size-3" />
              Articles
            </div>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground">
              <Folder className="size-3" />
              Inspiration
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
                Recent
              </div>
              <div className="space-y-1.5">
                <div className="rounded bg-background px-2 py-1 text-xs text-foreground truncate border border-border">
                  How to design...
                </div>
                <div className="rounded px-2 py-1 text-xs text-muted-foreground truncate">
                  Building a CSS...
                </div>
                <div className="rounded px-2 py-1 text-xs text-muted-foreground truncate">
                  Modern archiving...
                </div>
              </div>
            </div>
          </div>

          {/* Main content */}
          <div className="flex-1 p-6">
            {/* Page header */}
            <div className="mb-4 flex items-center gap-2">
              <div className="flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                <Archive className="size-2.5" />
                Saved
              </div>
              <span className="text-[10px] text-muted-foreground">3 hours ago</span>
            </div>
            <h3 className="text-sm font-semibold mb-2">
              Modern Web Archiving Techniques
            </h3>
            <div className="space-y-2 mb-4">
              <div className="h-2 w-full rounded bg-muted" />
              <div className="h-2 w-5/6 rounded bg-muted" />
              <div className="h-2 w-4/6 rounded bg-muted" />
            </div>
            <div className="space-y-2 mb-4">
              <div className="h-2 w-full rounded bg-muted" />
              <div className="h-2 w-3/4 rounded bg-muted" />
            </div>
            {/* Image placeholder */}
            <div className="mb-4 flex h-24 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-xs text-muted-foreground">
              preserved layout
            </div>
            <div className="space-y-2">
              <div className="h-2 w-full rounded bg-muted" />
              <div className="h-2 w-5/6 rounded bg-muted" />
              <div className="h-2 w-2/3 rounded bg-muted" />
            </div>
          </div>
        </div>
      </div>

      {/* Extension popup floating card */}
      <div className="absolute -right-4 top-12 sm:-right-8 sm:top-16 w-52 rounded-xl border border-border bg-card p-4 shadow-xl animate-float">
        <div className="flex items-center gap-2 mb-3">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Archive className="size-4" />
          </div>
          <div className="text-xs font-semibold">PagePocket</div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 mb-3">
          <Check className="size-4 text-primary shrink-0" />
          <span className="text-xs font-medium text-foreground">Page saved!</span>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Archive className="size-2.5" />
            Saved to Research
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Search className="size-2.5" />
            Full-text indexed
          </div>
        </div>
      </div>
    </div>
  );
}
