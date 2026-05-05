import { notFound } from "next/navigation";
import { archive } from "@/lib/api/archive";
import { PageViewerShell } from "@/components/app/page-viewer-shell";

type Props = {
  params: Promise<{ pageId: string }>;
};

export default async function ViewPagePage({ params }: Props) {
  const { pageId } = await params;

  let viewer;
  try {
    viewer = await archive.viewPage(pageId);
  } catch (e) {
    if (e instanceof Error && e.name === "NotFoundError") {
      notFound();
    }
    throw e;
  }

  const pageMeta = await archive.getPage(pageId).catch(() => null);

  return (
    <PageViewerShell
      initialViewer={viewer}
      pageId={pageId}
      pageMeta={pageMeta}
    />
  );
}
