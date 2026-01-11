/**
 * Domain Rate Limiter
 * Implements per-domain request rate limiting to avoid overwhelming servers
 */

import { DomainLimiter as IDomainLimiter } from '../types/queue';

export class DomainLimiter implements IDomainLimiter {
  public readonly domain: string;
  public maxRequestsPerSecond: number;
  public activeRequests: number = 0;
  public requestTimestamps: number[] = [];
  public lastRequestTime: number = 0;
  public respectRobotsTxt: boolean = true;
  public crawlDelay: number = 0;
  public connectionPoolSize: number = 12;
  public activeConnections: number = 0;

  // Cache for robots.txt crawl delay
  private robotsTxtCache: Map<string, number> = new Map();
  private robotsTxtCacheTime: Map<string, number> = new Map();
  private readonly ROBOTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(domain: string, maxRequestsPerSecond: number = 8) {
    this.domain = domain;
    this.maxRequestsPerSecond = maxRequestsPerSecond;
    
    // Initialize robots.txt crawl delay
    this.initializeCrawlDelay();
  }

  /**
   * Check if a request can be made now based on rate limits
   */
  public canMakeRequest(): boolean {
    const now = Date.now();
    
    // Clean up old timestamps (older than 1 second)
    this.cleanupOldTimestamps(now);
    
    // Check if we're at the rate limit
    if (this.requestTimestamps.length >= this.maxRequestsPerSecond) {
      return false;
    }
    
    // Check crawl delay from robots.txt
    if (this.respectRobotsTxt && this.crawlDelay > 0) {
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.crawlDelay) {
        return false;
      }
    }
    
    // Check connection pool availability
    if (this.activeConnections >= this.connectionPoolSize) {
      return false;
    }
    
    return true;
  }

  /**
   * Record that a request is starting
   */
  public startRequest(): void {
    const now = Date.now();
    this.requestTimestamps.push(now);
    this.lastRequestTime = now;
    this.activeRequests++;
    this.activeConnections++;
  }

  /**
   * Record that a request has completed
   */
  public completeRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.activeConnections = Math.max(0, this.activeConnections - 1);
  }

  /**
   * Get the time to wait before the next request can be made
   */
  public getWaitTime(): number {
    const now = Date.now();
    
    // Clean up old timestamps
    this.cleanupOldTimestamps(now);
    
    // If we're at the rate limit, calculate wait time
    if (this.requestTimestamps.length >= this.maxRequestsPerSecond) {
      const oldestRequest = this.requestTimestamps[0];
      return Math.max(0, 1000 - (now - oldestRequest));
    }
    
    // Check crawl delay
    if (this.respectRobotsTxt && this.crawlDelay > 0) {
      const timeSinceLastRequest = now - this.lastRequestTime;
      return Math.max(0, this.crawlDelay - timeSinceLastRequest);
    }
    
    return 0;
  }

  /**
   * Adjust the rate limit based on server response
   */
  public adjustRateLimit(responseStatus: number, retryAfter?: number): void {
    // If server sends 429 Too Many Requests, back off
    if (responseStatus === 429) {
      if (retryAfter) {
        // Use explicit retry-after header
        this.maxRequestsPerSecond = Math.max(1, Math.floor(1000 / retryAfter));
      } else {
        // Reduce rate limit by 50%
        this.maxRequestsPerSecond = Math.max(1, Math.floor(this.maxRequestsPerSecond * 0.5));
      }
      console.warn(`Rate limiting reduced for ${this.domain} to ${this.maxRequestsPerSecond} req/s due to 429 response`);
    }
    
    // If we get 5xx errors, reduce rate limit
    else if (responseStatus >= 500 && responseStatus < 600) {
      this.maxRequestsPerSecond = Math.max(1, Math.floor(this.maxRequestsPerSecond * 0.8));
      console.warn(`Rate limiting reduced for ${this.domain} to ${this.maxRequestsPerSecond} req/s due to server errors`);
    }
    
    // If we get successful responses, we can gradually increase
    else if (responseStatus >= 200 && responseStatus < 300) {
      // Gradually increase rate limit back to default
      const defaultRate = 2; // Default rate
      if (this.maxRequestsPerSecond < defaultRate) {
        this.maxRequestsPerSecond = Math.min(defaultRate, this.maxRequestsPerSecond + 1);
      }
    }
  }

  /**
   * Get current statistics for this domain
   */
  public getStats(): {
    domain: string;
    currentRate: number;
    maxRate: number;
    activeRequests: number;
    activeConnections: number;
    connectionPoolUtilization: number;
    crawlDelay: number;
  } {
    const now = Date.now();
    this.cleanupOldTimestamps(now);
    
    return {
      domain: this.domain,
      currentRate: this.requestTimestamps.length,
      maxRate: this.maxRequestsPerSecond,
      activeRequests: this.activeRequests,
      activeConnections: this.activeConnections,
      connectionPoolUtilization: this.activeConnections / this.connectionPoolSize,
      crawlDelay: this.crawlDelay,
    };
  }

  /**
   * Reset the rate limiter to default state
   */
  public reset(): void {
    this.requestTimestamps = [];
    this.activeRequests = 0;
    this.activeConnections = 0;
    this.lastRequestTime = 0;
    this.maxRequestsPerSecond = 2; // Reset to default
  }

  /**
   * Initialize crawl delay from robots.txt
   */
  private initializeCrawlDelay(): void {
    if (!this.respectRobotsTxt) {
      return;
    }

    const now = Date.now();
    const cachedTime = this.robotsTxtCacheTime.get(this.domain);
    
    // Check if we have a fresh cache
    if (cachedTime && (now - cachedTime) < this.ROBOTS_CACHE_TTL) {
      const cachedDelay = this.robotsTxtCache.get(this.domain);
      if (cachedDelay !== undefined) {
        this.crawlDelay = cachedDelay;
        return;
      }
    }

    // Fetch robots.txt asynchronously without blocking
    this.fetchRobotsTxtAsync();
  }

  /**
   * Fetch robots.txt asynchronously without blocking requests
   */
  private async fetchRobotsTxtAsync(): Promise<void> {
    try {
      // Fetch robots.txt with shorter timeout
      const robotsUrl = `https://${this.domain}/robots.txt`;
      const response = await fetch(robotsUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(2000), // Reduced from 5 seconds to 2 seconds
      });

      if (response.ok) {
        const robotsText = await response.text();
        const crawlDelay = this.parseCrawlDelay(robotsText);
        
        this.crawlDelay = crawlDelay;
        this.robotsTxtCache.set(this.domain, crawlDelay);
        this.robotsTxtCacheTime.set(this.domain, Date.now());
      }
    } catch (error) {
      // Silently fail - robots.txt is optional
      console.debug(`Failed to fetch robots.txt for ${this.domain}:`, error);
    }
  }

  /**
   * Parse crawl delay from robots.txt content
   */
  private parseCrawlDelay(robotsText: string): number {
    const lines = robotsText.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase();
      
      // Look for "Crawl-delay:" directive
      if (trimmedLine.startsWith('crawl-delay:')) {
        const delayStr = trimmedLine.substring('crawl-delay:'.length).trim();
        const delay = parseFloat(delayStr);
        
        if (!isNaN(delay)) {
          // Convert to milliseconds
          return Math.floor(delay * 1000);
        }
      }
    }
    
    return 0;
  }

  /**
   * Clean up old timestamps (older than 1 second)
   */
  private cleanupOldTimestamps(now: number): void {
    const oneSecondAgo = now - 1000;
    this.requestTimestamps = this.requestTimestamps.filter(
      timestamp => timestamp > oneSecondAgo
    );
  }
}

/**
 * Factory for creating and managing domain limiters
 */
export class DomainLimiterFactory {
  private static limiters: Map<string, DomainLimiter> = new Map();
  private static defaultRateLimit: number = 8;

  /**
   * Get or create a domain limiter for the given domain
   */
  public static getLimiter(domain: string, customRateLimit?: number): DomainLimiter {
    const rateLimit = customRateLimit || this.defaultRateLimit;
    
    let limiter = this.limiters.get(domain);
    if (!limiter) {
      limiter = new DomainLimiter(domain, rateLimit);
      this.limiters.set(domain, limiter);
    }
    
    return limiter;
  }
}