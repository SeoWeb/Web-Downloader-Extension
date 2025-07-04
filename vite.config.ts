import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react-swc";
import { viteZip } from "vite-plugin-zip-file";
import tailwindcss from "@tailwindcss/vite";

import manifest from "./public/manifest.json";
const version = manifest.version;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteZip({
      folderPath: resolve(__dirname, "dist"),
      outPath: resolve(__dirname, "zip"),
      zipName: "web-page-downloader" + version + ".zip",
      enabled: true,
    }),
  ],
  build: {
    rollupOptions: {
      input: {
        sidePanel: resolve(__dirname, "sidePanel.html"),
        featureRequest: resolve(__dirname, "featureRequest.html"),
        background: resolve(__dirname, "background.js"),
      },
      output: {
        chunkFileNames: (chunkInfo) => {
          const name = chunkInfo.name || 'chunk';
          // Ensure chunk names don't start with underscore
          const safeName = name.startsWith('_') ? name.substring(1) : name;
          return `${safeName}.[hash].js`;
        },
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || 'asset';
          // Ensure asset names don't start with underscore
          const safeName = name.startsWith('_') ? name.substring(1) : name;
          return `${safeName}.[hash].[ext]`;
        },
        entryFileNames: "[name].js",
        dir: "dist",
      },
    },
  },
});
