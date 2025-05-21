export const languages: Record<string, string> = {
  zh: "Chinese",
  es: "Spanish",
  en: "English",
  hi: "Hindi",
  bn: "Bengali",
  pt: "Portuguese",
  ur: "Urdu",
  fr: "French",
  id: "Indonesian",
  ru: "Russian",
  vi: "Vietnamese",
  tr: "Turkish",
  de: "German",
  it: "Italian",
  pl: "Polish",
  fil: "Filipino",
  nl: "Dutch",
  he: "Hebrew",
  pa: 'pa',
  ja: 'ja',
  ar: 'ar',
  mr: 'mr',
  te: 'te',
  ta: 'ta',
  ko: 'ko',
  fa: 'fa',
  gu: 'gu',
  th: 'th'
};

export type LanguageCode = keyof typeof languages;

export function getUiLanguage(): LanguageCode {
  const lang = chrome.i18n.getUILanguage();
  const langCode = lang.split("-")[0] as LanguageCode;
  const language = languages[langCode] ? langCode : "en"; // Default to English if not found
  loadMessages(language);
  return language;
}

export async function loadMessages(locale = "en") {
  let messages: Record<
    string,
    {
      message: string;
      description?: string;
    }
  > = {};
  try {
    const url = chrome.runtime.getURL("/_locales/" + locale + "/messages.json");
    const response = await fetch(url);
    messages = await response.json();
    document.documentElement.lang = locale;
  } catch (e) {}
  return messages;
}
