"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Share2, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/app/share-dialog";
import { useHotkeys } from "@/hooks/use-hotkeys";
import type { PageResponse } from "@/lib/api/schemas";

type PageViewerShellProps = {
  pageId: string;
  pageMeta: PageResponse | null;
};

const IFRAME_SANDBOX = "allow-same-origin allow-popups allow-forms";

export function PageViewerShell({
  pageId,
  pageMeta,
}: PageViewerShellProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);
  const iframeSrc = `/api/pp/archive/pages/${pageId}/f/index.html`;

  function handleBack() {
    const referrer = document.referrer;
    if (referrer) {
      try {
        const refUrl = new URL(referrer);
        if (
          refUrl.origin === window.location.origin &&
          refUrl.pathname.startsWith("/app")
        ) {
          router.push(refUrl.pathname + refUrl.search);
          return;
        }
      } catch {
        // Invalid referrer — fall through
      }
    }
    router.push("/app");
  }

  async function handleDelete() {
    if (!confirm("Delete this page?")) return;
    await fetch(`/api/pp/archive/pages/${pageId}`, { method: "DELETE" });
    router.push("/app");
  }

  useHotkeys([
    {
      key: "Escape",
      handler: () => handleBack(),
    },
    {
      key: "s",
      handler: (e) => {
        e.preventDefault();
        setShareOpen(true);
      },
    },
    {
      key: "Delete",
      handler: () => handleDelete(),
    },
  ]);

  const title = pageMeta?.title ?? "Saved Page";
  const sourceUrl = pageMeta?.url;
  const archivedAt = pageMeta?.archived_at;

  return (
    <>
      <div className="flex flex-col h-[calc(100dvh-3rem)]">
        <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-border bg-background/95 backdrop-blur px-4">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleBack}
              aria-label="Back to library"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="text-sm font-medium truncate">{title}</span>
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground shrink-0 flex items-center gap-1"
              >
                <ExternalLink className="size-3" />
                source
              </a>
            )}
            {archivedAt && (
              <span className="text-xs text-muted-foreground shrink-0 hidden sm:inline">
                saved {formatDistanceToNow(new Date(archivedAt), { addSuffix: true })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShareOpen(true)}
              aria-label="Share"
            >
              <Share2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDelete}
              aria-label="Delete"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
        <iframe
          src={iframeSrc}
          sandbox={IFRAME_SANDBOX}
          className="flex-1 w-full border-0"
          title="Saved page content"
        />
      </div>

      <ShareDialog
        pageId={pageId}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </>
  );
}
