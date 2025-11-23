# Request Throttling and Queue Management System

This document describes the intelligent request throttling and queue management system implemented for the WebsiteDownloader Chrome extension.

## Overview

The queue system prevents overwhelming the browser and remote servers while optimizing download performance through:

- **Request Prioritization**: Critical resources (HTML) download first, followed by CSS, JS, then images
- **Domain-Specific Rate Limiting**: Respects robots.txt crawl delays and prevents server overload
- **Adaptive Concurrency**: Adjusts concurrent requests based on memory pressure and network conditions
- **Memory Pressure Detection**: Monitors memory usage and reduces concurrency when needed
- **Request Deduplication**: Prevents duplicate downloads of the same resource
- **Exponential Backoff**: Implements intelligent retry logic for failed requests

## Architecture

### Core Components

#### 1. Type Definitions (`src/types/queue.ts`)
- `RequestPriority`: CRITICAL, HIGH, NORMAL, LOW
- `ResourceType`: HTML, CSS, JS, IMAGE, VIDEO, AUDIO, DOCUMENT, FONT, OTHER
- `QueuedRequest`: Complete request definition with metadata
- `RequestResult`: Response wrapper with timing and metadata
- `QueueStats`: Real-time queue statistics

#### 2. Domain Limiter (`src/utils/DomainLimiter.ts`)
- Per-domain request rate limiting
- Robots.txt crawl delay respect
- Connection pooling
- Adaptive rate adjustment based on server responses
- Factory pattern for managing multiple domain limiters

#### 3. Request Scheduler (`src/utils/RequestScheduler.ts`)
- Priority-based request scheduling
- Dependency resolution
- Queue state management
- Event-driven architecture with callbacks
- Real-time statistics

#### 4. Throttling Manager (`src/utils/ThrottlingManager.ts`)
- Adaptive concurrency based on memory and network conditions
- Request deduplication
- Network condition monitoring
- Memory pressure detection and response

#### 5. Request Queue (`src/utils/RequestQueue.ts`)
- Main queue implementation coordinating all components
- Unified interface for enqueuing requests
- Request execution with proper error handling
- Statistics and monitoring

## Integration Points

### File Handlers (`src/background/fileHandlers.ts`)
All resource download functions now use the queue system:
- `addCssFiles()`: HIGH priority for CSS
- `addJsFiles()`: NORMAL priority for JavaScript
- `addImageFiles()`: LOW priority for images
- `addDocumentFiles()`: NORMAL priority for documents
- `addHtmlFiles()`: CRITICAL priority for HTML

### Download Orchestrator (`src/background/download.ts`)
- Queue initialization and event listener setup
- Memory pressure integration
- Queue cleanup on download completion
- Statistics logging

### URL Utilities (`src/background/urlUtils.ts`)
- New `fetchUrlWithQueue()` function for queue-aware fetching
- Automatic resource type detection
- Integration with existing fetch functionality
- Error handling and retry logic

## Usage Examples

### Basic Queue Usage
```typescript
import { requestQueue } from '../utils/RequestQueue';
import { RequestPriority, ResourceType } from '../types/queue';

const requestId = await requestQueue.enqueue({
  url: 'https://example.com/resource.css',
  resourceType: ResourceType.CSS,
  priority: RequestPriority.HIGH,
  domain: '', // Auto-extracted
  dependencies: [],
  retryCount: 0,
  estimatedSize: 0,
  fetchOptions: {
    headers: { 'Accept': 'text/css,*/*;q=0.1' }
  },
  onComplete: (result) => {
    console.log('Download completed:', result.response);
  },
  onError: (error) => {
    console.error('Download failed:', error);
  }
});
```

### Queue-Aware Fetching
```typescript
import { fetchUrlWithQueue } from '../background/urlUtils';

const response = await fetchUrlWithQueue(
  'https://example.com/image.jpg',
  'https://example.com',
  {
    priority: RequestPriority.LOW,
    resourceType: ResourceType.IMAGE,
    fetchOptions: {
      headers: { 'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8' }
    },
    onComplete: (result) => {
      // Handle successful download
    },
    onError: (error) => {
      // Handle error
    }
  }
);
```

## Configuration

### Default Concurrency Limits
- **Normal conditions**: 6 concurrent requests
- **High memory pressure**: 3 concurrent requests
- **Critical memory pressure**: 1 concurrent request
- **Low memory pressure**: Up to 12 concurrent requests

### Domain Rate Limiting
- **Default delay**: 1000ms between requests to same domain
- **Robots.txt respect**: Uses crawl-delay if specified
- **Adaptive adjustment**: Increases delay on 429/503 responses
- **Connection pooling**: Reuses connections when possible

### Retry Logic
- **Max retries**: 3 attempts by default
- **Backoff strategy**: Exponential (1s, 2s, 4s)
- **Retry conditions**: Network errors, 5xx responses, timeouts
- **Retry limits**: Per-request retry counter with maximum

## Monitoring and Debugging

### Queue Statistics
```typescript
const stats = requestQueue.getStats();
console.log('Queue stats:', {
  queued: stats.queued,
  active: stats.active,
  completed: stats.completed,
  failed: stats.failed,
  adaptiveConcurrency: stats.adaptiveConcurrency,
  memoryPressureLevel: stats.memoryPressureLevel,
  networkQuality: stats.networkQuality,
  processingRate: stats.processingRate
});
```

### Event Listeners
```typescript
requestQueue.setEventListeners({
  onStart: (request) => console.log('Started:', request.url),
  onComplete: (result) => console.log('Completed:', result.requestId),
  onError: (request, error) => console.error('Failed:', request.url, error),
  onRetry: (request, attempt) => console.log('Retrying:', request.url, attempt)
});
```

## Testing

### Unit Tests
Run `window.queueTest.runAllTests()` in browser console to execute unit tests:
- Basic enqueue functionality
- Priority ordering
- Domain limiting
- Retry mechanism
- Memory pressure handling
- Queue statistics

### Integration Tests
Run `window.integrationTest.runAllTests()` in browser console to execute integration tests:
- Queue with file handlers
- Queue with URL utilities
- Memory management integration
- Error handling

## Performance Benefits

### Memory Management
- **Reduced memory spikes**: Controlled concurrency prevents memory overload
- **Automatic cleanup**: Queue clears completed requests
- **Pressure detection**: Proactive memory management
- **Adaptive limits**: Dynamic adjustment based on available memory

### Network Efficiency
- **Domain respect**: Prevents server overload
- **Priority ordering**: Critical resources download first
- **Connection reuse**: Efficient network utilization
- **Intelligent retries**: Reduces failed request overhead

### User Experience
- **Faster perceived loading**: Priority-based resource loading
- **Fewer failures**: Better error handling and retries
- **Stable downloads**: Memory pressure prevention
- **Progress feedback**: Real-time queue statistics

## Migration Notes

The queue system is designed to be a drop-in replacement for the existing semaphore-based concurrency control:

1. **File Handlers**: Updated to use `requestQueue.enqueue()` instead of manual semaphore management
2. **URL Utils**: New `fetchUrlWithQueue()` function for queue-aware fetching
3. **Download Orchestrator**: Queue initialization and cleanup integration
4. **Memory Manager**: Queue pressure callbacks for adaptive concurrency

The existing `fetchUrl()` function remains unchanged for backward compatibility, while new code should prefer `fetchUrlWithQueue()` for optimal performance.

## Future Enhancements

Potential improvements to the queue system:

1. **Persistent Queue**: Save queue state across service worker restarts
2. **Advanced Scheduling**: Time-based request scheduling
3. **Bandwidth Detection**: Adaptive concurrency based on available bandwidth
4. **Cache Integration**: Intelligent cache hit/miss handling
5. **Predictive Preloading**: Anticipatory resource loading

## Troubleshooting

### Common Issues

1. **Requests not processing**: Check if queue is paused due to memory pressure
2. **Slow downloads**: Verify domain rate limiting isn't too restrictive
3. **Memory leaks**: Ensure queue cleanup is called after downloads
4. **Priority issues**: Check resource type detection and priority mapping

### Debug Logging

Enable detailed logging:
```typescript
// In download.ts
requestQueue.setEventListeners({
  onStart: (request) => console.debug('Queue start:', request),
  onComplete: (result) => console.debug('Queue complete:', result),
  onError: (request, error) => console.debug('Queue error:', request, error)
});
```

### Performance Monitoring

Monitor queue performance:
```typescript
// Get real-time statistics
setInterval(() => {
  const stats = requestQueue.getStats();
  console.log('Queue performance:', {
    processingRate: stats.processingRate,
    memoryPressure: stats.memoryPressureLevel,
    adaptiveConcurrency: stats.adaptiveConcurrency
  });
}, 5000);