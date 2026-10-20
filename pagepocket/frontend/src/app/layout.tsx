import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "@/lib/env";
import { MARKETING_SITE_URL } from "@/lib/marketing-routes";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Resolves every relative OG/canonical/OG-image URL against the production
  // origin, even while both pagepocket.app and app.pagepocket.app serve this
  // app (design D1/D5).
  metadataBase: new URL(MARKETING_SITE_URL),
  title: {
    default: "PagePocket — Your private Wayback Machine",
    template: "%s · PagePocket",
  },
  description:
    "Your private Wayback Machine. Save full-fidelity copies of any web page to a private, searchable library and share them with a simple link. Free to start, Pro at $2/mo.",
  applicationName: "PagePocket",
  openGraph: {
    type: "website",
    siteName: "PagePocket",
    locale: "en_US",
    // No default image: per-route opengraph-image routes supply OG images
    // (a default URL would 404 until they exist). og:title/og:description
    // inherit automatically from the resolved title/description.
  },
  twitter: {
    card: "summary_large_image",
    // title/description/images inherit from openGraph via post-processing.
  },
  // app/manifest.ts generates the route; this is what emits the <link>.
  manifest: "/manifest.webmanifest",
  icons: {
    // Classic favicon comes from src/app/favicon.ico (file convention).
    icon: [
      { url: "/icons/32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/icons/256x256.png", sizes: "256x256", type: "image/png" },
    ],
    apple: [{ url: "/icons/256x256.png", sizes: "256x256", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <TooltipProvider>
            {children}
            <Toaster
              position="top-right"
              toastOptions={{
                className:
                  "sm:!right-4 sm:!top-4 !left-4 !right-4 !top-4 sm:!left-auto sm:!w-auto",
              }}
            />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
