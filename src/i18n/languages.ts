// Language metadata and configuration
export interface Language {
  code: string;
  name: string;
  nativeName: string;
  isRTL: boolean;
  region: string;
}

export const languages: Language[] = [
  // Europe
  { code: 'en', name: 'English', nativeName: 'English', isRTL: false, region: 'Europe' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', isRTL: false, region: 'Europe' },
  { code: 'fr', name: 'French', nativeName: 'Français', isRTL: false, region: 'Europe' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', isRTL: false, region: 'Europe' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', isRTL: false, region: 'Europe' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', isRTL: false, region: 'Europe' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', isRTL: false, region: 'Europe' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', isRTL: false, region: 'Europe' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', isRTL: false, region: 'Europe' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română', isRTL: false, region: 'Europe' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά', isRTL: false, region: 'Europe' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština', isRTL: false, region: 'Europe' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', isRTL: false, region: 'Europe' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar', isRTL: false, region: 'Europe' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi', isRTL: false, region: 'Europe' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk', isRTL: false, region: 'Europe' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk', isRTL: false, region: 'Europe' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina', isRTL: false, region: 'Europe' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', isRTL: false, region: 'Europe' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski', isRTL: false, region: 'Europe' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски', isRTL: false, region: 'Europe' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių', isRTL: false, region: 'Europe' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina', isRTL: false, region: 'Europe' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu', isRTL: false, region: 'Europe' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti', isRTL: false, region: 'Europe' },
  
  // Asia
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', isRTL: false, region: 'Asia' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা', isRTL: false, region: 'Asia' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو', isRTL: true, region: 'Asia' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', isRTL: false, region: 'Asia' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', isRTL: false, region: 'Asia' },
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文', isRTL: false, region: 'Asia' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文', isRTL: false, region: 'Asia' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', isRTL: false, region: 'Asia' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', isRTL: false, region: 'Asia' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', isRTL: false, region: 'Asia' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', isRTL: false, region: 'Asia' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', isRTL: false, region: 'Asia' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', isRTL: false, region: 'Asia' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', isRTL: false, region: 'Asia' },
  
  // Middle East
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', isRTL: true, region: 'Middle East' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית', isRTL: true, region: 'Middle East' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی', isRTL: true, region: 'Middle East' },
  
  // Americas
  { code: 'pt-BR', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', isRTL: false, region: 'Americas' },
  
  // Southeast Asia & Pacific
  { code: 'fil', name: 'Filipino', nativeName: 'Filipino', isRTL: false, region: 'Southeast Asia' },
  
  // Africa
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili', isRTL: false, region: 'Africa' },
];

// RTL languages list
export const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

// Check if a language is RTL
export const isRTLLanguage = (languageCode: string): boolean => {
  return RTL_LANGUAGES.includes(languageCode);
};

// Get text direction for a language
export const getTextDirection = (languageCode: string): 'rtl' | 'ltr' => {
  return isRTLLanguage(languageCode) ? 'rtl' : 'ltr';
};

// Get language by code
export const getLanguageByCode = (code: string): Language | undefined => {
  return languages.find(lang => lang.code === code);
};

// Group languages by region
export const getLanguagesByRegion = (): Record<string, Language[]> => {
  return languages.reduce((acc, lang) => {
    if (!acc[lang.region]) {
      acc[lang.region] = [];
    }
    acc[lang.region].push(lang);
    return acc;
  }, {} as Record<string, Language[]>);
};
