import { ImageResponse } from "next/og";

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;
export const OG_IMAGE_SIZE = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };

/**
 * Shared Open Graph / Twitter card image design for the marketing site.
 *
 * Rendered through the `opengraph-image` / `twitter-image` file conventions
 * with `next/og` (Satori + Resvg). Satori supports only flexbox and inline
 * styles, so this component intentionally avoids Tailwind and CSS grid.
 *
 * Font: no `fonts` array and no `fontFamily` are set on purpose — `next/og`
 * bundles Geist Regular as its default font, so generation is offline-safe
 * and needs no network fetch. Only weight 400 exists, so hierarchy is built
 * with size and color instead of bold.
 *
 * Brand colors resolved from the oklch tokens in `src/app/globals.css`
 * to sRGB (Satori does not support oklch()):
 *   --primary     oklch(0.62 0.17 190) -> #00A49D
 *   --accent-warm oklch(0.72 0.18 50)  -> #FA7C20
 */

const TEAL = "#00A49D";
const ORANGE = "#FA7C20";

type MarketingOgImageProps = {
  /** Page headline. Use "\n" to force a line break. */
  headline: string;
  /** One-line value proposition under the headline. */
  tagline: string;
};

export function MarketingOgImage({ headline, tagline }: MarketingOgImageProps) {
  const headlineLines = headline.split("\n");

  return (
    <div
      style={{
        width: OG_IMAGE_WIDTH,
        height: OG_IMAGE_HEIGHT,
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(140deg, #0C2629 0%, #071619 52%, #050F11 100%)",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          position: "relative",
          padding: "60px 72px 48px",
        }}
      >
        {/* Soft teal glows */}
        <div
          style={{
            position: "absolute",
            width: 460,
            height: 460,
            borderRadius: 9999,
            background: "rgba(0, 164, 157, 0.07)",
            right: 40,
            top: -60,
          }}
        />
        <div
          style={{
            position: "absolute",
            width: 300,
            height: 300,
            borderRadius: 9999,
            background: "rgba(0, 164, 157, 0.05)",
            left: -110,
            bottom: -140,
          }}
        />

        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: TEAL,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Archive-box slot motif */}
            <div
              style={{
                width: 28,
                height: 8,
                borderRadius: 4,
                background: "rgba(4, 22, 25, 0.85)",
              }}
            />
          </div>
          <div
            style={{
              fontSize: 34,
              color: "#F2F8F8",
              marginLeft: 20,
              letterSpacing: -0.5,
            }}
          >
            PagePocket
          </div>
        </div>

        {/* Headline */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 68,
              height: 8,
              borderRadius: 4,
              background: ORANGE,
              marginBottom: 30,
            }}
          />
          {headlineLines.map((line) => (
            <div
              key={line}
              style={{
                fontSize: 76,
                color: "#F4FAFA",
                letterSpacing: -2,
                lineHeight: 1.12,
              }}
            >
              {line}
            </div>
          ))}
          <div
            style={{
              fontSize: 30,
              color: "#9DB6B8",
              lineHeight: 1.5,
              marginTop: 26,
              maxWidth: 640,
            }}
          >
            {tagline}
          </div>
        </div>

        {/* Archived-page card stack */}
        <div
          style={{
            position: "absolute",
            display: "flex",
            width: 380,
            height: 300,
            right: 64,
            top: 96,
          }}
        >
          <div
            style={{
              position: "absolute",
              width: 240,
              height: 156,
              borderRadius: 18,
              background: "rgba(255, 255, 255, 0.04)",
              border: "1px solid rgba(255, 255, 255, 0.10)",
              left: 140,
              top: 0,
            }}
          />
          <div
            style={{
              position: "absolute",
              width: 240,
              height: 156,
              borderRadius: 18,
              background: "rgba(255, 255, 255, 0.06)",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              left: 70,
              top: 54,
            }}
          />
          <div
            style={{
              position: "absolute",
              width: 250,
              height: 170,
              borderRadius: 18,
              background: "#0F3034",
              border: `2px solid rgba(0, 164, 157, 0.55)`,
              padding: 22,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              left: 0,
              top: 108,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 9999,
                  background: TEAL,
                }}
              />
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 9999,
                  background: "rgba(255, 255, 255, 0.18)",
                }}
              />
              <div
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 9999,
                  background: "rgba(255, 255, 255, 0.18)",
                }}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{
                  width: "82%",
                  height: 12,
                  borderRadius: 6,
                  background: "rgba(255, 255, 255, 0.22)",
                }}
              />
              <div
                style={{
                  width: "60%",
                  height: 12,
                  borderRadius: 6,
                  background: "rgba(255, 255, 255, 0.22)",
                }}
              />
              <div
                style={{
                  width: "40%",
                  height: 12,
                  borderRadius: 6,
                  background: ORANGE,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Footer strip */}
      <div
        style={{
          height: 76,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 72px",
          borderTop: "1px solid rgba(255, 255, 255, 0.14)",
        }}
      >
        <div style={{ fontSize: 24, color: "#7FA3A5" }}>pagepocket.app</div>
        <div style={{ fontSize: 24, color: "#7FA3A5" }}>
          Save · Search · Share
        </div>
      </div>
    </div>
  );
}

/** Renders the marketing OG design as an `ImageResponse` for the file conventions. */
export function renderMarketingOgImage(props: MarketingOgImageProps) {
  return new ImageResponse(<MarketingOgImage {...props} />, OG_IMAGE_SIZE);
}
