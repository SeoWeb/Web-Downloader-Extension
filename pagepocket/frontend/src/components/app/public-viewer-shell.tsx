"use client";

const IFRAME_SANDBOX = "allow-same-origin allow-popups allow-forms";

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
