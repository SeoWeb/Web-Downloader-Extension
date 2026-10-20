import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";

export const alt =
  "PagePocket pricing — free to start, Pro at $2/mo billed yearly";
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    headline: "Pricing",
    tagline: "Free to start. Pro is $2/mo — billed yearly at $24.",
  });
}
