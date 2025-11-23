# Streaming Downloads System

This document describes the comprehensive streaming downloads system implemented for the WebsiteDownloader Chrome extension. The system enables efficient downloading of large files without loading entire resources into memory, reducing memory usage by up to 90% for large downloads.

## Overview

The streaming system addresses memory issues that occur when downloading large files (>50MB) by implementing:

- **Chunked Downloads**: Files are downloaded in configurable chunks (default: 1MB)
- **Progress Persistence**: Download progress is saved to IndexedDB for resume capability
- **Memory Management**: Intelligent memory pressure monitoring and cleanup
- **Offscreen Integration**: Optimized for Chrome's offscreen document API
- **ZIP Streaming**: Progressive ZIP creation without intermediate storage

## Architecture

### Core Components

#### 1. Streaming Types (`src/types/streaming.ts`)
Defines all interfaces and types for the streaming system:

```typescript
interface StreamingDownload {
  id: string;
  url: string;
  totalSize: number;
  downloadedSize: number;
  chunks: ChunkInfo[];
  status: StreamingDownloadStatus;
  // ... additional properties
}
```

#### 2. StreamingDownloader (`src/utils/StreamingDownloader.ts`)
Main class responsible for managing streaming downloads:

- **Chunk Management**: Divides files into optimal chunks based on size and memory constraints
- **Parallel Processing**: Downloads multiple chunks concurrently with configurable limits
- **Retry Logic**: Implements exponential backoff for failed chunks
- **Progress Tracking**: Real-time progress updates with detailed statistics
- **Memory Pressure**: Automatically adjusts download parameters based on available memory

#### 3. ChunkedZipProcessor (`src/utils/chunkedZip.ts`)
Handles memory-efficient ZIP creation:

- **Progressive Building**: Adds files to ZIP without loading everything into memory
- **Compression Control**: Configurable compression levels per file type
- **Stream Support**: Can create ZIPs as readable streams for very large files
- **Memory Limits**: Enforces maximum memory usage during ZIP creation

#### 4. ProgressPersistence (`src/utils/progressPersistence.ts`)
Manages download progress storage:

- **IndexedDB Storage**: Persistent storage across browser sessions
- **Resume Capability**: Downloads can be resumed after interruptions
- **Cleanup**: Automatic cleanup of old/failed downloads
- **Memory Mode**: In-memory persistence for temporary operations

#### 5. StreamingFetcher (`src/utils/streamingFetch.ts`)
Enhanced fetch utilities with streaming support:

- **Range Requests**: Utilizes HTTP range requests when available
- **Metadata Fetching**: Efficient file size detection without downloading content
- **Chunk Iterators**: Provides streaming access to file content
- **Fallback Support**: Graceful fallback for servers that don't support range requests

#### 6. Offscreen Integration (`src/offscreen/offscreen.ts`)
Optimized offscreen document operations:

- **Memory Monitoring**: Continuous memory usage tracking
- **URL Management**: Efficient blob URL lifecycle management
- **Cleanup**: Automatic resource cleanup on memory pressure
- **Streaming API**: Enhanced message passing for streaming operations

## Usage

### Basic Streaming Download

```typescript
import { StreamingDownloader, createProgressPersistence } from './utils';

// Initialize streaming downloader
const persistence = createProgressPersistence('indexeddb');
const downloader = new StreamingDownloader(persistence);

// Start a streaming download
const download = await downloader.startDownload('https://example.com/large-file.zip', {
  chunkSize: 1024 * 1024, // 1MB chunks
  maxParallelChunks: 3,
  enableResumption: true,
  enablePersistence: true,
});

// Monitor progress
const progress = downloader.getProgress(download.id);
console.log(`Progress: ${progress.progress * 100}%`);
```

### Chunked ZIP Creation

```typescript
import { ChunkedZipProcessor } from './utils/chunkedZip';

const processor = new ChunkedZipProcessor({
  progressive: true,
  maxMemoryUsage: 50 * 1024 * 1024, // 50MB limit
  compressionLevel: 6,
});

// Add files progressively
await processor.addEntry({
  path: 'large-file.pdf',
  data: largeFileBlob,
  compress: false, // Don't compress already compressed files
});

// Generate final ZIP
const zipBlob = await processor.generateZip();
```

### Integration with Existing Download System

```typescript
// In download.ts
import { downloadResourcesWithStreaming } from './background/download';

// Use streaming-enabled download for large files
await downloadResourcesWithStreaming(html, tabUrl, downloadOptions, sendMessage);
```

## Configuration

### Streaming Options

```typescript
interface StreamingOptions {
  chunkSize?: number;                    // Default: 1MB
  maxParallelChunks?: number;            // Default: 3
  maxRetries?: number;                   // Default: 3
  enableResumption?: boolean;            // Default: true
  enablePersistence?: boolean;           // Default: true
  chunkTimeout?: number;                 // Default: 30000ms
  enableChecksums?: boolean;             // Default: false
  forceStreaming?: boolean;              // Default: false
  streamingThreshold?: number;           // Default: 5MB
  monitorMemory?: boolean;               // Default: true
}
```

### Memory Management

The system automatically monitors memory usage and adjusts behavior:

- **Low Memory (< 60%)**: Normal operation
- **Medium Memory (60-75%)**: Reduced parallelism
- **High Memory (75-85%)**: Pauses downloads, performs cleanup
- **Critical Memory (> 85%)**: Emergency cleanup, pauses all streaming

### File Type Handling

Different file types are handled with optimal settings:

```typescript
// Images (already compressed): No compression, larger chunks
{
  chunkSize: 1024 * 1024, // 1MB
  compress: false,
  maxParallelChunks: 3,
}

// Text files: High compression, smaller chunks
{
  chunkSize: 256 * 1024, // 256KB
  compress: true,
  compressionLevel: 6,
  maxParallelChunks: 2,
}

// Archives: No compression, medium chunks
{
  chunkSize: 512 * 1024, // 512KB
  compress: false,
  maxParallelChunks: 2,
}
```

## Performance Benefits

### Memory Usage

- **Traditional Download**: Loads entire file into memory
  - 100MB file = ~100MB + overhead = ~120MB memory usage
- **Streaming Download**: Constant memory usage regardless of file size
  - 100MB file = ~5MB memory usage (configurable chunk size)
  - 1GB file = ~5MB memory usage

### Download Speed

- **Parallel Chunks**: Multiple chunks downloaded simultaneously
- **Range Requests**: Supports partial content requests
- **Retry Logic**: Intelligent retry with exponential backoff
- **Resume Capability**: No re-downloading of completed chunks

### Error Recovery

- **Chunk-Level Retry**: Failed chunks are re-downloaded independently
- **Network Interruption**: Downloads can be resumed after network loss
- **Memory Pressure**: Automatic pausing and resumption based on available memory
- **Graceful Degradation**: Falls back to traditional download for incompatible servers

## Testing

### Running Tests

```typescript
import { runStreamingTests } from './utils/streamingTest';

// Run comprehensive test suite
const report = await runStreamingTests();
console.log(report);
```

### Test Coverage

The test suite includes:

1. **Basic Streaming Download**: Verifies chunked downloading works
2. **Chunked ZIP Processing**: Tests memory-efficient ZIP creation
3. **Memory Pressure Handling**: Validates memory management
4. **Progress Persistence**: Tests save/load functionality
5. **Large File Handling**: Verifies large file downloads
6. **Concurrent Downloads**: Tests multiple simultaneous downloads
7. **Download Resumption**: Validates pause/resume functionality
8. **Error Handling**: Tests failure scenarios and recovery
9. **Memory Efficiency**: Compares streaming vs traditional memory usage
10. **Integration Tests**: Verifies integration with existing system

## Monitoring and Debugging

### Memory Monitoring

```typescript
// Get current memory usage
const memoryStats = memoryManager.getMemoryStats();
console.log(`Memory usage: ${memoryStats.totalMemoryUsed} bytes`);
console.log(`Pressure level: ${memoryStats.memoryPressureLevel}`);
```

### Download Progress

```typescript
// Monitor download progress
const progress = downloader.getProgress(downloadId);
console.log({
  completedChunks: progress.completedChunks,
  totalChunks: progress.totalChunks,
  bytesDownloaded: progress.bytesDownloaded,
  totalBytes: progress.totalBytes,
  downloadSpeed: progress.downloadSpeed,
  eta: progress.eta,
});
```

### Debug Logging

Enable debug logging by setting the log level:

```typescript
// In console
localStorage.setItem('debug', 'streaming:*');

// Or in code
if (process.env.NODE_ENV === 'development') {
  localStorage.setItem('debug', 'streaming:*');
}
```

## Browser Compatibility

### Required Features

- **IndexedDB**: For progress persistence
- **Fetch API**: With streaming support
- **Blob API**: For handling binary data
- **Offscreen API**: For large file downloads in service workers
- **SharedArrayBuffer**: For efficient memory management (optional)

### Fallback Support

The system gracefully degrades when features are unavailable:

- **No IndexedDB**: Uses in-memory persistence (no resume capability)
- **No Range Requests**: Falls back to traditional download
- **No Offscreen API**: Uses data URLs for smaller files, rejects larger files
- **Low Memory**: Automatically adjusts chunk sizes and parallelism

## Best Practices

### For Developers

1. **Use Streaming for Large Files**: Automatically detect and stream files >5MB
2. **Monitor Memory Usage**: Track memory statistics during development
3. **Test with Various File Types**: Different file types benefit from different settings
4. **Handle Failures Gracefully**: Implement proper error handling and user feedback
5. **Clean Up Resources**: Ensure proper cleanup of downloads and blob URLs

### For Users

1. **Monitor Progress**: The UI shows real-time download progress
2. **Pause Large Downloads**: Users can pause/resume large downloads
3. **Check Memory Usage**: Extension monitors and manages memory automatically
4. **Resume After Interruption**: Downloads can be resumed after browser restart

## Troubleshooting

### Common Issues

1. **Downloads Not Starting**
   - Check if offscreen permission is granted
   - Verify network connectivity
   - Check memory availability

2. **High Memory Usage**
   - Reduce `maxParallelChunks` setting
   - Decrease `chunkSize`
   - Enable memory monitoring

3. **Slow Downloads**
   - Increase `maxParallelChunks` if network allows
   - Check if server supports range requests
   - Verify chunk size is appropriate for file type

4. **Resume Not Working**
   - Ensure IndexedDB is available
   - Check `enablePersistence` setting
   - Verify download IDs are consistent

### Debug Information

Enable debug mode to get detailed information:

```typescript
// Enable debug logging
localStorage.setItem('debug', 'streaming:*');

// Get system statistics
const stats = {
  memory: memoryManager.getMemoryStats(),
  activeDownloads: streamingDownloader.getActiveDownloads(),
  persistence: await persistence.listPersistedDownloads(),
};
```

## Future Enhancements

### Planned Features

1. **WebWorker Support**: Move streaming processing to Web Workers
2. **Adaptive Chunk Sizes**: Dynamic chunk sizing based on network conditions
3. **P2P Downloads**: Peer-to-peer chunk sharing for multiple downloads
4. **Compression Streaming**: Stream compression during download
5. **Cloud Storage Integration**: Direct streaming to cloud storage
6. **Bandwidth Limiting**: Configurable download speed limits

### Performance Optimizations

1. **Caching**: Intelligent caching of downloaded chunks
2. **Predictive Preloading**: Preload likely-to-be-requested chunks
3. **Network-Aware Scheduling**: Optimize downloads based on network conditions
4. **Compression Optimization**: Better compression strategies for different file types

---

## File Structure

```
src/
├── types/
│   └── streaming.ts              # Type definitions
├── utils/
│   ├── StreamingDownloader.ts    # Main streaming downloader
│   ├── chunkedZip.ts            # ZIP processing utilities
│   ├── progressPersistence.ts    # Progress storage
│   ├── streamingFetch.ts         # Enhanced fetch utilities
│   └── streamingTest.ts          # Test suite
├── background/
│   ├── download.ts              # Integration with main download
│   └── fileHandlers.ts          # Streaming-aware file handlers
└── offscreen/
    └── offscreen.ts             # Offscreen document optimization
```

This streaming system provides a robust, memory-efficient solution for downloading large files while maintaining compatibility with the existing codebase and providing a smooth user experience.