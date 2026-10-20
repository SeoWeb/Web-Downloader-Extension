import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "Terms of Service — accounts, acceptable use, sharing, and liability on PagePocket";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Terms of Service",
    tagline: "PagePocket — your private Wayback Machine.",
  });
}
