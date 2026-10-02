import type { ReactNode } from "react";
import Link from "next/link";

export default function ShareLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-12 max-w-6xl items-center justify-center px-4">
          <Link
            href="/"
            className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            Shared via PagePocket
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
