# Website Downloader Extension

Chrome extension for downloading complete websites with all assets, supporting large downloads via IndexedDB storage.

## Features

- Download complete websites with HTML, CSS, JS, images, and documents
- **IndexedDB Storage Mode**: Handle unlimited site sizes without memory limits
- Multi-part ZIP downloads for large sites (>100MB)
- Full page scraping with linked pages support
- Single-file HTML export option
- Progress tracking and pause/resume support
- Automatic cleanup of old downloads

## Storage Modes

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
```

## Troubleshooting

See [docs/troubleshooting.md](docs/troubleshooting.md) for common issues and solutions.

## Technical Details

- Built with React, TypeScript, and Vite
- Uses Dexie for IndexedDB management
- Tailwind CSS for styling
- Automatic storage quota monitoring
- 24-hour automatic cleanup of old downloads
