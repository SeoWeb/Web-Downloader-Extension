import { LinkedPageScraper } from "./linked-page-scraper";

let currentScraper: LinkedPageScraper | null = null;

export function setCurrentScraper(scraper: LinkedPageScraper | null) {
  currentScraper = scraper;
}

export function pauseScraping() {
  if (currentScraper) {
    currentScraper.pause();
  }
}

export function resumeScraping() {
  if (currentScraper) {
    currentScraper.resume();
  }
}

export function stopScraping() {
  if (currentScraper) {
    currentScraper.stop();
  }
}
