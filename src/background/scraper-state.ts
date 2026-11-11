import { LinkedPageScraper } from "./linked-page-scraper";
import { setKeepaliveDisconnectHook } from "./download-state";

const scrapers = new Map<number, LinkedPageScraper>();

// (multipage-download-fixes D2 / task 4.1) When a tab's keepalive port
// disconnects, the side panel is gone — that alone no longer stops a paused
// scraper. While the worker lives, a reopened panel re-attaches a fresh port
// and its Resume/Stop commands still reach the scraper here (the map is
// keyed by the ORIGINAL tab id, which pause/resume messages carry). If the
// worker itself dies while the pause is held, the download parks (checkpoint
// phase `paused` + queue snapshot) and the parked path (SCRAPER_RESUME_FROM_PARK
// / parked Stop) takes over. The hook is a logged no-op, kept so the
// disconnect plumbing stays observable.
setKeepaliveDisconnectHook((tabId) => {
  scrapers.get(tabId)?.handleKeepaliveDisconnect();
});

export function setCurrentScraper(
  tabId: number,
  scraper: LinkedPageScraper | null,
) {
  if (scraper === null) {
    scrapers.delete(tabId);
  } else {
    scrapers.set(tabId, scraper);
  }
}

export function pauseScraping(tabId: number) {
  scrapers.get(tabId)?.pause();
}

export function resumeScraping(tabId: number) {
  scrapers.get(tabId)?.resume();
}

export function stopScraping(tabId: number) {
  scrapers.get(tabId)?.stop();
}

export function deleteScraper(tabId: number) {
  scrapers.delete(tabId);
}
