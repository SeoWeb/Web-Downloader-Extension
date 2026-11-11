"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { GalleryView } from "@/components/app/gallery-view";
import { useGalleryContent } from "@/hooks/use-gallery-images";
import {
  CONTENT_FILE_NAMES,
  isLegacyHtmlOnly,
  knownContentFormats,
  type ContentFormat,
} from "@/lib/content-formats";
import {
  fetchSharePageImages,
  galleryImagesFromResponse,
  shareImageUrl,
} from "@/lib/gallery";
import type { PageSummary } from "@/lib/api/schemas";

// Nested sandbox intersection (defense in depth, archived-html-serving):
// the serving route (/api/sc/*) already responds with
// `Content-Security-Policy: sandbox allow-popups allow-forms`; the iframe
// attribute (IFRAME_SANDBOX, defined once in page-format-viewer.tsx) is the
// second, independent layer. The browser enforces the STRICTER of the two, so
// neither layer can relax the other:
// - NO `allow-same-origin` here (and none in the CSP): the archived document
//   is a unique opaque origin — even a script that somehow executes gets no
//   access to pagepocket.app cookies, storage, or DOM.
// - `allow-popups` / `allow-forms` still work: window.open links and form
//   controls inside the archived page keep functioning as captured.
// - Scripts never run: `allow-scripts` is granted by neither layer.

type PublicViewerShellProps = {
  token: string;
  /**
   * Raw `content_formats` from the share validation response (viewer parity,
   * text-native-downloads D6). Absent/empty — an older backend — renders the
   * bare legacy HTML iframe exactly as before.
   */
  formats?: string[];
  /**
   * Raw `pages` manifest from the share validation response (viewer parity,
   * multipage-download-fixes D8). Absent — an older gateway, the common case
   * today — renders no burger and the share behaves exactly as before.
   */
  pages?: PageSummary[] | undefined;
};

export function PublicViewerShell({
  token,
  formats,
  pages,
}: PublicViewerShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const knownFormats = knownContentFormats(formats);
  // Share files serve through the token route (the [...path] proxy composes
  // the gateway's /share/public/{token}/f/{file} URL) — same route family,
  // different stored file name per format.
  const fileUrls: Record<ContentFormat, string> = {
    html: `/api/sc/${token}/${CONTENT_FILE_NAMES.html}`,
    markdown: `/api/sc/${token}/${CONTENT_FILE_NAMES.markdown}`,
    text: `/api/sc/${token}/${CONTENT_FILE_NAMES.text}`,
  };

  // Subpage navigation (multipage-download-fixes 8.3/D8, share parity): the
  // same URL-derived active document and replace-without-scroll contract as
  // the authed viewer, over the token route's /f/ proxy. Shares without a
  // manifest (the common case today) never render the burger.
  const subpages = pages ?? [];
  const multiDoc = subpages.length > 1;
  const requestedPage = searchParams.get("page");
  const activeSubpage =
    requestedPage && subpages.some((page) => page.path === requestedPage)
      ? (subpages.find((page) => page.path === requestedPage) ?? null)
      : null;
  const [subpagesOpen, setSubpagesOpen] = useState(false);

  // Mirror a selection into the share URL with replace (no history entry,
  // no scroll), preserving every other param. "" selects the shared page's
  // own documents and clears the param. The sidebar closes on any selection.
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

  // The validation payload carries no page title/url (ValidateShareResponse
  // contract), so the main entry shows a neutral label without a secondary
  // line; subpage entries carry their stored title + host/path.
  const sidebarEntries: ViewerDocumentEntry[] = [
    { path: "", title: "Shared page", secondary: "" },
    ...subpages.map((page) => ({
      path: page.path,
      title: page.title || page.path,
      secondary: hostPathLine(page.url) || page.path,
    })),
  ];

  // Image gallery (image gallery feature). The share validation payload
  // carries NO page title (ValidateShareResponseSchema: valid/page_id/
  // expires_at/content_formats only), so the title trigger used by the
  // authed viewer is unavailable here. Safe trigger instead: probe the
  // images listing ONCE for html-only share pages (gallery archives are
  // html-only). Cost for a non-gallery share: one cheap 404/JSON request,
  // after which today's iframe renders unchanged; format-switcher pages
  // (markdown/text known) are never probed at all. Any failure or
  // non-gallery answer falls back to today's rendering.
  const gallery = useGalleryContent(isLegacyHtmlOnly(knownFormats), () =>
    fetchSharePageImages(token).then((response) =>
      response
        ? galleryImagesFromResponse(response, (path) =>
            shareImageUrl(token, path),
          )
        : null,
    ),
  );

  if (gallery.status === "gallery") {
    return (
      <div className="flex h-[calc(100dvh-3rem)] flex-1 flex-col">
        <GalleryView images={gallery.images} />
      </div>
    );
  }

  if (gallery.status === "loading") {
    return (
      <div
        aria-busy="true"
        className="flex h-[calc(100dvh-3rem)] flex-1 items-center justify-center"
      >
        <p className="text-muted-foreground text-sm">Loading gallery…</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100dvh-3rem)] flex-1 flex-col">
      {multiDoc && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setSubpagesOpen(true)}
          aria-label="Pages"
          aria-haspopup="dialog"
          title="Pages"
          className="border-border bg-background/80 absolute top-2 left-2 z-10 rounded-full border shadow-sm backdrop-blur"
        >
          <Menu className="size-4" />
        </Button>
      )}
      {activeSubpage ? (
        // Selected subpage document (multipage 8.3/D8): swaps the main pane
        // in place — fetched through the token route's sandboxed /f/ proxy
        // (pages/<path>) with the same no-store pattern as the format tabs.
        <DocumentPane
          format={activeSubpage.content_format}
          fileUrl={`/api/sc/${token}/pages/${activeSubpage.path}`}
        />
      ) : isLegacyHtmlOnly(knownFormats) ? (
        <div className="flex-1">
          <iframe
            src={fileUrls.html}
            sandbox={IFRAME_SANDBOX}
            className="h-[calc(100dvh-3rem)] w-full border-0"
            title="Shared page content"
          />
        </div>
      ) : (
        <div className="flex h-[calc(100dvh-3rem)] flex-1 flex-col">
          <PageFormatViewer
            formats={knownFormats}
            fileUrls={fileUrls}
            iframeTitle="Shared page content"
          />
        </div>
      )}

      <SubpageSidebar
        open={subpagesOpen}
        onOpenChange={setSubpagesOpen}
        entries={sidebarEntries}
        activePath={activeSubpage?.path ?? ""}
        onSelect={handleSelectSubpage}
      />
    </div>
  );
}
