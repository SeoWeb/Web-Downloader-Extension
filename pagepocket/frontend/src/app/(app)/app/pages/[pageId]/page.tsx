import { notFound } from "next/navigation";
import { archive } from "@/lib/api/archive";
import { PageViewerShell } from "@/components/app/page-viewer-shell";
import { ViewerLoadError } from "@/components/app/viewer-load-error";

type Props = {
  params: Promise<{ pageId: string }>;
};

export default async function ViewPagePage({ params }: Props) {
  const { pageId } = await params;

  // Failure split (multipage-download-fixes 8.4): null means a true 404
  // (page absent or not owned) → notFound() unchanged; any other failure
  // (network, gateway, 5xx) throws out of getPage → retryable error state
  // instead of a dead-end "Page not found".
  let pageMeta;
  try {
    pageMeta = await archive.getPage(pageId);
  } catch {
    return <ViewerLoadError />;
  }
  if (!pageMeta) {
    notFound();
  }

  return <PageViewerShell pageId={pageId} pageMeta={pageMeta} />;
}
