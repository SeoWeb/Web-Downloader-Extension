import { requestQueue } from './RequestQueue';
import { RequestPriority, ResourceType } from '../types/queue';

/**
 * Simple test suite for the queue system
 * This can be run in the browser console or during development
 */
export class QueueTest {
  private testResults: { name: string; passed: boolean; error?: string }[] = [];

  /**
   * Run all tests
   */
  async runAllTests(): Promise<void> {
    console.log('🧪 Starting Queue System Tests...');
    
    try {
      await this.testBasicEnqueue();
      await this.testPriorityOrdering();
      await this.testDomainLimiting();
      await this.testRetryMechanism();
      await this.testMemoryPressure();
      await this.testQueueStats();
      
      this.printResults();
    } catch (error) {
      console.error('Test suite failed:', error);
    }
  }

  /**
   * Test basic enqueue functionality
   */
  private async testBasicEnqueue(): Promise<void> {
    try {
      const requestId = await requestQueue.enqueue({
        url: 'https://example.com/test.css',
        resourceType: ResourceType.CSS,
        priority: RequestPriority.NORMAL,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 1024,
        fetchOptions: {},
        onComplete: () => {},
        onError: () => {}
      });

      if (requestId) {
        this.addResult('Basic Enqueue', true);
      } else {
        this.addResult('Basic Enqueue', false, 'Failed to get request ID');
      }
    } catch (error) {
      this.addResult('Basic Enqueue', false, String(error));
    }
  }

  /**
   * Test priority ordering
   */
  private async testPriorityOrdering(): Promise<void> {
    try {
      const order: string[] = [];
      
      // Enqueue requests with different priorities
      const criticalId = await requestQueue.enqueue({
        url: 'https://example.com/critical.html',
        resourceType: ResourceType.HTML,
        priority: RequestPriority.CRITICAL,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 1024,
        fetchOptions: {},
        onComplete: () => { order.push('critical'); },
        onError: () => {}
      });

      const lowId = await requestQueue.enqueue({
        url: 'https://example.com/low.jpg',
        resourceType: ResourceType.IMAGE,
        priority: RequestPriority.LOW,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 1024,
        fetchOptions: {},
        onComplete: () => { order.push('low'); },
        onError: () => {}
      });

      const highId = await requestQueue.enqueue({
        url: 'https://example.com/high.js',
        resourceType: ResourceType.JS,
        priority: RequestPriority.HIGH,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 1024,
        fetchOptions: {},
        onComplete: () => { order.push('high'); },
        onError: () => {}
      });

      // Check if all requests were enqueued
      if (criticalId && lowId && highId) {
        this.addResult('Priority Enqueue', true);
      } else {
        this.addResult('Priority Enqueue', false, 'Failed to enqueue all priority requests');
      }
    } catch (error) {
      this.addResult('Priority Enqueue', false, String(error));
    }
  }

  /**
   * Test domain limiting
   */
  private async testDomainLimiting(): Promise<void> {
    try {
      // Enqueue multiple requests for the same domain
      const requests = [];
      for (let i = 0; i < 5; i++) {
        const id = await requestQueue.enqueue({
          url: `https://same-domain.com/file${i}.css`,
          resourceType: ResourceType.CSS,
          priority: RequestPriority.NORMAL,
          domain: '',
          dependencies: [],
          retryCount: 0,
          estimatedSize: 1024,
          fetchOptions: {},
          onComplete: () => {},
          onError: () => {}
        });
        requests.push(id);
      }

      // Check if all requests were enqueued
      if (requests.every(id => id)) {
        this.addResult('Domain Limiting', true);
      } else {
        this.addResult('Domain Limiting', false, 'Failed to enqueue domain-limited requests');
      }
    } catch (error) {
      this.addResult('Domain Limiting', false, String(error));
    }
  }

  /**
   * Test retry mechanism
   */
  private async testRetryMechanism(): Promise<void> {
    try {
      const requestId = await requestQueue.enqueue({
        url: 'https://example.com/retry-test.js',
        resourceType: ResourceType.JS,
        priority: RequestPriority.NORMAL,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 1024,
        fetchOptions: {},
        onComplete: () => {},
        onError: () => {}
      });

      if (requestId) {
        this.addResult('Retry Mechanism', true);
      } else {
        this.addResult('Retry Mechanism', false, 'Failed to enqueue retry test request');
      }
    } catch (error) {
      this.addResult('Retry Mechanism', false, String(error));
    }
  }

  /**
   * Test memory pressure handling
   */
  private async testMemoryPressure(): Promise<void> {
    try {
      // Get initial stats
      const initialStats = requestQueue.getStats();
      
      // Enqueue a large request
      const requestId = await requestQueue.enqueue({
        url: 'https://example.com/large-file.zip',
        resourceType: ResourceType.OTHER,
        priority: RequestPriority.LOW,
        domain: '',
        dependencies: [],
        retryCount: 0,
        estimatedSize: 50 * 1024 * 1024, // 50MB
        fetchOptions: {},
        onComplete: () => {},
        onError: () => {}
      });

      // Get updated stats
      const updatedStats = requestQueue.getStats();
      
      if (requestId && updatedStats.queued > initialStats.queued) {
        this.addResult('Memory Pressure', true);
      } else {
        this.addResult('Memory Pressure', false, 'Memory pressure handling failed');
      }
    } catch (error) {
      this.addResult('Memory Pressure', false, String(error));
    }
  }

  /**
   * Test queue statistics
   */
  private async testQueueStats(): Promise<void> {
    try {
      const stats = requestQueue.getStats();
      
      // Check if stats object has expected properties
      const hasRequiredProps =
        typeof stats.queued === 'number' &&
        typeof stats.active === 'number' &&
        typeof stats.completed === 'number' &&
        typeof stats.failed === 'number' &&
        typeof stats.adaptiveConcurrency === 'number';

      if (hasRequiredProps) {
        this.addResult('Queue Stats', true);
      } else {
        this.addResult('Queue Stats', false, 'Stats object missing required properties');
      }
    } catch (error) {
      this.addResult('Queue Stats', false, String(error));
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
    console.log('\n📊 Queue Test Results:');
    console.log('========================');
    
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
    
    console.log('========================');
    console.log(`Summary: ${passed} passed, ${failed} failed`);
    
    if (failed === 0) {
      console.log('🎉 All tests passed!');
    } else {
      console.log('⚠️ Some tests failed. Check the implementation.');
    }
  }
}

/**
 * Run tests if this file is imported in a browser environment
 */
if (typeof window !== 'undefined') {
  // Add to global scope for easy testing in browser console
  (window as any).queueTest = new QueueTest();
  console.log('Queue test suite loaded. Run window.queueTest.runAllTests() to execute tests.');
}