import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { share } from "@/lib/api/share";
import { NotFoundError } from "@/lib/api/errors";
import { PublicViewerShell } from "@/components/app/public-viewer-shell";
import { ViewerLoadError } from "@/components/app/viewer-load-error";

type Props = {
  params: Promise<{ token: string }>;
};

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SharedPagePage({ params }: Props) {
  const { token } = await params;

  try {
    // Validity signal is the gateway's status contract: a 404 (invalid,
    // revoked, or expired token) throws NotFoundError out of serverFetch and
    // renders the not-found state. The presigned `url` field is gone from
    // the response (design D4) — no URL-bearing payload is read here
    // anymore. The tolerant `content_formats` drives the share viewer's
    // format switcher (viewer parity, text-native-downloads D6) and the
    // tolerant `pages` manifest its subpage sidebar (multipage D8); an older
    // backend omits them and the viewer degrades to the bare HTML iframe.
    const validated = await share.validatePublic(token);
    return (
      <PublicViewerShell
        token={token}
        formats={validated.content_formats}
        pages={validated.pages}
      />
    );
  } catch (error) {
    // Failure split (multipage-download-fixes 8.4): a true 404 keeps the
    // not-found state; transient failures (network, gateway, 5xx) render a
    // retryable error state instead.
    if (error instanceof NotFoundError) {
      notFound();
    }
    return <ViewerLoadError />;
  }
}
