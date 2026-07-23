import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { getCurrentUserId } from "@/lib/auth/server-session";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Button } from "@/components/ui/button";
import { Archive, Download } from "lucide-react";

export default async function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  const userId = await getCurrentUserId(await cookies());

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
        <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold text-lg">
            <Archive className="size-5 text-primary" />
            PagePocket
          </Link>
          <div className="flex items-center gap-5">
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
            )}
            <ThemeToggle />
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-4 py-12">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {/* Brand */}
            <div>
              <Link href="/" className="flex items-center gap-2 font-semibold text-lg">
                <Archive className="size-5 text-primary" />
                PagePocket
              </Link>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                The web archive that works for you. Save, organise, search, and
                share web pages.
              </p>
            </div>

            {/* Product */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Product</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="/features"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Features
                  </Link>
                </li>
                <li>
                  <Link
                    href="/pricing"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link
                    href="/features#cloud-save"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Install extension
                  </Link>
                </li>
              </ul>
            </div>

            {/* Resources */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Resources</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="https://github.com/anomalyco/opencode"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://github.com/anomalyco/opencode/issues"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Report an issue
                  </Link>
                </li>
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h3 className="text-sm font-semibold mb-3">Legal</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="/privacy"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link
                    href="/terms"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-10 border-t border-border pt-6 text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} PagePocket. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
