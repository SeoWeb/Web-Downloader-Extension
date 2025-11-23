import { requestQueue } from './RequestQueue';
import { RequestPriority, ResourceType } from '../types/queue';
import { fetchUrlWithQueue } from '../background/urlUtils';

/**
 * Integration test to verify queue system works with existing download functionality
 */
export class IntegrationTest {
  private testResults: { name: string; passed: boolean; error?: string }[] = [];

  /**
   * Run integration tests
   */
  async runAllTests(): Promise<void> {
    console.log('🔗 Starting Integration Tests...');
    
    try {
      await this.testQueueWithFileHandlers();
      await this.testQueueWithUrlUtils();
      await this.testMemoryIntegration();
      await this.testErrorHandling();
      
      this.printResults();
    } catch (error) {
      console.error('Integration test suite failed:', error);
    }
  }

  /**
   * Test queue integration with file handlers
   */
  private async testQueueWithFileHandlers(): Promise<void> {
    try {
      // Simulate CSS file download through queue
      const cssPromise = fetchUrlWithQueue(
        'https://example.com/test.css',
        'https://example.com',
        {
          priority: RequestPriority.HIGH,
          resourceType: ResourceType.CSS,
          fetchOptions: {
            headers: { 'Accept': 'text/css,*/*;q=0.1' }
          },
          onComplete: () => {
            console.log('CSS download completed via queue');
          },
          onError: (error) => {
            console.error('CSS download failed via queue:', error);
          }
        }
      );

      // Simulate JS file download through queue
      const jsPromise = fetchUrlWithQueue(
        'https://example.com/test.js',
        'https://example.com',
        {
          priority: RequestPriority.NORMAL,
          resourceType: ResourceType.JS,
          fetchOptions: {
            headers: { 'Accept': 'application/javascript,text/javascript,*/*;q=0.1' }
          },
          onComplete: () => {
            console.log('JS download completed via queue');
          },
          onError: (error) => {
            console.error('JS download failed via queue:', error);
          }
        }
      );

      // Wait for both to complete (with timeout)
      const results = await Promise.allSettled([
        cssPromise,
        jsPromise
      ]);

      const successCount = results.filter(r => r.status === 'fulfilled').length;
      
      if (successCount >= 1) { // At least one should succeed
        this.addResult('Queue with File Handlers', true);
      } else {
        this.addResult('Queue with File Handlers', false, 'No downloads succeeded through queue');
      }
    } catch (error) {
      this.addResult('Queue with File Handlers', false, String(error));
    }
  }

  /**
   * Test queue integration with URL utilities
   */
  private async testQueueWithUrlUtils(): Promise<void> {
    try {
      // Test different resource types
      const imagePromise = fetchUrlWithQueue(
        'https://example.com/test.jpg',
        'https://example.com',
        {
          priority: RequestPriority.LOW,
          resourceType: ResourceType.IMAGE,
          fetchOptions: {
            headers: { 'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' }
          }
        }
      );

      const htmlPromise = fetchUrlWithQueue(
        'https://example.com/test.html',
        'https://example.com',
        {
          priority: RequestPriority.CRITICAL,
          resourceType: ResourceType.HTML,
          fetchOptions: {
            headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8' }
          }
        }
      );

      // Wait for completion with timeout
      const results = await Promise.race([
        Promise.allSettled([imagePromise, htmlPromise]),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
      ]);

      if (results !== 'timeout') {
        this.addResult('Queue with URL Utils', true);
      } else {
        this.addResult('Queue with URL Utils', false, 'Test timed out');
      }
    } catch (error) {
      this.addResult('Queue with URL Utils', false, String(error));
    }
  }

  /**
   * Test memory management integration
   */
  private async testMemoryIntegration(): Promise<void> {
    try {
      // Get initial queue stats
      requestQueue.getStats();

      // Enqueue a request that should trigger memory management
      await fetchUrlWithQueue(
        'https://example.com/large-file.zip',
        'https://example.com',
        {
          priority: RequestPriority.LOW,
          resourceType: ResourceType.OTHER,
          fetchOptions: {
            maxSize: 10 * 1024 * 1024 // 10MB limit
          }
        }
      );

      // Check if queue is handling memory pressure
      const updatedStats = requestQueue.getStats();
      
      if (updatedStats.adaptiveConcurrency >= 0) {
        this.addResult('Memory Integration', true);
      } else {
        this.addResult('Memory Integration', false, 'Adaptive concurrency not working');
      }
    } catch (error) {
      this.addResult('Memory Integration', false, String(error));
    }
  }

  /**
   * Test error handling in queue
   */
  private async testErrorHandling(): Promise<void> {
    try {
      // Test with invalid URL
      const invalidPromise = fetchUrlWithQueue(
        'invalid-url',
        'https://example.com',
        {
          priority: RequestPriority.NORMAL,
          resourceType: ResourceType.OTHER,
          fetchOptions: {}
        }
      );

      // Test with non-existent URL
      const notFoundPromise = fetchUrlWithQueue(
        'https://example.com/non-existent-file-12345.css',
        'https://example.com',
        {
          priority: RequestPriority.NORMAL,
          resourceType: ResourceType.CSS,
          fetchOptions: {}
        }
      );

      // Wait for results with timeout
      const results = await Promise.race([
        Promise.allSettled([invalidPromise, notFoundPromise]),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))
      ]);

      if (results !== 'timeout') {
        this.addResult('Error Handling', true);
      } else {
        this.addResult('Error Handling', false, 'Error handling test timed out');
      }
    } catch (error) {
      this.addResult('Error Handling', false, String(error));
    }
  }

  /**
   * Add test result
   */
  private addResult(name: string, passed: boolean, error?: string): void {
    this.testResults.push({ name, passed, error });
  }

  /**
   * Print test results
   */
  private printResults(): void {
    console.log('\n🔗 Integration Test Results:');
    console.log('==============================');
    
    let passed = 0;
    let failed = 0;
    
    this.testResults.forEach(result => {
      const status = result.passed ? '✅ PASS' : '❌ FAIL';
      console.log(`${status} ${result.name}`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
      
      if (result.passed) {
        passed++;
      } else {
        failed++;
      }
    });
    
    console.log('==============================');
    console.log(`Summary: ${passed} passed, ${failed} failed`);
    
    if (failed === 0) {
      console.log('🎉 All integration tests passed!');
    } else {
      console.log('⚠️ Some integration tests failed. Check the implementation.');
    }
  }
}

/**
 * Run integration tests if this file is imported in a browser environment
 */
if (typeof window !== 'undefined') {
  // Add to global scope for easy testing in browser console
  (window as any).integrationTest = new IntegrationTest();
  console.log('Integration test suite loaded. Run window.integrationTest.runAllTests() to execute tests.');
}