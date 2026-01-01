import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { applyDirectionToDocument } from '../utils/rtl';

// Import all translation files
import en from './locales/en.json';
import ar from './locales/ar.json';
import bg from './locales/bg.json';
import bn from './locales/bn.json';
import cs from './locales/cs.json';
import da from './locales/da.json';
import de from './locales/de.json';
import el from './locales/el.json';
import es from './locales/es.json';
import et from './locales/et.json';
import fa from './locales/fa.json';
import fi from './locales/fi.json';
import fil from './locales/fil.json';
import fr from './locales/fr.json';
import he from './locales/he.json';
import hi from './locales/hi.json';
import hr from './locales/hr.json';
import hu from './locales/hu.json';
import id from './locales/id.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import lt from './locales/lt.json';
import lv from './locales/lv.json';
import ms from './locales/ms.json';
import nl from './locales/nl.json';
import no from './locales/no.json';
import pl from './locales/pl.json';
import pt from './locales/pt.json';
import ptBR from './locales/pt-BR.json';
import ro from './locales/ro.json';
import ru from './locales/ru.json';
import sk from './locales/sk.json';
import sl from './locales/sl.json';
import sr from './locales/sr.json';
import sv from './locales/sv.json';
import sw from './locales/sw.json';
import ta from './locales/ta.json';
import th from './locales/th.json';
import tr from './locales/tr.json';
import uk from './locales/uk.json';
import ur from './locales/ur.json';
import vi from './locales/vi.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

// Translation resources
const resources = {
  en,
  ar,
  bg,
  bn,
  cs,
  da,
  de,
  el,
  es,
  et,
  fa,
  fi,
  fil,
  fr,
  he,
  hi,
  hr,
  hu,
  id,
  it,
  ja,
  ko,
  lt,
  lv,
  ms,
  nl,
  no,
  pl,
  pt,
  'pt-BR': ptBR,
  ro,
  ru,
  sk,
  sl,
  sr,
  sv,
  sw,
  ta,
  th,
  tr,
  uk,
  ur,
  vi,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};


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
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    resources,
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
