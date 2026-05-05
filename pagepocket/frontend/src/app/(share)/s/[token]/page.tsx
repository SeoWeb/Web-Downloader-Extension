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

  let data;
  try {
    data = await share.validatePublic(token);
  } catch {
    notFound();
  }

  return <PublicViewerShell url={data!.url} expiresAt={data!.expires_at} />;
}
