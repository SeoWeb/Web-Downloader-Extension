import i18n from 'i18next';
import ServiceWorkerBackend from './i18next-service-worker-backend';

// In-memory cache for language (synchronous access)
let cachedLanguage: string | undefined;

// Initialize cache from storage on module load
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get(['language'], (result) => {
    if (result.language) {
      cachedLanguage = result.language;
      // If i18n is already initialized and language differs, update it
      if (i18n.isInitialized && result.language !== i18n.language) {
        i18n.changeLanguage(result.language);
      }
    }
  });
}

// Simple language detector for service worker (no browser APIs)
const serviceWorkerDetector = {
  name: 'serviceWorkerStorage',
  
  lookup(): string | undefined {
    return cachedLanguage;
  },
  
  cacheUserLanguage(lng: string): void {
    cachedLanguage = lng;
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ language: lng });
    }
  }
};

// Initialize i18n for service worker context (no browser-specific features)
i18n
  .use(ServiceWorkerBackend)
  .use({
    type: 'languageDetector',
    init: () => {},
    detect: () => serviceWorkerDetector.lookup() || 'en',
    cacheUserLanguage: (lng: string) => serviceWorkerDetector.cacheUserLanguage(lng)
  })
  .init({
    fallbackLng: 'en',
    
    interpolation: {
      escapeValue: false,
    },
    
    react: {
      useSuspense: false,
    },
  });

export default i18n;
