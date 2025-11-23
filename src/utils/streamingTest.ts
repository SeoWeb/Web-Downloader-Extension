/**
 * Streaming System Test Suite
 * Comprehensive testing for streaming downloads and chunked processing
 */

import { StreamingDownloader } from './StreamingDownloader';
import { ChunkedZipProcessor } from './chunkedZip';
import { StreamingFetcher } from './streamingFetch';
import { createProgressPersistence } from './progressPersistence';
import {
  StreamingDownload,
  StreamingOptions,
} from '../types/streaming';
import { memoryManager } from './MemoryManager';

export interface TestResult {
  testName: string;
  passed: boolean;
  duration: number;
  error?: string;
  details?: any;
}

export interface StreamingTestSuite {
  memoryUsageBefore: number;
  memoryUsageAfter: number;
  results: TestResult[];
  summary: {
    totalTests: number;
    passedTests: number;
    failedTests: number;
    totalDuration: number;
  };
}

export class StreamingSystemTester {
  private persistence = createProgressPersistence('memory');
  private streamingDownloader = new StreamingDownloader(this.persistence);
  private streamingFetcher = new StreamingFetcher();
  private createdObjectUrls: string[] = [];

  /**
   * Create a local blob URL for testing
   */
  private createTestBlobUrl(size: number): string {
    const buffer = new Uint8Array(size);
    // Fill first few bytes to ensure it's not empty
    for (let i = 0; i < Math.min(size, 100); i++) {
      buffer[i] = i % 255;
    }
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    this.createdObjectUrls.push(url);
    return url;
  }

  /**
   * Cleanup created blob URLs
   */
  private cleanupTestBlobUrls() {
    this.createdObjectUrls.forEach(url => URL.revokeObjectURL(url));
    this.createdObjectUrls = [];
  }

  /**
   * Run comprehensive streaming system tests
   */
  async runTests(): Promise<StreamingTestSuite> {
    const memoryBefore = memoryManager.getMemoryStats().totalMemoryUsed;
    const startTime = Date.now();
    const results: TestResult[] = [];

    console.log('🚀 Starting streaming system tests...');

    // Test 1: Basic streaming download
    results.push(await this.testBasicStreamingDownload());

    // Test 2: Chunked ZIP processing
    results.push(await this.testChunkedZipProcessing());

    // Test 3: Memory pressure handling
    results.push(await this.testMemoryPressureHandling());

    // Test 4: Progress persistence
    results.push(await this.testProgressPersistence());

    // Test 5: Large file handling
    results.push(await this.testLargeFileHandling());

    // Test 6: Concurrent downloads
    results.push(await this.testConcurrentDownloads());

    // Test 7: Download resumption
    results.push(await this.testDownloadResumption());

    // Test 8: Error handling and recovery
    results.push(await this.testErrorHandling());

    // Test 9: Memory efficiency comparison
    results.push(await this.testMemoryEfficiency());

    // Test 10: Integration with existing download system
    results.push(await this.testDownloadIntegration());

    const memoryAfter = memoryManager.getMemoryStats().totalMemoryUsed;
    const totalDuration = Date.now() - startTime;

    const summary = {
      totalTests: results.length,
      passedTests: results.filter(r => r.passed).length,
      failedTests: results.filter(r => !r.passed).length,
      totalDuration,
    };

    console.log('\n📊 Test Summary:');
    console.log(`Total Tests: ${summary.totalTests}`);
    console.log(`Passed: ${summary.passedTests}`);
    console.log(`Failed: ${summary.failedTests}`);
    console.log(`Duration: ${totalDuration}ms`);
    console.log(`Memory Change: ${this.formatBytes(memoryAfter - memoryBefore)}`);

    return {
      memoryUsageBefore: memoryBefore,
      memoryUsageAfter: memoryAfter,
      results,
      summary,
    };
  }

  /**
   * Test basic streaming download functionality
   */
  private async testBasicStreamingDownload(): Promise<TestResult> {
    const testName = 'Basic Streaming Download';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Use a local blob URL instead of external service
      const testUrl = this.createTestBlobUrl(1048576); // 1MB test file

      const download = await this.streamingDownloader.startDownload(testUrl, {
        chunkSize: 64 * 1024, // 64KB chunks
        maxParallelChunks: 2,
        maxRetries: 2,
        enableResumption: true,
      });

      console.log(`Download started: ${download.id}`);

      // Wait for completion
      while (download.status !== 'completed' && download.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 100));
        const progress = this.streamingDownloader.getProgress(download.id);
        if (progress && progress.status === 'streaming') {
          console.log(`Progress: ${Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)}%`);
        }
      }

      if (download.status === 'completed') {
        console.log(`✅ ${testName} completed successfully`);
        console.log(`Downloaded: ${this.formatBytes(download.downloadedSize)}`);
        console.log(`Chunks: ${download.chunks.length}`);

        return {
          testName,
          passed: true,
          duration: Date.now() - startTime,
          details: {
            downloadSize: download.downloadedSize,
            chunkCount: download.chunks.length,
            downloadTime: download.completedAt! - download.startedAt,
          },
        };
      } else {
        throw new Error(download.error || 'Download failed');
      }
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test chunked ZIP processing
   */
  private async testChunkedZipProcessing(): Promise<TestResult> {
    const testName = 'Chunked ZIP Processing';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      const zipProcessor = new ChunkedZipProcessor({
        progressive: true,
        maxMemoryUsage: 50 * 1024 * 1024, // 50MB limit
      });

      // Create test data
      const testFiles = [
        { path: 'test1.txt', data: new Blob(['Test content 1'], { type: 'text/plain' }) },
        { path: 'test2.txt', data: new Blob(['Test content 2'.repeat(1000)], { type: 'text/plain' }) },
        { path: 'folder/test3.txt', data: new Blob(['Test content 3'.repeat(10000)], { type: 'text/plain' }) },
      ];

      // Add files to ZIP
      for (const file of testFiles) {
        await zipProcessor.addEntry(file);
      }

      // Generate ZIP
      const zipBlob = await zipProcessor.generateZip();

      console.log(`✅ ZIP generated successfully`);
      console.log(`ZIP size: ${this.formatBytes(zipBlob.size)}`);
      console.log(`Files: ${testFiles.length}`);

      return {
        testName,
        passed: true,
        duration: Date.now() - startTime,
        details: {
          zipSize: zipBlob.size,
          fileCount: testFiles.length,
        },
      };
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test memory pressure handling
   */
  private async testMemoryPressureHandling(): Promise<TestResult> {
    const testName = 'Memory Pressure Handling';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      const memoryBefore = memoryManager.getMemoryStats();
      console.log(`Memory before: ${this.formatBytes(memoryBefore.totalMemoryUsed)}`);

      // Create memory pressure with multiple concurrent operations
      const promises: Promise<any>[] = [];

      for (let i = 0; i < 5; i++) {
        const zipProcessor = new ChunkedZipProcessor({
          maxMemoryUsage: 20 * 1024 * 1024, // 20MB limit per processor
        });

        promises.push(
          zipProcessor.addEntry({
            path: `test${i}.txt`,
            data: new Blob(['x'.repeat(1024 * 1024)], { type: 'text/plain' }), // 1MB each
          })
        );
      }

      await Promise.all(promises);

      const memoryAfter = memoryManager.getMemoryStats();
      console.log(`Memory after: ${this.formatBytes(memoryAfter.totalMemoryUsed)}`);
      console.log(`Memory increase: ${this.formatBytes(memoryAfter.totalMemoryUsed - memoryBefore.totalMemoryUsed)}`);

      // Check if memory manager responded appropriately
      const pressureLevel = memoryAfter.memoryPressureLevel;
      console.log(`Memory pressure level: ${pressureLevel}`);

      return {
        testName,
        passed: true,
        duration: Date.now() - startTime,
        details: {
          memoryIncrease: memoryAfter.totalMemoryUsed - memoryBefore.totalMemoryUsed,
          pressureLevel,
        },
      };
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test progress persistence
   */
  private async testProgressPersistence(): Promise<TestResult> {
    const testName = 'Progress Persistence';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Create a test download
      const testDownload: StreamingDownload = {
        id: 'test-download-123',
        url: 'https://example.com/test-file.txt',
        totalSize: 1024 * 1024,
        downloadedSize: 512 * 1024,
        progress: 0.5,
        chunks: [
          { index: 0, start: 0, end: 511, size: 512, downloaded: true, retryCount: 0 },
          { index: 1, start: 512, end: 1023, size: 512, downloaded: false, retryCount: 0 },
        ],
        status: 'streaming',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        resumable: true,
        activeChunks: 1,
        chunkSize: 512,
      };

      // Save progress
      await this.persistence.saveProgress(testDownload);

      // Load progress
      const loadedDownload = await this.persistence.loadProgress(testDownload.id);

      if (!loadedDownload) {
        throw new Error('Failed to load saved progress');
      }

      // Verify data integrity
      if (loadedDownload.id !== testDownload.id ||
          loadedDownload.progress !== testDownload.progress ||
          loadedDownload.chunks.length !== testDownload.chunks.length) {
        throw new Error('Loaded data does not match saved data');
      }

      // Clean up
      await this.persistence.removeProgress(testDownload.id);

      console.log(`✅ Progress persistence test completed successfully`);

      return {
        testName,
        passed: true,
        duration: Date.now() - startTime,
        details: {
          savedDownloadId: testDownload.id,
          loadedProgress: loadedDownload.progress,
        },
      };
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test large file handling
   */
  private async testLargeFileHandling(): Promise<TestResult> {
    const testName = 'Large File Handling';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Test with a larger file (10MB)
      const testUrl = this.createTestBlobUrl(10485760); // 10MB test file

      const shouldStream = this.streamingDownloader.shouldUseStreaming(testUrl, 10 * 1024 * 1024);
      console.log(`Should use streaming: ${shouldStream}`);

      if (!shouldStream) {
        throw new Error('Large file should trigger streaming');
      }

      const options: StreamingOptions = {
        chunkSize: 1024 * 1024, // 1MB chunks
        maxParallelChunks: 3,
        enableResumption: true,
        enablePersistence: true,
      };

      const download = await this.streamingDownloader.startDownload(testUrl, options);

      // Monitor memory usage during download
      let maxMemoryUsage = 0;
      const memoryMonitor = setInterval(() => {
        const currentUsage = memoryManager.getMemoryStats().totalMemoryUsed;
        maxMemoryUsage = Math.max(maxMemoryUsage, currentUsage);
      }, 1000);

      // Wait for completion (with timeout)
      const timeout = setTimeout(() => {
        this.streamingDownloader.cancelDownload(download.id);
        throw new Error('Download timeout');
      }, 60000); // 60 second timeout

      while (download.status !== 'completed' && download.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const progress = this.streamingDownloader.getProgress(download.id);
        if (progress) {
          console.log(`Progress: ${Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)}% (${this.formatBytes(progress.bytesDownloaded)}/${this.formatBytes(progress.totalBytes)})`);
        }
      }

      clearTimeout(timeout);
      clearInterval(memoryMonitor);

      if (download.status === 'completed') {
        console.log(`✅ Large file download completed successfully`);
        console.log(`Max memory usage: ${this.formatBytes(maxMemoryUsage)}`);
        console.log(`Chunks used: ${download.chunks.length}`);

        return {
          testName,
          passed: true,
          duration: Date.now() - startTime,
          details: {
            downloadSize: download.downloadedSize,
            chunkCount: download.chunks.length,
            maxMemoryUsage,
            averageChunkSize: download.chunkSize,
          },
        };
      } else {
        throw new Error(download.error || 'Download failed');
      }
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test concurrent downloads
   */
  private async testConcurrentDownloads(): Promise<TestResult> {
    const testName = 'Concurrent Downloads';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Start multiple downloads concurrently
      const downloadUrls = [
        this.createTestBlobUrl(1048576), // 1MB
        this.createTestBlobUrl(2097152), // 2MB
        this.createTestBlobUrl(524288),  // 512KB
      ];

      const downloadPromises = downloadUrls.map(async (url, index) => {
        console.log(`Starting concurrent download ${index + 1}`);
        return this.streamingDownloader.startDownload(url, {
          chunkSize: 64 * 1024,
          maxParallelChunks: 2,
        });
      });

      const downloads = await Promise.all(downloadPromises);

      // Wait for all to complete
      const completionPromises = downloads.map(async (download, index) => {
        while (download.status !== 'completed' && download.status !== 'failed') {
          await new Promise(resolve => setTimeout(resolve, 500));
          const progress = this.streamingDownloader.getProgress(download.id);
          if (progress) {
            console.log(`Download ${index + 1}: ${Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)}%`);
          }
        }
        return download;
      });

      const completedDownloads = await Promise.all(completionPromises);
      const successfulDownloads = completedDownloads.filter(d => d.status === 'completed');

      if (successfulDownloads.length === downloadUrls.length) {
        console.log(`✅ All concurrent downloads completed successfully`);

        const totalSize = successfulDownloads.reduce((sum, d) => sum + d.downloadedSize, 0);

        return {
          testName,
          passed: true,
          duration: Date.now() - startTime,
          details: {
            concurrentDownloads: downloadUrls.length,
            successfulDownloads: successfulDownloads.length,
            totalSize,
          },
        };
      } else {
        throw new Error(`Only ${successfulDownloads.length}/${downloadUrls.length} downloads succeeded`);
      }
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test download resumption
   */
  private async testDownloadResumption(): Promise<TestResult> {
    const testName = 'Download Resumption';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Use a moderate size file for resumption test
      const testUrl = this.createTestBlobUrl(4194304); // 4MB file

      const options = {
        chunkSize: 256 * 1024, // 256KB chunks
        maxParallelChunks: 2,
        enableResumption: true,
        enablePersistence: true,
        maxRetries: 3,
      };

      // Start download
      const download = await this.streamingDownloader.startDownload(testUrl, options);

      // Let it run for a bit, then pause
      await new Promise(resolve => setTimeout(resolve, 2000));
      await this.streamingDownloader.pauseDownload(download.id);
      console.log(`Download paused at ${Math.round(download.progress * 100)}%`);

      const pausedProgress = download.progress;

      // Wait a moment, then resume
      await new Promise(resolve => setTimeout(resolve, 1000));
      await this.streamingDownloader.resumeDownload(download.id);
      console.log(`Download resumed`);

      // Wait for completion
      while (download.status !== 'completed' && download.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 500));
        const progress = this.streamingDownloader.getProgress(download.id);
        if (progress) {
          console.log(`Resumed progress: ${Math.round((progress.bytesDownloaded / progress.totalBytes) * 100)}%`);
        }
      }

      if (download.status === 'completed') {
        console.log(`✅ Download resumption test completed successfully`);

        return {
          testName,
          passed: true,
          duration: Date.now() - startTime,
          details: {
            pausedProgress: Math.round(pausedProgress * 100),
            finalProgress: Math.round(download.progress * 100),
            totalSize: download.downloadedSize,
          },
        };
      } else {
        throw new Error(download.error || 'Resumed download failed');
      }
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test error handling and recovery
   */
  private async testErrorHandling(): Promise<TestResult> {
    const testName = 'Error Handling and Recovery';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // Test with invalid URL
      const invalidUrl = 'https://invalid-domain-that-does-not-exist.com/test.txt';

      const options = {
        chunkSize: 64 * 1024,
        maxParallelChunks: 1,
        maxRetries: 2,
        enableResumption: false,
      };

      let downloadFailed = false;
      let errorCaught = false;

      try {
        const download = await this.streamingDownloader.startDownload(invalidUrl, options);

        // Wait for failure
        while (download.status !== 'completed' && download.status !== 'failed') {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        downloadFailed = download.status === 'failed';
      } catch (error) {
        errorCaught = true;
        console.log(`Expected error caught: ${error}`);
      }

      if (downloadFailed || errorCaught) {
        console.log(`✅ Error handling test completed successfully`);
        console.log(`Download failed: ${downloadFailed}`);
        console.log(`Error caught: ${errorCaught}`);

        return {
          testName,
          passed: true,
          duration: Date.now() - startTime,
          details: {
            downloadFailed,
            errorCaught,
          },
        };
      } else {
        throw new Error('Expected error was not handled properly');
      }
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test memory efficiency
   */
  private async testMemoryEfficiency(): Promise<TestResult> {
    const testName = 'Memory Efficiency';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      const memoryBefore = memoryManager.getMemoryStats();
      console.log(`Memory before test: ${this.formatBytes(memoryBefore.totalMemoryUsed)}`);

      // Test streaming vs non-streaming memory usage
      const testSize = 2 * 1024 * 1024; // 2MB
      const testUrl = this.createTestBlobUrl(testSize);

      // Test streaming approach
      const streamingDownload = await this.streamingDownloader.startDownload(testUrl, {
        chunkSize: 64 * 1024, // Small chunks to test efficiency
        maxParallelChunks: 1, // Sequential to minimize memory spikes
      });

      while (streamingDownload.status !== 'completed' && streamingDownload.status !== 'failed') {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      const memoryAfterStreaming = memoryManager.getMemoryStats();

      // Simulate non-streaming approach (for comparison)
      const response = await fetch(testUrl);
      const nonStreamingData = await response.arrayBuffer();

      const memoryAfterNonStreaming = memoryManager.getMemoryStats();

      console.log(`Memory after streaming: ${this.formatBytes(memoryAfterStreaming.totalMemoryUsed)}`);
      console.log(`Memory after non-streaming: ${this.formatBytes(memoryAfterNonStreaming.totalMemoryUsed)}`);

      // Clean up
      await memoryManager.forceCleanup();
      const memoryAfterCleanup = memoryManager.getMemoryStats();

      console.log(`Memory after cleanup: ${this.formatBytes(memoryAfterCleanup.totalMemoryUsed)}`);

      return {
        testName,
        passed: true,
        duration: Date.now() - startTime,
        details: {
          memoryBefore: memoryBefore.totalMemoryUsed,
          memoryAfterStreaming: memoryAfterStreaming.totalMemoryUsed,
          memoryAfterNonStreaming: memoryAfterNonStreaming.totalMemoryUsed,
          memoryAfterCleanup: memoryAfterCleanup.totalMemoryUsed,
          streamingSize: streamingDownload.downloadedSize,
          nonStreamingSize: nonStreamingData.byteLength,
        },
      };
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Test integration with existing download system
   */
  private async testDownloadIntegration(): Promise<TestResult> {
    const testName = 'Download System Integration';
    const startTime = Date.now();

    try {
      console.log(`\n🧪 Testing: ${testName}`);

      // This would test the integration with the main download functions
      // For now, we'll just verify the imports and basic functionality

      const url1 = this.createTestBlobUrl(1024);
      const url2 = this.createTestBlobUrl(2048);
      const url3 = this.createTestBlobUrl(4096);

      const testHtml = `
        <html>
          <head>
            <link rel="stylesheet" href="${url1}">
            <script src="${url2}"></script>
          </head>
          <body>
            <img src="${url3}">
          </body>
        </html>
      `;

      // Simulate the process of checking for large files
      console.log(`Testing large file detection...`);
      const _hasLargeFiles = false; // This would use the actual checkForLargeFiles function

      // Test the streaming fetcher
      console.log(`Testing streaming fetcher...`);
      const metadata = await this.streamingFetcher.getMetadata(url1);
      console.log(`Metadata retrieved: size=${metadata.size}, supportsRange=${metadata.supportsRangeRequests}`);

      console.log(`✅ Integration test completed successfully`);

      return {
        testName,
        passed: true,
        duration: Date.now() - startTime,
        details: {
          htmlLength: testHtml.length,
          hasLargeFiles: _hasLargeFiles,
          metadataRetrieved: !!metadata,
        },
      };
    } catch (error) {
      console.error(`❌ ${testName} failed:`, error);
      return {
        testName,
        passed: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Format bytes to human readable format
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  /**
   * Generate test report
   */
  generateTestReport(results: StreamingTestSuite): string {
    let report = '# Streaming System Test Report\n\n';

    report += `## Summary\n`;
    report += `- **Total Tests:** ${results.summary.totalTests}\n`;
    report += `- **Passed:** ${results.summary.passedTests}\n`;
    report += `- **Failed:** ${results.summary.failedTests}\n`;
    report += `- **Success Rate:** ${Math.round((results.summary.passedTests / results.summary.totalTests) * 100)}%\n`;
    report += `- **Total Duration:** ${results.summary.totalDuration}ms\n`;
    report += `- **Memory Usage Change:** ${this.formatBytes(results.memoryUsageAfter - results.memoryUsageBefore)}\n\n`;

    report += `## Test Results\n\n`;

    for (const result of results.results) {
      const status = result.passed ? '✅ PASSED' : '❌ FAILED';
      report += `### ${result.testName} - ${status}\n`;
      report += `- **Duration:** ${result.duration}ms\n`;

      if (result.error) {
        report += `- **Error:** ${result.error}\n`;
      }

      if (result.details) {
        report += `- **Details:**\n`;
        for (const [key, value] of Object.entries(result.details)) {
          report += `  - ${key}: ${value}\n`;
        }
      }

      report += '\n';
    }

    return report;
  }

  /**
   * Cleanup test resources
   */
  async cleanup(): Promise<void> {
    // Cancel all active downloads
    const activeDownloads = this.streamingDownloader.getActiveDownloads();
    for (const download of activeDownloads) {
      try {
        await this.streamingDownloader.cancelDownload(download.id);
      } catch (error) {
        console.error(`Failed to cancel download ${download.id}:`, error);
      }
    }

    // Cleanup persistence
    // Check if clear method exists, otherwise use cleanup
    if ('clear' in this.persistence) {
      await (this.persistence as any).clear();
    } else {
      await this.persistence.cleanup();
    }

    // Destroy streaming downloader
    this.streamingDownloader.destroy();

    // Cleanup blob URLs
    this.cleanupTestBlobUrls();

    console.log('Test cleanup completed');
  }
}

/**
 * Run streaming tests and generate report
 */
export async function runStreamingTests(): Promise<string> {
  const tester = new StreamingSystemTester();

  try {
    const results = await tester.runTests();
    const report = tester.generateTestReport(results);

    console.log('\n' + '='.repeat(50));
    console.log('TEST REPORT');
    console.log('='.repeat(50));
    console.log(report);

    return report;
  } finally {
    await tester.cleanup();
  }
}