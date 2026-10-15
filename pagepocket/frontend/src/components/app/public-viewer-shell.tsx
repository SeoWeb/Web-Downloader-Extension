"use client";

// Nested sandbox intersection (defense in depth, archived-html-serving):
// the serving route (/api/sc/*) already responds with
// `Content-Security-Policy: sandbox allow-popups allow-forms`; this iframe
// attribute is the second, independent layer. The browser enforces the
// STRICTER of the two, so neither layer can relax the other:
// - NO `allow-same-origin` here (and none in the CSP): the archived document
//   is a unique opaque origin — even a script that somehow executes gets no
//   access to pagepocket.app cookies, storage, or DOM.
// - `allow-popups` / `allow-forms` still work: window.open links and form
//   controls inside the archived page keep functioning as captured.
// - Scripts never run: `allow-scripts` is granted by neither layer.
const IFRAME_SANDBOX = "allow-popups allow-forms";

type PublicViewerShellProps = {
  token: string;
};

export function PublicViewerShell({ token }: PublicViewerShellProps) {
  const iframeSrc = `/api/sc/${token}/index.html`;

  return (
    <div className="flex-1">
      <iframe
        src={iframeSrc}
        sandbox={IFRAME_SANDBOX}
        className="w-full h-[calc(100dvh-3rem)] border-0"
        title="Shared page content"
      />
    </div>
  );
}
