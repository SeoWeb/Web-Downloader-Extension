import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "Privacy Policy — what PagePocket collects, where your archives are stored, and how to get your data deleted";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Privacy Policy",
    tagline: "PagePocket — your private Wayback Machine.",
  });
}
