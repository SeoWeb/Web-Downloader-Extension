import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";
import { comparePages } from "../comparisons";

const page = comparePages.singlefile;

export const alt = `${page.heroTitle} — local-only saving vs a private, searchable cloud archive`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    // page.heroTitle (the page H1), line-broken for the 76px OG canvas.
    headline: "PagePocket vs\nSingleFile",
    tagline: "Local-only saving vs a private, searchable cloud archive.",
  });
}
