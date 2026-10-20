import type { ReactNode } from "react";
import Link from "next/link";
import { Archive } from "lucide-react";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MarketingAuthCta } from "@/components/app/marketing-auth-cta";

export default async function MarketingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-border bg-background/80 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-50 border-b backdrop-blur-md">
        <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-semibold"
          >
            <Archive className="text-primary size-5" />
            PagePocket
          </Link>
          <div className="flex items-center gap-5">
            <Link
              href="/features"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Features
            </Link>
            <Link
              href="/pricing"
              className="text-muted-foreground hover:text-foreground text-sm transition-colors"
            >
              Pricing
            </Link>
            {/* Calm on small screens: secondary destinations hide instead of
                collapsing into a dropdown menu. */}
            <Link
              href="/use-cases"
              className="text-muted-foreground hover:text-foreground hidden text-sm transition-colors sm:inline"
            >
              Use cases
            </Link>
            <Link
              href="/blog"
              className="text-muted-foreground hover:text-foreground hidden text-sm transition-colors sm:inline"
            >
              Blog
            </Link>
            <MarketingAuthCta />
            <ThemeToggle />
          </div>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-border border-t">
        <div className="mx-auto max-w-6xl px-4 py-12">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {/* Brand */}
            <div>
              <Link
                href="/"
                className="flex items-center gap-2 text-lg font-semibold"
              >
                <Archive className="text-primary size-5" />
                PagePocket
              </Link>
              <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                The web archive that works for you. Save, organise, search, and
                share web pages.
              </p>
            </div>

            {/* Product */}
            <div>
              <h3 className="mb-3 text-sm font-semibold">Product</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="/features"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Features
                  </Link>
                </li>
                <li>
                  <Link
                    href="/pricing"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Pricing
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://chromewebstore.google.com/detail/web-page-downloader/aeojmgngnebhbjpncamiplkimkbnmpmk"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Install for Chrome
                  </Link>
                </li>
              </ul>
            </div>

            {/* Resources */}
            <div>
              <h3 className="mb-3 text-sm font-semibold">Resources</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="https://github.com/SeoWeb/Web-Downloader-Extension"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    GitHub
                  </Link>
                </li>
                <li>
                  <Link
                    href="https://github.com/SeoWeb/Web-Downloader-Extension/issues"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
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
              <h3 className="mb-3 text-sm font-semibold">Legal</h3>
              <ul className="space-y-2">
                <li>
                  <Link
                    href="/privacy"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link
                    href="/terms"
                    className="text-muted-foreground hover:text-foreground text-sm transition-colors"
                  >
                    Terms of Service
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-border text-muted-foreground mt-10 border-t pt-6 text-center text-sm">
            &copy; {new Date().getFullYear()} PagePocket. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}
