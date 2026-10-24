import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { share } from "@/lib/api/share";
import { PublicViewerShell } from "@/components/app/public-viewer-shell";

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
    // revoked, or expired token) throws out of serverFetch and renders the
    // not-found state. The presigned `url` field is gone from the response
    // (design D4) — no URL-bearing payload is read here anymore. The
    // tolerant `content_formats` drives the share viewer's format switcher
    // (viewer parity, text-native-downloads D6); an older backend omits it
    // and the viewer degrades to the bare HTML iframe.
    const validated = await share.validatePublic(token);
    return (
      <PublicViewerShell token={token} formats={validated.content_formats} />
    );
  } catch {
    notFound();
  }
}
