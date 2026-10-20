import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket — your private Wayback Machine: save full web pages, search them, and share them";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Your private\nWayback Machine",
    tagline: "Save full pages. Search everything. Share with a link.",
  });
}
