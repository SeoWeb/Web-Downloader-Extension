import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What PagePocket collects, where your archives are stored, the cookies the site uses, and how to get your data deleted.",
  alternates: {
    canonical: "https://pagepocket.app/privacy",
  },
  openGraph: {
    title: "Privacy Policy",
    description:
      "What PagePocket collects, where your archives are stored, the cookies the site uses, and how to get your data deleted.",
  },
  twitter: {
    card: "summary",
    title: "Privacy Policy",
    description:
      "What PagePocket collects, where your archives are stored, the cookies the site uses, and how to get your data deleted.",
  },
};

export default function PrivacyPage() {
  return (
    <section className="px-4 py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Last updated: October 2026
        </p>

        <p className="text-muted-foreground mt-6 leading-relaxed">
          PagePocket is a browser extension and web app for saving your own copy
          of web pages. This page explains what data the service handles and
          why. The short version: we store what you need to use the product — an
          account, and the pages you save — and nothing else. There is no
          advertising or analytics tracking on this site.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">What we collect</h2>
        <ul className="text-muted-foreground list-outside list-disc space-y-2 pl-5 leading-relaxed">
          <li>
            <span className="text-foreground font-medium">Account data:</span>{" "}
            your email address and a password. Passwords are stored only as
            cryptographic hashes — we never see or store the plaintext.
          </li>
          <li>
            <span className="text-foreground font-medium">Archived pages:</span>{" "}
            the content and metadata of the pages you choose to save (URL,
            title, save time, full page content, full-text search index).
          </li>
          <li>
            <span className="text-foreground font-medium">Library data:</span>{" "}
            your collections, notes, and product settings.
          </li>
        </ul>
        <p className="text-muted-foreground mt-4 leading-relaxed">
          We do not collect browsing history, behavioural profiles, or data from
          pages you visit without explicitly saving them. The extension only
          sends a page to PagePocket when you ask it to.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">
          Where your data is stored
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Archived page content is stored as objects in Cloudflare R2 object
          storage, running on Cloudflare&rsquo;s infrastructure (EU/US). Your
          account record and library metadata are stored in a managed database.
          Sign-in is handled by the app&rsquo;s backend, which issues session
          tokens to your browser; the servers sit behind Cloudflare.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Cookies</h2>
        <p className="text-muted-foreground leading-relaxed">
          The site sets only the cookies required to keep you signed in
          (authentication session cookies). We do not use advertising cookies or
          analytics tracking on the marketing site or in the app. Signing out
          clears the session cookies.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Third parties</h2>
        <p className="text-muted-foreground leading-relaxed">
          PagePocket runs on Cloudflare infrastructure for storage and delivery.
          Cloudflare processes data on our behalf as infrastructure, not for its
          own purposes. We do not sell data, and we do not share it with
          advertisers or data brokers. The browser extension itself is
          distributed through the Chrome Web Store, which is subject to
          Google&rsquo;s own policies.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">
          Retention and deletion
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Your archived pages are kept until you delete them — you can remove
          individual pages from your library in the app at any time. Account
          deletion is not automated yet: if you want your account and all of its
          data permanently deleted, reach out through the project&rsquo;s GitHub
          repository and we will delete it for you.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Contact</h2>
        <p className="text-muted-foreground leading-relaxed">
          PagePocket is an open-source project. For any privacy question or
          request — including data deletion — open an issue or contact the
          maintainers via{" "}
          <Link
            href="https://github.com/SeoWeb/Web-Downloader-Extension"
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/SeoWeb/Web-Downloader-Extension
          </Link>
          .
        </p>
      </div>
    </section>
  );
}
