import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket features — full-page saves, a clean reader, collections, full-text search, and share links";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Features",
    tagline:
      "Full-page saves, a clean reader, collections, full-text search, and share links.",
  });
}
