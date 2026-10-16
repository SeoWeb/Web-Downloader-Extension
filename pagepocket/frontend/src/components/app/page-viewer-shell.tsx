"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, Share2, Trash2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/app/share-dialog";
import { useHotkeys } from "@/hooks/use-hotkeys";
import type { PageResponse } from "@/lib/api/schemas";

type PageViewerShellProps = {
  pageId: string;
  pageMeta: PageResponse | null;
};

// Nested sandbox intersection (defense in depth, archived-html-serving):
// the serving route (/api/pp/archive/*/f/*, backed by the gateway's
// /api/v1/archive/pages/{page_id}/f/*) already responds with
// `Content-Security-Policy: sandbox allow-popups allow-forms`; this iframe
// attribute is the second, independent layer. The browser enforces the
// STRICTER of the two, so neither layer can relax the other:
// - NO `allow-same-origin` here (and none in the CSP): the archived document
//   is a unique opaque origin — even a script that somehow executes gets no
//   access to pagepocket.app cookies, storage, or DOM. This holds for
//   logged-in viewing too: archived pages are attacker-controlled input
//   (the product archives arbitrary web pages), so same-origin access would
//   turn any script gap into account takeover.
// - `allow-popups` / `allow-forms` still work: window.open links and form
//   controls inside the archived page keep functioning as captured.
// - Scripts never run: `allow-scripts` is granted by neither layer.
const IFRAME_SANDBOX = "allow-popups allow-forms";

export function PageViewerShell({
  pageId,
  pageMeta,
}: PageViewerShellProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    if (deleting) return;
    if (!confirm("Delete this page?")) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/pp/archive/pages/${pageId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        // Delete failed — surface it and keep the page viewable. Never
        // navigate away as if the deletion had succeeded.
        toast.error("Failed to delete page");
        return;
      }
      router.push("/app");
    } catch {
      toast.error("Network error — page not deleted");
    } finally {
      setDeleting(false);
    }
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
                saved {formatDistanceToNow(new Date(archivedAt + "Z"), { addSuffix: true })}
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
              disabled={deleting}
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
