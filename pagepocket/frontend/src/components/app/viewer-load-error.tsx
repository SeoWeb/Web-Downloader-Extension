"use client";

import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Retryable viewer load failure (multipage-download-fixes 8.4/D8): the
 * viewer routes render this instead of notFound() when the page-detail
 * fetch fails transiently (network error, gateway error, 5xx) — the
 * operator's "didn't load until reload" case becomes a visible retry
 * instead of a dead end. A true 404 never reaches this state (the routes
 * call notFound() for it, unchanged).
 *
 * Retry re-runs the server component via router.refresh(): a fresh RSC
 * request re-fetches the page detail; client state (none here) and scroll
 * position survive the merge.
 */
export function ViewerLoadError() {
  const router = useRouter();
  return (
    <div
      role="alert"
      className="flex h-[calc(100dvh-3rem)] flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <p className="text-muted-foreground text-sm">
        This page could not be loaded.
      </p>
      <Button variant="outline" size="sm" onClick={() => router.refresh()}>
        <RefreshCw data-icon="inline-start" />
        Retry
      </Button>
    </div>
  );
}
