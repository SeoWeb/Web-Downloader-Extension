import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { applyDirectionToDocument } from '../utils/rtl';
import LazyLocaleBackend from './i18next-lazy-backend';

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

// Custom language detector that checks chrome.storage first
const chromeStorageDetector = {
  name: 'chromeStorage',
  
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

const languageDetector = new LanguageDetector();
languageDetector.addDetector(chromeStorageDetector);

i18n
  .use(LazyLocaleBackend)
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    
    detection: {
      order: ['chromeStorage', 'navigator', 'htmlTag'],
      caches: ['chromeStorage'],
    },
    
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    
    react: {
      useSuspense: false,
    },
  });


// Apply direction when language changes
i18n.on('languageChanged', (lng) => {
  applyDirectionToDocument(lng);
});

// Apply direction on initial load
applyDirectionToDocument(i18n.language);

export default i18n;
