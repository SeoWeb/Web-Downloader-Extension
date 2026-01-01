import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { writeFileSync, readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import JSZip from "jszip";

import manifest from "./public/manifest.json";
const version = manifest.version;

// Custom plugin to zip dist contents
function zipDistContents() {
  return {
    name: 'zip-dist-contents',
    writeBundle() {
      const distPath = resolve(__dirname, "dist");
      const zipPath = resolve(__dirname, "zip");
      const zipName = `web-page-downloader${version}.zip`;
      
      const zip = new JSZip();
      
      function addFilesToZip(dirPath: string, zipFolder: JSZip) {
        const items = readdirSync(dirPath);
        
        for (const item of items) {
          const itemPath = join(dirPath, item);
          const stat = statSync(itemPath);
          
          if (stat.isDirectory()) {
            const folder = zipFolder.folder(item);
            if (folder) {
              addFilesToZip(itemPath, folder);
            }
          } else {
            const content = readFileSync(itemPath);
            zipFolder.file(item, content);
          }
        }
      }
      
      addFilesToZip(distPath, zip);
      
      zip.generateAsync({ type: "nodebuffer" }).then((content) => {
        // Ensure zip directory exists
        try {
          readdirSync(zipPath);
        } catch {
          require("fs").mkdirSync(zipPath, { recursive: true });
        }
        
        writeFileSync(join(zipPath, zipName), content);
        console.log(`✅ Created ${zipName} with dist contents`);
      });
    }
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    zipDistContents(),
  ],
  build: {
    rollupOptions: {
      input: {
        sidePanel: resolve(__dirname, "sidePanel.html"),

        background: resolve(__dirname, "background.js"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
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
        manualChunks: (id) => {
          // Split large dependencies into separate chunks for better caching
          if (id.includes('node_modules')) {
            // React core
            if (id.includes('react') || id.includes('react-dom')) {
              return 'vendor-react';
            }
            // i18n libraries
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'vendor-i18n';
            }
            // JSZip for file compression
            if (id.includes('jszip')) {
              return 'vendor-zip';
            }
            // HTML parsers
            if (id.includes('cheerio') || id.includes('linkedom')) {
              return 'vendor-parser';
            }
            // Radix UI components
            if (id.includes('@radix-ui')) {
              return 'vendor-ui';
            }
            // Lucide icons
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            // All other node_modules
            return 'vendor';
          }
          // Locale files - each language gets its own chunk
          if (id.includes('/i18n/locales/')) {
            const match = id.match(/locales\/([^.]+)\.json/);
            if (match) {
              return `locale-${match[1]}`;
            }
          }
        },
      },
    },
  },
});
