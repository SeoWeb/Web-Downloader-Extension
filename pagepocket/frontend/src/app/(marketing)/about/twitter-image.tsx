import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "About PagePocket — your private Wayback Machine, open source and honest";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "About PagePocket",
    tagline: "Your private Wayback Machine — open source, honest, $2/mo.",
  });
}
