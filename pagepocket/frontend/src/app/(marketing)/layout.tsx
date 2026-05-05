import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getCurrentUserId } from "@/lib/auth/server-session";

export default async function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const userId = await getCurrentUserId(await cookies());

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="font-semibold text-lg">
            PagePocket
          </Link>
          <div className="flex items-center gap-6">
            <Link
              href="/features"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Features
            </Link>
            <Link
              href="/pricing"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </Link>
            {userId ? (
              <Link
                href="/app"
                className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
              >
                Open dashboard
              </Link>
            ) : (
              <Link
                href="/login"
                className="text-sm font-medium text-primary hover:text-primary/80 transition-colors"
              >
                Sign in
              </Link>
            )}
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border py-8">
        <div className="mx-auto max-w-6xl px-4 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} PagePocket. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
