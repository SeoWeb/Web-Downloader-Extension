/**
 * Dedicated Vite config for the download-pipeline E2E test.
 *
 * Mirrors the project vite.config.ts (same inputs, plugins, chunking) but:
 *  - writes to dist-e2e/ (never touches dist/, which other flows may use),
 *  - does NOT run zipDistContents (no zip side effects, no dist/ reads),
 *  - copies src/i18n/locales into dist-e2e/locales (the background i18n
 *    backend fetches chrome.runtime.getURL(`locales/<lang>.json`)).
 *
 * VITE_SERVER_URL is read from the environment exactly like the normal
 * build (baked into the bundle via import.meta.env).
 */
import { defineConfig } from "vite";
import { resolve, dirname, join } from "path";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function copyLocaleFilesE2E() {
  return {
    name: "copy-locale-files-e2e",
    writeBundle() {
      const source = resolve(ROOT, "src/i18n/locales");
      const dest = resolve(ROOT, "dist-e2e/locales");
      if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(source)) {
        if (file.endsWith(".json")) {
          writeFileSync(join(dest, file), readFileSync(join(source, file)));
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyLocaleFilesE2E()],
  resolve: {
    alias: {
      "linkedom/commonjs/canvas.cjs": resolve(ROOT, "src/utils/canvas-shim.cjs"),
    },
  },
  build: {
    outDir: "dist-e2e",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidePanel: resolve(ROOT, "sidePanel.html"),
        background: resolve(ROOT, "background.js"),
        welcome: resolve(ROOT, "welcome.html"),
      },
      output: {
        chunkFileNames: (chunkInfo) => {
          const name = chunkInfo.name || "chunk";
          const safeName = name.startsWith("_") ? name.substring(1) : name;
          return `${safeName}.[hash].js`;
        },
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || "asset";
          const safeName = name.startsWith("_") ? name.substring(1) : name;
          return `${safeName}.[hash].[ext]`;
        },
        entryFileNames: "[name].js",
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("react-dom") || id.includes("scheduler")) {
              return "vendor-react";
            }
            if (id.includes("i18next") || id.includes("react-i18next")) {
              return "vendor-i18n";
            }
            if (id.includes("jszip")) return "vendor-zip";
            if (id.includes("cheerio") || id.includes("linkedom")) return "vendor-parser";
            if (id.includes("@radix-ui")) return "vendor-ui";
            if (id.includes("lucide-react")) return "vendor-icons";
            return "vendor";
          }
          if (id.includes("/i18n/locales/")) {
            const match = id.match(/locales\/([^.]+)\.json/);
            if (match) return `locale-${match[1]}`;
          }
        },
      },
    },
  },
});
