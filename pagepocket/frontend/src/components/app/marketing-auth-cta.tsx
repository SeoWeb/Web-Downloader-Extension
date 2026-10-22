"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CHROME_WEB_STORE_URL } from "@/components/marketing/site-json-ld";

// Client-side auth CTA so the marketing layout stays statically rendered.
// Renders the anonymous actions by default (matching the prerendered HTML)
// and swaps to the dashboard link once the session probe resolves.
export function MarketingAuthCta() {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/session")
      .then((res) => (res.ok ? res.json() : { authenticated: false }))
      .then((data) => {
        if (!cancelled) setAuthenticated(Boolean(data?.authenticated));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  if (authenticated) {
    return (
      <Link
        href="/app"
        className="text-primary hover:text-primary/80 text-sm font-medium transition-colors"
      >
        Open dashboard
      </Link>
    );
  }

  return (
    <>
      {/* Install points straight at the Chrome Web Store listing (marketing
          spec "Trust Links": install links go to the exact listing, never a
          generic category page) and opens in a new tab. */}
      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        render={
          <a
            href={CHROME_WEB_STORE_URL}
            target="_blank"
            rel="noopener noreferrer"
          />
        }
      >
        <Download className="size-3.5" />
        Install
      </Button>
      <Link
        href="/login"
        className="text-primary hover:text-primary/80 text-sm font-medium transition-colors"
      >
        Sign in
      </Link>
    </>
  );
}
