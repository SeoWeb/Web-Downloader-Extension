import {
  OG_IMAGE_SIZE,
  renderMarketingOgImage,
} from "@/components/marketing/og-image";
import { getPersona } from "../personas";

const persona = getPersona("researchers");

export const alt = `PagePocket for researchers — ${persona.tagline}`;
export const size = OG_IMAGE_SIZE;
export const contentType = "image/png";

export default function Image() {
  return renderMarketingOgImage({
    // persona.heroTitle (the page H1), line-broken for the 76px OG canvas.
    headline: "Save web pages\nfor research",
    tagline: persona.tagline,
  });
}
