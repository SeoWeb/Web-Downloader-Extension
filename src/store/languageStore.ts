// src/store/languageStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { chromeStorage } from '../common/chrome/storage';
import { getUiLanguage, LanguageCode, loadMessages } from '../common/chrome/getTranslation';

export type LanguageDirection = "ltr" | "rtl";
export type Translation = {
  message: string;
  description?: string;
};

interface LanguageState {
  currentLanguage: LanguageCode;
  direction: LanguageDirection;
  translations: Record<string, Translation>;
  setLanguage: (language: LanguageCode) => void;
  getTranslation: (key: string, substitutions?: any) => string;
}

const getDirection = (langCode: LanguageCode): LanguageDirection => {
  // Add more RTL languages here if needed
  if (langCode === "ur" || langCode === "he") {
    return "rtl";
  }
  return "ltr";
};


const defaultLanguage = getUiLanguage();
const defaultDirection = getDirection(defaultLanguage);

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      currentLanguage: defaultLanguage,
      direction: defaultDirection,
      translations: {},
      setLanguage: (language) => {
        set({
          currentLanguage: language,
          direction: getDirection(language),
        });
        loadMessages(language).then((translations) => {
          if (translations) {
            set({ translations });
          }
        }
        );
      },
      getTranslation: (key, substitutions) => {
        const { translations } = get();
        if (translations[key]) {
          return translations[key].message;
        }
        // Fallback to chrome.i18n.getMessage if not found in translations
        // This is useful for keys that are not in the messages.json file
        // or for dynamic keys
        // that are not part of the static translation file
        const message = chrome.i18n.getMessage(key, substitutions);
        if (message) {
          return message;
        } else {
          return key; // Fallback to the key itself if translation is not found
        }
      }
    }),
    {
      name: 'language-settings-storage', // unique name
      storage: createJSONStorage(() => chromeStorage), // Use chrome.storage.local
    },
  ),
);