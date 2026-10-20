import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket vs the alternatives — honest, sourced comparisons with SingleFile, the Wayback Machine, and Perma.cc";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "PagePocket vs\nthe alternatives",
    tagline:
      "Honest, sourced comparisons — including when the other tool wins.",
  });
}
