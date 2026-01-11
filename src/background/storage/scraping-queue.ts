import { db, ScrapingQueue } from './database';

export class ScrapingQueueManager {
  /**
   * Add URL to scraping queue
   */
  static async enqueue(
    sessionId: string,
    url: string,
    depth: number,
    parentUrl?: string
  ): Promise<void> {
    const id = `${sessionId}-${url}`;
    
    // Check if already exists
    const existing = await db.scrapingQueue.get(id);
    if (existing) return;

    await db.scrapingQueue.add({
      id,
      sessionId,
      url,
      depth,
      parentUrl,
      status: 'pending',
      addedAt: Date.now(),
      retryCount: 0
    });
  }

  /**
   * Get next URL to scrape
   */
  static async dequeue(sessionId: string): Promise<ScrapingQueue | null> {
    const items = await db.scrapingQueue
      .where('sessionId')
      .equals(sessionId)
      .and(item => item.status === 'pending')
      .sortBy('depth'); // Breadth-first scraping

    if (items.length === 0) return null;

    const item = items[0];
    await db.scrapingQueue.update(item.id, {
      status: 'scraping'
    });

    return item;
  }

  /**
   * Mark URL as completed
   */
  static async markCompleted(id: string): Promise<void> {
    await db.scrapingQueue.update(id, {
      status: 'completed',
      scrapedAt: Date.now()
    });
  }

  /**
   * Mark URL as failed
   */
  static async markFailed(id: string, error: string): Promise<void> {
    const item = await db.scrapingQueue.get(id);
    if (!item) return;

    if (item.retryCount < 3) {
      // Retry
      await db.scrapingQueue.update(id, {
        status: 'pending',
        retryCount: item.retryCount + 1,
        error
      });
    } else {
      // Give up
      await db.scrapingQueue.update(id, {
        status: 'failed',
        error
      });
    }
  }

  /**
   * Get queue statistics
   */
  static async getStats(sessionId: string): Promise<{
    total: number;
    pending: number;
    completed: number;
    failed: number;
  }> {
    const items = await db.scrapingQueue
      .where('sessionId')
      .equals(sessionId)
      .toArray();

    return {
      total: items.length,
      pending: items.filter(i => i.status === 'pending').length,
      completed: items.filter(i => i.status === 'completed').length,
      failed: items.filter(i => i.status === 'failed').length
    };
  }

  /**
   * Clear completed items (cleanup)
   */
  static async clearCompleted(sessionId: string): Promise<void> {
    await db.scrapingQueue
      .where('sessionId')
      .equals(sessionId)
      .and(item => item.status === 'completed')
      .delete();
  }
}
