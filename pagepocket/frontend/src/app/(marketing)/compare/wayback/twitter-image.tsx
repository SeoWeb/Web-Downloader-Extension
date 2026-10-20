import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";
import { comparePages } from "../comparisons";

const page = comparePages.wayback;

export const alt = `${page.heroTitle} — a free public archive for everyone vs a private archive for you`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    // page.heroTitle (the page H1), line-broken for the 76px OG canvas.
    headline: "PagePocket vs\nthe Wayback\nMachine",
    tagline: "A free public archive for everyone vs a private archive for you.",
  });
}
