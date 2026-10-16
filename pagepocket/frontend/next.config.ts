import type { NextConfig } from "next";

// Shell security headers (pagepocket-frontend-shell). Deliberately scoped to
// NON-API paths: the /api/pp and /api/sc route handlers set their own sandbox
// Content-Security-Policy on archived content, and next.config headers would
// clobber a route handler's CSP on the same response.
const SHELL_SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
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

export default nextConfig;

// deploy pipeline probe (2026-10-02, rev 3): exercises the deploy-frontend gate.

// deploy-day rollout marker (2026-10-16): frontend path — atomic pair with the backend marker

// atomicity marker: see scripts/prod/README.md §4 — frontend paths must ship with backend paths
// atomicity marker (2): mysql-readiness fix ships together with the frontend
