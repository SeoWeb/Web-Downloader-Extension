import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // `server-only` is aliased inside Next builds (webpack-config.js); vitest
      // needs the same stand-in for server modules imported by route tests.
      "server-only": resolve(__dirname, "./src/test/server-only-stub.ts"),
    },
  },
});
