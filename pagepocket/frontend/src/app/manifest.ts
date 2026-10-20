import type { MetadataRoute } from "next";

/**
 * theme_color mirrors the `--primary` teal token, oklch(0.62 0.17 190),
 * converted to sRGB — manifests need plain #rrggbb strings (oklch() is not
 * reliably parsed in manifest consumers).
 */
const THEME_COLOR = "#00a49d";
/** --background (light), oklch(0.99 0.003 190) → sRGB. */
const BACKGROUND_COLOR = "#fafcfc";

/** Icon set copied from the extension's public/icons (16–256). */
const ICON_SIZES = [16, 32, 48, 64, 96, 128, 256] as const;

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "PagePocket — Your private Wayback Machine",
    short_name: "PagePocket",
    description:
      "Your private Wayback Machine. Save full-fidelity copies of any web page to a private, searchable library and share them with a simple link.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    icons: ICON_SIZES.map((size) => ({
      src: `/icons/${size}x${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
  };
}
