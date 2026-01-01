// RTL (Right-to-Left) utilities
import { RTL_LANGUAGES } from '../i18n/languages';

/**
 * Check if a language code represents an RTL language
 */
export const isRTLLanguage = (languageCode: string): boolean => {
  return RTL_LANGUAGES.includes(languageCode);
};

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

/**
 * Get the opposite direction
 */
export const getOppositeDirection = (direction: 'rtl' | 'ltr'): 'rtl' | 'ltr' => {
  return direction === 'rtl' ? 'ltr' : 'rtl';
};
