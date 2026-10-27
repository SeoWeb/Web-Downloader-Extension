import { LinkedPageScraper } from "./linked-page-scraper";
import { setKeepaliveDisconnectHook } from "./download-state";

const scrapers = new Map<number, LinkedPageScraper>();

// (D2 — paused-scraper liveness / task 2.1) When a tab's keepalive port
// disconnects, the side panel is gone: nobody can send SCRAPER_RESUME or
// SCRAPER_STOP anymore. Resolve that tab's paused scraper wait with STOP
// semantics (safe default — finalize the download rather than hang).
// Idempotent: a no-op when the scraper is not paused (panel reopened and
// resumed before the event, or already stopped).
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
