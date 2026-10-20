import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket documentation — guides for saving pages, collections, search, and sharing";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Documentation",
    tagline:
      "Save, organize, search, and share — every workflow, step by step.",
  });
}
