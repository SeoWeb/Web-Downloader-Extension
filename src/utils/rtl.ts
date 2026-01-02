// RTL (Right-to-Left) utilities
import { isRTLLanguage } from '../i18n/languages';


/**
 * Get text direction for a language
 */
export const getTextDirection = (languageCode: string): 'rtl' | 'ltr' => {
  return isRTLLanguage(languageCode) ? 'rtl' : 'ltr';
};

/**
 * Apply text direction to the document root
 */
export const applyDirectionToDocument = (languageCode: string): void => {
  const direction = getTextDirection(languageCode);
  document.documentElement.setAttribute('dir', direction);
  document.documentElement.setAttribute('lang', languageCode);
};
