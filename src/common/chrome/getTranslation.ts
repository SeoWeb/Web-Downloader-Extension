export const languages: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  vi: "Vietnamese",
  pl: "Polish",
  fil: "Filipino",
  ur: "Urdu",
  he: "Hebrew",
  tr: "Turkish",
  es: "Spanish",
  ru: "Russian",
  pt: "Portuguese",
  it: "Italian",
  de: "German",
  fr: "French",
  zh: "Chinese",
  nl: "Dutch",
  id: "Indonesian",
  bn: "Bengali",
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
