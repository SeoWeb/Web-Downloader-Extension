import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";
import {
  getPost,
  getPostSlugs,
  truncateOgTagline,
  wrapOgTitle,
} from "@/lib/blog";

/** Per-post generated OG image (spec: title-aware, never a shared placeholder). */
export const dynamicParams = false;

export function generateStaticParams() {
  return getPostSlugs().map((slug) => ({ slug }));
}

export const alt =
  "Cover image for a PagePocket blog article on saving web pages";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const post = await getPost(slug);

  return renderMarketingOgImage({
    headline: wrapOgTitle(post?.title ?? "PagePocket"),
    tagline: truncateOgTagline(post?.description ?? ""),
  });
}
