"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

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
        className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
      >
        Open dashboard
      </Link>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        nativeButton={false}
        render={<Link href="/features" />}
      >
        <Download className="size-3.5" />
        Install
      </Button>
      <Link
        href="/login"
        className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
      >
        Sign in
      </Link>
    </>
  );
}
