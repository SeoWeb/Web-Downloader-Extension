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
        background: resolve(__dirname, "background.js"),
      },
      output: {
        chunkFileNames: "[name].[hash].js",
        assetFileNames: "[name].[hash].[ext]",
        entryFileNames: "[name].js",
        dir: "dist",
      },
    },
  },
});
