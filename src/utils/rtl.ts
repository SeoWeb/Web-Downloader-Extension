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
 * Only works in browser context (not in service workers)
 */
export const applyDirectionToDocument = (languageCode: string): void => {
  // Check if we're in a browser context with document available
  if (typeof document === 'undefined') {
    return; // Skip in service worker context
  }
  
  const direction = getTextDirection(languageCode);
  document.documentElement.setAttribute('dir', direction);
  document.documentElement.setAttribute('lang', languageCode);
};
