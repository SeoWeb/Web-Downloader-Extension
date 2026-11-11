"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Menu,
  Share2,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShareDialog } from "@/components/app/share-dialog";
import { GalleryView } from "@/components/app/gallery-view";
import {
  DocumentPane,
  IFRAME_SANDBOX,
  PageFormatViewer,
} from "@/components/app/page-format-viewer";
import {
  hostPathLine,
  SubpageSidebar,
  type ViewerDocumentEntry,
} from "@/components/app/subpage-sidebar";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useGalleryContent } from "@/hooks/use-gallery-images";
import {
  CONTENT_FILE_NAMES,
  isLegacyHtmlOnly,
  knownContentFormats,
  type ContentFormat,
} from "@/lib/content-formats";
import {
  archiveImageUrl,
  galleryImagesFromResponse,
  isImageGalleryTitle,
} from "@/lib/gallery";
import { clientApi } from "@/lib/client-api";
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

/**
 * Brief neutral state while the gallery listing is in flight (image gallery
 * feature): skeleton tiles in the gallery grid's layout, no iframe flash.
 */
function GalleryLoadingPlaceholder() {
  return (
    <div aria-busy="true" className="min-h-0 flex-1 px-4 py-4 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <Skeleton className="mb-3 h-4 w-24" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-[200px] w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function PageViewerShell({ pageId, pageMeta }: PageViewerShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
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

  // Subpage navigation (multipage-download-fixes 8.3/D8). The active
  // document is URL state, mirroring the format switcher's ?format pattern:
  // the viewer segment remounts on back/forward, so the selection must be
  // derivable from ?page= alone. An absent param (or one naming no stored
  // path) selects the sidebar's first entry — the page's own documents.
  const subpages = pageMeta?.pages ?? [];
  const multiDoc = subpages.length > 1;
  const requestedPage = searchParams.get("page");
  const activeSubpage =
    requestedPage && subpages.some((page) => page.path === requestedPage)
      ? (subpages.find((page) => page.path === requestedPage) ?? null)
      : null;
  const [subpagesOpen, setSubpagesOpen] = useState(false);

  // Mirror a selection into the URL with replace (no history entry, no
  // scroll), preserving every other param (?format= co-exists). "" selects
  // the page's own documents and clears the param. The sidebar closes on
  // any selection.
  function handleSelectSubpage(path: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (path) {
      params.set("page", path);
    } else {
      params.delete("page");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
    setSubpagesOpen(false);
  }

  // Image gallery (image gallery feature): only pages the downloader titled
  // as image galleries probe the listing — normal pages never fetch. A
  // usable answer (is_image_gallery + ≥1 image) replaces the iframe/format
  // viewer entirely (takes precedence over isLegacyHtmlOnly); a failure or
  // non-gallery answer falls back to today's rendering.
  const gallery = useGalleryContent(isImageGalleryTitle(pageMeta?.title), () =>
    clientApi
      .listPageImages(pageId)
      .then((response) =>
        galleryImagesFromResponse(response, (path) =>
          archiveImageUrl(pageId, path),
        ),
      )
      .catch(() => null),
  );
  // While the gallery lightbox is open it owns the keyboard: the shell's
  // hotkeys (Escape = back, d/s/Delete) are suppressed so Dialog's Esc
  // closes just the modal.
  const [lightboxOpen, setLightboxOpen] = useState(false);

  function handleBack() {
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

  // Download (pagepocket-frontend-page-viewer): a plain navigation to the BFF
  // archive ZIP route — the browser owns download UX, so there is no fetch,
  // no progress state, and nothing to clean up. The label states honestly
  // (honesty surface) that this is a static snapshot without scripts.
  function handleDownload() {
    window.location.assign(`/api/pp/archive/pages/${pageId}/zip`);
  }

  useHotkeys(
    lightboxOpen
      ? []
      : [
          {
            key: "Escape",
            handler: () => {
              // Subpage sidebar (multipage 8.3): Escape closes it first —
              // back-to-library only fires with no sidebar open (the Sheet
              // closes itself on Escape too; both paths stay back-nav free).
              if (subpagesOpen) {
                setSubpagesOpen(false);
                return;
              }
              handleBack();
            },
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
        ],
  );

  const title = pageMeta?.title ?? "Saved Page";
  const sourceUrl = pageMeta?.url;
  const archivedAt = pageMeta?.archived_at;

  // Sidebar listing (multipage 8.3): the page's own documents first (the
  // scraped first page — selecting it clears ?page=), then every stored
  // subpage document with title + host/path (the stored path when no URL
  // was captured).
  const sidebarEntries: ViewerDocumentEntry[] = [
    { path: "", title, secondary: hostPathLine(sourceUrl) },
    ...subpages.map((page) => ({
      path: page.path,
      title: page.title || page.path,
      secondary: hostPathLine(page.url) || page.path,
    })),
  ];

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
            {multiDoc && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setSubpagesOpen(true)}
                aria-label="Pages"
                aria-haspopup="dialog"
                title="Pages"
              >
                <Menu className="size-4" />
              </Button>
            )}
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
        {gallery.status === "gallery" ? (
          <GalleryView
            images={gallery.images}
            onLightboxOpenChange={setLightboxOpen}
          />
        ) : gallery.status === "loading" ? (
          <GalleryLoadingPlaceholder />
        ) : activeSubpage ? (
          // Subpage document (multipage 8.3/D8): the selected subpage swaps
          // the main pane in place — fetched from its stored pages/<path>
          // through the same sandboxed file route with the same no-store
          // pattern as the format tabs; the pane owns loading/error/retry.
          <DocumentPane
            format={activeSubpage.content_format}
            fileUrl={`/api/pp/archive/pages/${pageId}/f/pages/${activeSubpage.path}`}
          />
        ) : isLegacyHtmlOnly(knownFormats) ? (
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

      <SubpageSidebar
        open={subpagesOpen}
        onOpenChange={setSubpagesOpen}
        entries={sidebarEntries}
        activePath={activeSubpage?.path ?? ""}
        onSelect={handleSelectSubpage}
      />

      <ShareDialog
        pageId={pageId}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </>
  );
}
