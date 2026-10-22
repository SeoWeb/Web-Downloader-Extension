"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { CHROME_WEB_STORE_URL } from "@/components/marketing/site-json-ld";

export default function OnboardingPage() {
  const router = useRouter();

  useEffect(() => {
    const timeout = setTimeout(() => router.replace("/app"), 3000);
    return () => clearTimeout(timeout);
  }, [router]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md space-y-4 text-center">
        <div className="bg-primary/10 mx-auto flex size-16 items-center justify-center rounded-full">
          <Sparkles className="text-primary size-8" />
        </div>
        <h1 className="text-2xl font-semibold">Welcome to PagePocket!</h1>
        <p className="text-muted-foreground">
          Your account is ready. Install the browser extension to start saving
          pages, then find them here anytime.
        </p>
        <a
          href={CHROME_WEB_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium"
        >
          Install the extension
        </a>
        <p className="text-muted-foreground text-xs">
          Redirecting to your dashboard...
        </p>
      </div>
    </div>
  );
}
