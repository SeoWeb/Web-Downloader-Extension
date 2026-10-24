"use client";

import {
  IFRAME_SANDBOX,
  PageFormatViewer,
} from "@/components/app/page-format-viewer";
import {
  CONTENT_FILE_NAMES,
  isLegacyHtmlOnly,
  knownContentFormats,
  type ContentFormat,
} from "@/lib/content-formats";

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
