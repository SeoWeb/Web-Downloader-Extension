"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Share2,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "@/components/app/share-dialog";
import {
  IFRAME_SANDBOX,
  PageFormatViewer,
} from "@/components/app/page-format-viewer";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useNavTrail } from "@/hooks/use-nav-trail";
import {
  CONTENT_FILE_NAMES,
  isLegacyHtmlOnly,
  knownContentFormats,
  type ContentFormat,
} from "@/lib/content-formats";
import type { PageResponse } from "@/lib/api/schemas";

type PageViewerShellProps = {
  pageId: string;
  pageMeta: PageResponse | null;
};

// Nested sandbox intersection (defense in depth, archived-html-serving):
// the serving route (/api/pp/archive/*/f/*, backed by the gateway's
// /api/v1/archive/pages/{page_id}/f/*) already responds with
// `Content-Security-Policy: sandbox allow-popups allow-forms`; the iframe
// attribute (IFRAME_SANDBOX, defined once in page-format-viewer.tsx) is the
// second, independent layer. The browser enforces the STRICTER of the two, so
// neither layer can relax the other:
// - NO `allow-same-origin` here (and none in the CSP): the archived document
//   is a unique opaque origin — even a script that somehow executes gets no
//   access to pagepocket.app cookies, storage, or DOM. This holds for
//   logged-in viewing too: archived pages are attacker-controlled input
//   (the product archives arbitrary web pages), so same-origin access would
//   turn any script gap into account takeover.
// - `allow-popups` / `allow-forms` still work: window.open links and form
//   controls inside the archived page keep functioning as captured.
// - Scripts never run: `allow-scripts` is granted by neither layer.

export function PageViewerShell({ pageId, pageMeta }: PageViewerShellProps) {
  const router = useRouter();
  const [shareOpen, setShareOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Format switcher (text-native-downloads D6): derive tabs from the page's
  // known content formats; html-only and unknown/absent fields render the
  // bare legacy iframe, byte-identical to the pre-switcher viewer.
  const knownFormats = knownContentFormats(pageMeta?.content_formats);
  const fileUrls: Record<ContentFormat, string> = {
    html: `/api/pp/archive/pages/${pageId}/f/${CONTENT_FILE_NAMES.html}`,
    markdown: `/api/pp/archive/pages/${pageId}/f/${CONTENT_FILE_NAMES.markdown}`,
    text: `/api/pp/archive/pages/${pageId}/f/${CONTENT_FILE_NAMES.text}`,
  };

  // Back (pagepocket-frontend-viewer-back-trail): resolves the destination
  // from the sessionStorage navigation trail (useNavTrail) — deterministic
  // page → wherever it was opened from (library/collection/search), or /app
  // for deep links and reloads. `document.referrer` was unusable here: SPA
  // navigations never update it (stale/empty), and after a reload it equals
  // the current URL, turning back into a no-op push.
  const goBack = useNavTrail();

  function handleBack() {
    router.push(goBack("/app"));
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

  // Download (pagepocket-frontend-page-viewer): a plain navigation to the BFF
  // archive ZIP route — the browser owns download UX, so there is no fetch,
  // no progress state, and nothing to clean up. The label states honestly
  // (honesty surface) that this is a static snapshot without scripts.
  function handleDownload() {
    window.location.assign(`/api/pp/archive/pages/${pageId}/zip`);
  }

  useHotkeys([
    {
      key: "Escape",
      handler: () => handleBack(),
    },
    {
      key: "d",
      handler: (e) => {
        e.preventDefault();
        handleDownload();
      },
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
      <div className="flex h-[calc(100dvh-3rem)] flex-col">
        <div className="border-border bg-background/95 sticky top-0 z-10 flex h-12 items-center justify-between border-b px-4 backdrop-blur">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleBack}
              aria-label="Back to library"
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="truncate text-sm font-medium">{title}</span>
            {sourceUrl && (
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-xs"
              >
                <ExternalLink className="size-3" />
                source
              </a>
            )}
            {archivedAt && (
              <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                saved{" "}
                {formatDistanceToNow(new Date(archivedAt + "Z"), {
                  addSuffix: true,
                })}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDownload}
              aria-label="Download as ZIP — static snapshot, scripts not included"
              title="Download as ZIP — static snapshot, scripts not included"
            >
              <Download className="size-4" />
            </Button>
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
        {isLegacyHtmlOnly(knownFormats) ? (
          <iframe
            src={fileUrls.html}
            sandbox={IFRAME_SANDBOX}
            className="w-full flex-1 border-0"
            title="Saved page content"
          />
        ) : (
          <PageFormatViewer formats={knownFormats} fileUrls={fileUrls} />
        )}
      </div>

      <ShareDialog
        pageId={pageId}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </>
  );
}
