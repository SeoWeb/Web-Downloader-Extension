import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;

// deploy pipeline probe (2026-10-02): exercises the deploy-frontend changes gate.
