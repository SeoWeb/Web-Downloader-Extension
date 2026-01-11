import { db, DownloadSession } from './database';

export class SessionManager {
  static async createSession(baseUrl: string): Promise<string> {
    const id = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const session: DownloadSession = {
      id,
      baseUrl,
      totalFiles: 0,
      totalSize: 0,
      status: 'scraping',
      startTime: Date.now()
    };

    await db.sessions.add(session);
    return id;
  }

  static async updateSession(
    id: string,
    updates: Partial<DownloadSession>
  ): Promise<void> {
    await db.sessions.update(id, updates);
  }

  static async getSession(id: string): Promise<DownloadSession | undefined> {
    return await db.sessions.get(id);
  }

  static async completeSession(id: string): Promise<void> {
    await db.sessions.update(id, {
      status: 'complete',
      endTime: Date.now()
    });
  }

  static async failSession(id: string, error: string): Promise<void> {
    await db.sessions.update(id, {
      status: 'failed',
      endTime: Date.now(),
      error
    });
  }

  // Phase 9: Pause/Resume support
  static async pauseSession(id: string): Promise<void> {
    const session = await db.sessions.get(id);
    if (!session) throw new Error('Session not found');
    
    await db.sessions.update(id, {
      status: 'paused',
      pausedAt: Date.now()
    });
  }

  static async resumeSession(id: string): Promise<void> {
    const session = await db.sessions.get(id);
    if (!session || session.status !== 'paused') {
      throw new Error('Cannot resume session');
    }
    
    await db.sessions.update(id, {
      status: 'scraping',
      resumedAt: Date.now()
    });
  }

  static async saveScrapingProgress(
    id: string,
    progress: DownloadSession['scrapingProgress']
  ): Promise<void> {
    await db.sessions.update(id, { scrapingProgress: progress });
  }

  static async getResumableSession(baseUrl: string): Promise<DownloadSession | undefined> {
    const sessions = await db.sessions
      .where('baseUrl')
      .equals(baseUrl)
      .and(s => s.status === 'paused')
      .toArray();
    
    return sessions[0]; // Return most recent paused session
  }
}
