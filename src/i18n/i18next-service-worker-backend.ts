import type { BackendModule, ReadCallback, Services, InitOptions } from 'i18next';

/**
 * Service worker-compatible i18next backend that uses fetch instead of dynamic imports
 * This avoids Vite's dynamic import() which can introduce window references
 */
class ServiceWorkerBackend implements BackendModule<object> {
  static type = 'backend' as const;
  type = 'backend' as const;

  private cache: Map<string, any> = new Map();

  init(_services: Services, _backendOptions: object, _i18nextOptions: InitOptions): void {
    // No initialization needed
  }

  read(language: string, namespace: string, callback: ReadCallback): void {
    // Check cache first
    const cacheKey = `${language}-${namespace}`;
    if (this.cache.has(cacheKey)) {
      callback(null, this.cache.get(cacheKey));
      return;
    }

    // Use fetch to load locale files (works in service workers)
    this.loadLocale(language)
      .then((data) => {
        this.cache.set(cacheKey, data);
        callback(null, data);
      })
      .catch((error) => {
        console.error(`Failed to load locale ${language}:`, error);
        // Fallback to empty object to prevent blocking
        callback(null, {});
      });
  }

  private async loadLocale(language: string): Promise<any> {
    try {
      // Map of supported languages
      const supportedLanguages = [
        'en', 'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'es', 'et',
        'fa', 'fi', 'fil', 'fr', 'he', 'hi', 'hr', 'hu', 'id', 'it',
        'ja', 'ko', 'lt', 'lv', 'ms', 'nl', 'no', 'pl', 'pt', 'pt-BR',
        'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'sw', 'ta', 'th', 'tr',
        'uk', 'ur', 'vi', 'zh-CN', 'zh-TW'
      ];

      let targetLanguage = language;
      
      // If exact language not found, try base language (e.g., en-US -> en)
      if (!supportedLanguages.includes(targetLanguage) && targetLanguage.includes('-')) {
        const baseLanguage = targetLanguage.split('-')[0];
        if (supportedLanguages.includes(baseLanguage)) {
          targetLanguage = baseLanguage;
        }
      }

      // Special case for 'zh' -> 'zh-CN'
      if (targetLanguage === 'zh') {
        targetLanguage = 'zh-CN';
      }

      if (!supportedLanguages.includes(targetLanguage)) {
        throw new Error(`Locale ${language} not found`);
      }

      // Fetch the locale file from the extension's own resources
      // In service worker context, we can use chrome.runtime.getURL
      const localeUrl = chrome.runtime.getURL(`locales/${targetLanguage}.json`);
      const response = await fetch(localeUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch locale ${targetLanguage}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // The locale files have structure: { "translation": { ... } }
      // We need to return just the translation object for the "translation" namespace
      return data.translation || data;
    } catch (error) {
      console.error(`Error loading locale ${language}:`, error);
      throw error;
    }
  }
}

export default ServiceWorkerBackend;
