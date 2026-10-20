import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket use cases — how researchers, journalists, developers, and archivists save and revisit web pages";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Use cases",
    tagline:
      "How researchers, journalists, developers, and archivists use PagePocket.",
  });
}
