/**
 * Unit tests for DomainLimiter rate recovery and robots.txt parsing.
 *
 * Covers OpenSpec task 2.6 of "stabilize-extension-downloads-and-ux":
 * - rate recovers to the actually configured default (not a hardcoded 2)
 * - Retry-After (ms) threads into adjustRateLimit
 * - Crawl-delay is parsed only from the `*` robots group
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DomainLimiter,
  DomainLimiterFactory,
} from "../../src/utils/DomainLimiter";

const robotsOk = "User-agent: *\nAllow: /\n";

describe("DomainLimiter", () => {
  beforeEach(() => {
    DomainLimiterFactory.resetAll();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(robotsOk, { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("rate recovery (task 2.6)", () => {
    it("recovers to the configured default rate after 429 backoff", () => {
      const limiter = new DomainLimiter("recovery.test", 8);

      // Back off on 429: 8 → 4 → 2
      limiter.adjustRateLimit(429);
      expect(limiter.maxRequestsPerSecond).toBe(4);
      limiter.adjustRateLimit(429);
      expect(limiter.maxRequestsPerSecond).toBe(2);

      // Successes must climb back to the CONFIGURED default (8), not stop at
      // the old hardcoded fallback of 2.
      for (let i = 0; i < 10; i++) {
        limiter.adjustRateLimit(200);
      }
      expect(limiter.maxRequestsPerSecond).toBe(8);
    });

    it("never exceeds the configured default during recovery", () => {
      const limiter = new DomainLimiter("cap.test", 3);
      for (let i = 0; i < 20; i++) {
        limiter.adjustRateLimit(200);
      }
      expect(limiter.maxRequestsPerSecond).toBe(3);
    });

    it("uses the Retry-After hint (ms) for 429 responses", () => {
      const limiter = new DomainLimiter("retryafter.test", 8);

      // Server asks for 5s between requests → 1000/5000 → floor 0 → clamps to 1
      limiter.adjustRateLimit(429, 5000);
      expect(limiter.maxRequestsPerSecond).toBe(1);

      // 250ms between requests → 4 requests/second
      const other = new DomainLimiter("retryafter2.test", 8);
      other.adjustRateLimit(429, 250);
      expect(other.maxRequestsPerSecond).toBe(4);
    });

    it("reset() restores the configured default rate", () => {
      const limiter = new DomainLimiter("reset.test", 8);
      limiter.adjustRateLimit(429);
      limiter.adjustRateLimit(429);
      expect(limiter.maxRequestsPerSecond).toBe(2);

      limiter.reset();
      expect(limiter.maxRequestsPerSecond).toBe(8);
    });

    it("reduces the rate on 5xx without Retry-After", () => {
      const limiter = new DomainLimiter("fivexx.test", 10);
      limiter.adjustRateLimit(500);
      expect(limiter.maxRequestsPerSecond).toBe(8);
    });
  });

  describe("robots.txt Crawl-delay parsing (task 2.6)", () => {
    it("parses the delay from the * group", () => {
      const limiter = new DomainLimiter("parse.test", 8);
      const robots = [
        "User-agent: Googlebot",
        "Crawl-delay: 5",
        "",
        "User-agent: *",
        "Crawl-delay: 2",
      ].join("\n");

      expect(limiter.parseCrawlDelay(robots)).toBe(2000);
    });

    it("ignores Crawl-delay from specific bot groups", () => {
      const limiter = new DomainLimiter("parse2.test", 8);
      const robots = [
        "User-agent: Bingbot",
        "Crawl-delay: 30",
        "",
        "User-agent: Googlebot",
        "Crawl-delay: 9",
      ].join("\n");

      expect(limiter.parseCrawlDelay(robots)).toBe(0);
    });

    it("honors the * agent inside a multi-user-agent group", () => {
      const limiter = new DomainLimiter("parse3.test", 8);
      const robots = [
        "User-agent: FooBot",
        "User-agent: *",
        "Crawl-delay: 3",
      ].join("\n");

      expect(limiter.parseCrawlDelay(robots)).toBe(3000);
    });

    it("tolerates comments, blank lines and float delays", () => {
      const limiter = new DomainLimiter("parse4.test", 8);
      const robots = [
        "# site config",
        "User-agent: *   # everyone else",
        "Crawl-delay: 1.5 # one and a half seconds",
        "Sitemap: https://site.test/sitemap.xml",
      ].join("\n");

      expect(limiter.parseCrawlDelay(robots)).toBe(1500);
    });

    it("fetches robots.txt and applies only the * group delay", async () => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes("/robots.txt")) {
          return new Response(
            [
              "User-agent: Googlebot",
              "Crawl-delay: 9",
              "",
              "User-agent: *",
              "Crawl-delay: 2",
            ].join("\n"),
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const limiter = new DomainLimiter("robots.test", 8);

      await vi.waitFor(() => expect(limiter.crawlDelay).toBe(2000));
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        "https://robots.test/robots.txt",
      );
    });

    it("blocks requests while the crawl delay is pending", () => {
      const limiter = new DomainLimiter("delay.test", 8);
      limiter.crawlDelay = 5000;

      limiter.startRequest();

      expect(limiter.canMakeRequest()).toBe(false);
      expect(limiter.getWaitTime()).toBeGreaterThan(4000);
    });

    it("allows requests once the crawl delay has elapsed", () => {
      const limiter = new DomainLimiter("delay2.test", 8);
      limiter.crawlDelay = 50;
      limiter.startRequest();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(limiter.canMakeRequest()).toBe(true);
          resolve();
        }, 60);
      });
    });
  });

  describe("connection pool saturation (task 6.7)", () => {
    it("returns a bounded backoff when the pool is saturated", () => {
      const limiter = new DomainLimiter("pool-sat.test", 8);
      limiter.activeConnections = limiter.connectionPoolSize;

      expect(limiter.canMakeRequest()).toBe(false);
      const wait = limiter.getWaitTime();
      // A real, bounded backoff — not 0 (which degraded into minimum-tick
      // polling in the queue).
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(100);
    });

    it("returns 0 when the pool still has a free slot", () => {
      const limiter = new DomainLimiter("pool-free.test", 8);
      limiter.activeConnections = limiter.connectionPoolSize - 1;

      expect(limiter.canMakeRequest()).toBe(true);
      expect(limiter.getWaitTime()).toBe(0);
    });
  });

  describe("DomainLimiterFactory", () => {
    it("returns the same limiter per domain", () => {
      const a = DomainLimiterFactory.getLimiter("factory.test");
      const b = DomainLimiterFactory.getLimiter("factory.test");
      expect(a).toBe(b);
      expect(a.maxRequestsPerSecond).toBe(8);
    });

    it("resetAll drops per-domain state", () => {
      const first = DomainLimiterFactory.getLimiter("factory2.test", 4);
      first.maxRequestsPerSecond = 1;

      DomainLimiterFactory.resetAll();

      const second = DomainLimiterFactory.getLimiter("factory2.test", 4);
      expect(second).not.toBe(first);
      expect(second.maxRequestsPerSecond).toBe(4);
    });
  });
});
