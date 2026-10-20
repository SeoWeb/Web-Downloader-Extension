import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms that apply when you use PagePocket: accounts, acceptable use, sharing, and liability.",
  alternates: {
    canonical: "https://pagepocket.app/terms",
  },
  openGraph: {
    title: "Terms of Service",
    description:
      "The terms that apply when you use PagePocket: accounts, acceptable use, sharing, and liability.",
  },
  twitter: {
    card: "summary",
    title: "Terms of Service",
    description:
      "The terms that apply when you use PagePocket: accounts, acceptable use, sharing, and liability.",
  },
};

export default function TermsPage() {
  return (
    <section className="px-4 py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold">Terms of Service</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Last updated: October 2026
        </p>

        <p className="text-muted-foreground mt-6 leading-relaxed">
          These terms apply when you use PagePocket — the browser extension, the
          web app at app.pagepocket.app, and this website. They are deliberately
          short and written in plain language. By using the service, you agree
          to them.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">The service</h2>
        <p className="text-muted-foreground leading-relaxed">
          PagePocket lets you save your own copy of web pages, organise them
          into collections, search them in full text, and share individual pages
          via link. A free tier with usage quotas and a paid Pro plan are
          described on the{" "}
          <Link href="/pricing" className="text-primary hover:underline">
            pricing page
          </Link>
          . PagePocket is an open-source project; the source code is public at{" "}
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

        <h2 className="mt-10 mb-3 text-xl font-semibold">Accounts</h2>
        <p className="text-muted-foreground leading-relaxed">
          You need an account (email and password) to save pages. You are
          responsible for the activity under your account and for keeping your
          credentials secure. We may suspend or terminate accounts that abuse
          the service or violate these terms.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Acceptable use</h2>
        <ul className="text-muted-foreground list-outside list-disc space-y-2 pl-5 leading-relaxed">
          <li>
            Only archive pages you have the right to access. Do not use the
            service to circumvent paywalls, access controls, or logins that are
            not yours.
          </li>
          <li>
            Respect copyright. You — not PagePocket — are responsible for what
            you archive and for what you share. Sharing a page publishes it to
            anyone with the link.
          </li>
          <li>
            Do not use the service for unlawful content, to attack the service,
            or to archive at a volume that degrades it for others.
          </li>
        </ul>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Shared links</h2>
        <p className="text-muted-foreground leading-relaxed">
          When you create a share link, anyone who has it can view that archived
          page until the link expires or you revoke it. Treat share links like
          the content they expose: don&rsquo;t share pages containing personal
          or confidential information unless you intend to.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">No warranty</h2>
        <p className="text-muted-foreground leading-relaxed">
          The service is provided &ldquo;as is&rdquo;, without warranties of any
          kind, express or implied — including fitness for a particular purpose
          and non-infringement. Archives can fail to capture a page perfectly,
          and stored data can be lost. Keep your own backups of anything you
          cannot afford to lose.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">
          Limitation of liability
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          To the maximum extent permitted by law, the PagePocket project and its
          maintainers are not liable for any indirect, incidental, or
          consequential damages arising from your use of — or inability to use —
          the service, including lost data or lost profits.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">
          Changes to these terms
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          We may update these terms as the service evolves. Changes are
          published on this page with a new &ldquo;last updated&rdquo; date.
          Continuing to use the service after a change means you accept the
          updated terms.
        </p>

        <h2 className="mt-10 mb-3 text-xl font-semibold">Governing terms</h2>
        <p className="text-muted-foreground leading-relaxed">
          PagePocket is developed in the open as an open-source project; these
          terms are the whole agreement between you and the project regarding
          the service. Nothing here takes away rights that mandatory consumer
          law in your country grants you. If you have a dispute, open an issue
          on the project&rsquo;s GitHub repository — we&rsquo;d rather fix
          problems in public than in court.
        </p>
      </div>
    </section>
  );
}
