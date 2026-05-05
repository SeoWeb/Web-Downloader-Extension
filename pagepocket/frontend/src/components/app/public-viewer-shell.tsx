"use client";

import { useEffect, useMemo } from "react";

const IFRAME_SANDBOX = "allow-same-origin allow-popups allow-forms";

type PublicViewerShellProps = {
  url: string;
  expiresAt: string | null;
};

export function PublicViewerShell({ url, expiresAt }: PublicViewerShellProps) {
  const alreadyExpired = useMemo(() => {
    if (!expiresAt) return false;
    return Date.now() >= new Date(expiresAt).getTime() - 10000;
  }, [expiresAt]);

  useEffect(() => {
    if (!expiresAt || alreadyExpired) return;

    const refreshAt = new Date(expiresAt).getTime() - 10000;
    const delay = refreshAt - Date.now();

    const timer = setTimeout(() => {
      window.location.reload();
    }, delay);

    return () => clearTimeout(timer);
  }, [expiresAt, alreadyExpired]);

  if (alreadyExpired) {
    return (
      <div className="flex flex-1 items-center justify-center py-12">
        <div className="text-center space-y-4">
          <h1 className="text-xl font-semibold">This link has expired</h1>
          <p className="text-sm text-muted-foreground">
            The shared page is no longer available.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1">
      <iframe
        src={url}
        sandbox={IFRAME_SANDBOX}
        className="w-full h-[calc(100dvh-3rem)] border-0"
        title="Shared page content"
      />
    </div>
  );
}
