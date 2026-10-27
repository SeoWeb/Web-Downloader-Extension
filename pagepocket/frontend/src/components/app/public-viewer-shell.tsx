"use client";

import {
  IFRAME_SANDBOX,
  PageFormatViewer,
} from "@/components/app/page-format-viewer";
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
};

export function PublicViewerShell({ token, formats }: PublicViewerShellProps) {
  const knownFormats = knownContentFormats(formats);
  // Share files serve through the token route (the [...path] proxy composes
  // the gateway's /share/public/{token}/f/{file} URL) — same route family,
  // different stored file name per format.
  const fileUrls: Record<ContentFormat, string> = {
    html: `/api/sc/${token}/${CONTENT_FILE_NAMES.html}`,
    markdown: `/api/sc/${token}/${CONTENT_FILE_NAMES.markdown}`,
    text: `/api/sc/${token}/${CONTENT_FILE_NAMES.text}`,
  };

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

  if (isLegacyHtmlOnly(knownFormats)) {
    return (
      <div className="flex-1">
        <iframe
          src={fileUrls.html}
          sandbox={IFRAME_SANDBOX}
          className="h-[calc(100dvh-3rem)] w-full border-0"
          title="Shared page content"
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-1 flex-col">
      <PageFormatViewer
        formats={knownFormats}
        fileUrls={fileUrls}
        iframeTitle="Shared page content"
      />
    </div>
  );
}
