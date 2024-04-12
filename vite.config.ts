import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react-swc";
import { viteZip } from "vite-plugin-zip-file";

import manifest from "./public/manifest.json";
const version = manifest.version;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
        popup: resolve(__dirname, "popup.html"),
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
