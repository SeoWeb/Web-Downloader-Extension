import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";
import { comparePages } from "../comparisons";

const page = comparePages["perma-cc"];

export const alt = `${page.heroTitle} — permanent citation records vs a private, searchable research archive`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    // page.heroTitle (the page H1), line-broken for the 76px OG canvas.
    headline: "PagePocket vs\nPerma.cc",
    tagline:
      "Permanent citation records vs a private, searchable research archive.",
  });
}
