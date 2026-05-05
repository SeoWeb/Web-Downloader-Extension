"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

export default function OnboardingPage() {
  const router = useRouter();

  useEffect(() => {
    const timeout = setTimeout(() => router.replace("/app"), 3000);
    return () => clearTimeout(timeout);
  }, [router]);

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center space-y-4 max-w-md">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-primary/10">
          <Sparkles className="size-8 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold">Welcome to PagePocket!</h1>
        <p className="text-muted-foreground">
          Your account is ready. Install the browser extension to start saving
          pages, then find them here anytime.
        </p>
        <a
          href="https://chromewebstore.google.com/category/extensions"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Install the extension
        </a>
        <p className="text-xs text-muted-foreground">
          Redirecting to your dashboard...
        </p>
      </div>
    </div>
  );
}
