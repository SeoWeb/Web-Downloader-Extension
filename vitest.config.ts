import { defineConfig } from "vitest/config";

// The browser extension lives at the repo root; the Next.js frontend under
// pagepocket/frontend has its own vitest setup and its own CI job.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup.cjs"],
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "pagepocket/**", "dist/**"],
  },
  define: {
    // Mirrors tests/vite-env-transform.cjs from the legacy jest setup.
    "import.meta.env.VITE_SERVER_URL": JSON.stringify(
      "https://test-server.example.com",
    ),
  },
});
