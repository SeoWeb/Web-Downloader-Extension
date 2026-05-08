import { notFound } from "next/navigation";
import { archive } from "@/lib/api/archive";
import { PageViewerShell } from "@/components/app/page-viewer-shell";

type Props = {
  params: Promise<{ pageId: string }>;
};

export default async function ViewPagePage({ params }: Props) {
  const { pageId } = await params;

  const pageMeta = await archive.getPage(pageId).catch(() => null);
  if (!pageMeta) {
    notFound();
  }

  return (
    <PageViewerShell
      pageId={pageId}
      pageMeta={pageMeta}
    />
  );
}
