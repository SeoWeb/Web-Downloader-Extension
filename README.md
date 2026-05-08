# Website Downloader Extension

Chrome extension for downloading complete websites with all assets, supporting large downloads via IndexedDB storage.

## Features

- Download complete websites with HTML, CSS, JS, images, and documents
- **PagePocket Cloud Storage**: Save pages directly to your PagePocket account (no local file)
- **IndexedDB Storage Mode**: Handle unlimited site sizes without memory limits
- Multi-part ZIP downloads for large sites (>100MB)
- Full page scraping with linked pages support
- Single-file HTML export option
- Progress tracking and pause/resume support
- Automatic cleanup of old downloads
- i18n support with multiple languages

## Storage Modes

### PagePocket Cloud Storage (Optional)
- Uploads pages directly to your PagePocket account
- No local file saved — cloud-only storage
- Requires a PagePocket backend and user account (JWT auth)
- Enabled at build time via `VITE_PAGEPOCKET_URL` env var
- Users toggle cloud storage ON/OFF per session via the extension UI
- Shows upload progress, completion status, and "View in PagePocket" link

### IndexedDB (Default - Recommended)
- Stores content on disk instead of RAM
- Handles unlimited site sizes
- Slightly slower but much more reliable
- Automatically enabled for all downloads
- Multi-part ZIP support for files >100MB

### Legacy JSZip Mode
- Stores all content in RAM
- Fast for small sites (<100MB)
- May fail on large sites due to memory limits
- Can be enabled by setting `USE_INDEXEDDB = false` in `download-core.ts`

## Development

```bash
# Install dependencies
npm install

# Development mode
npm run dev

# Build for production
npm run build

# Build with PagePocket cloud storage support
VITE_PAGEPOCKET_URL=https://your-pagepocket-instance.example.com npm run build
```

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues and solutions.

## Technical Details

- Built with React, TypeScript, and Vite
- Uses Dexie for IndexedDB management
- Zustand for state management
- Tailwind CSS for styling
- Radix UI primitives for accessible components
- Automatic storage quota monitoring
- 24-hour automatic cleanup of old downloads
- Chrome Extension Manifest V3
