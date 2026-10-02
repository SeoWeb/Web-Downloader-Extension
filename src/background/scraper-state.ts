import { LinkedPageScraper } from "./linked-page-scraper";

const scrapers = new Map<number, LinkedPageScraper>();

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
