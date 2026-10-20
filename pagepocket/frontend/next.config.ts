import type { NextConfig } from "next";
import createMDX from "@next/mdx";

// Shell security headers (pagepocket-frontend-shell). Deliberately scoped to
// NON-API paths: the /api/pp and /api/sc route handlers set their own sandbox
// Content-Security-Policy on archived content, and next.config headers would
// clobber a route handler's CSP on the same response.
const SHELL_SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  // MDX content engine (design D6): content/blog/*.mdx and content/docs/*.mdx
  // are imported as RSC components (no file-based MDX routes today, but the
  // extension must be listed for `@next/mdx` to compile imports at all).
  pageExtensions: ["js", "jsx", "ts", "tsx", "mdx"],
  turbopack: {
    root: import.meta.dirname,
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Everything except /api/* (negative lookahead on the first segment).
        source: "/((?!api/).*)",
        headers: SHELL_SECURITY_HEADERS,
      },
    ];
  },
};

// MDX compilation for both bundlers (webpack dev / Turbopack build). No
// remark/rehype plugins: content stays plain markdown + exported meta.
const withMDX = createMDX({});

export default withMDX(nextConfig);

// deploy pipeline probe (2026-10-02, rev 3): exercises the deploy-frontend gate.

// deploy-day rollout marker (2026-10-16): frontend path — atomic pair with the backend marker

// atomicity marker: see scripts/prod/README.md §4 — frontend paths must ship with backend paths
// atomicity marker (2): mysql-readiness fix ships together with the frontend
