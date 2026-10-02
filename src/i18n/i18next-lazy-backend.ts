import type {
  BackendModule,
  ReadCallback,
  Services,
  InitOptions,
} from "i18next";

/**
 * Custom i18next backend that loads locale files dynamically using Vite's import()
 * This prevents bundling all 45 locale files and instead loads them on-demand
 */
class LazyLocaleBackend implements BackendModule<object> {
  static type = "backend" as const;
  type = "backend" as const;

  private cache: Map<string, any> = new Map();

  init(
    _services: Services,
    _backendOptions: object,
    _i18nextOptions: InitOptions,
  ): void {
    // No initialization needed - using underscore prefix to indicate intentionally unused parameters
  }

  read(language: string, namespace: string, callback: ReadCallback): void {
    // Check cache first
    const cacheKey = `${language}-${namespace}`;
    if (this.cache.has(cacheKey)) {
      callback(null, this.cache.get(cacheKey));
      return;
    }

    // Dynamically import the locale file
    this.loadLocale(language)
      .then((data) => {
        this.cache.set(cacheKey, data);
        callback(null, data);
      })
      .catch((error) => {
        callback(error, null);
      });
  }

  private async loadLocale(language: string): Promise<any> {
    try {
      // Map language codes to file paths
      const localeMap: Record<string, () => Promise<any>> = {
        en: () => import("./locales/en.json"),
        ar: () => import("./locales/ar.json"),
        bg: () => import("./locales/bg.json"),
        bn: () => import("./locales/bn.json"),
        cs: () => import("./locales/cs.json"),
        da: () => import("./locales/da.json"),
        de: () => import("./locales/de.json"),
        el: () => import("./locales/el.json"),
        es: () => import("./locales/es.json"),
        et: () => import("./locales/et.json"),
        fa: () => import("./locales/fa.json"),
        fi: () => import("./locales/fi.json"),
        fil: () => import("./locales/fil.json"),
        fr: () => import("./locales/fr.json"),
        he: () => import("./locales/he.json"),
        hi: () => import("./locales/hi.json"),
        hr: () => import("./locales/hr.json"),
        hu: () => import("./locales/hu.json"),
        id: () => import("./locales/id.json"),
        it: () => import("./locales/it.json"),
        ja: () => import("./locales/ja.json"),
        ko: () => import("./locales/ko.json"),
        lt: () => import("./locales/lt.json"),
        lv: () => import("./locales/lv.json"),
        ms: () => import("./locales/ms.json"),
        nl: () => import("./locales/nl.json"),
        no: () => import("./locales/no.json"),
        pl: () => import("./locales/pl.json"),
        pt: () => import("./locales/pt.json"),
        "pt-BR": () => import("./locales/pt-BR.json"),
        ro: () => import("./locales/ro.json"),
        ru: () => import("./locales/ru.json"),
        sk: () => import("./locales/sk.json"),
        sl: () => import("./locales/sl.json"),
        sr: () => import("./locales/sr.json"),
        sv: () => import("./locales/sv.json"),
        sw: () => import("./locales/sw.json"),
        ta: () => import("./locales/ta.json"),
        th: () => import("./locales/th.json"),
        tr: () => import("./locales/tr.json"),
        uk: () => import("./locales/uk.json"),
        ur: () => import("./locales/ur.json"),
        vi: () => import("./locales/vi.json"),
        "zh-CN": () => import("./locales/zh-CN.json"),
        "zh-TW": () => import("./locales/zh-TW.json"),
        zh: () => import("./locales/zh-CN.json"),
      };

      let loader = localeMap[language];

      // If exact language not found, try base language (e.g., en-US -> en)
      if (!loader && language.includes("-")) {
        const baseLanguage = language.split("-")[0];
        loader = localeMap[baseLanguage];
      }

      if (!loader) {
        throw new Error(`Locale ${language} not found`);
      }

      const module = await loader();
      const data = module.default || module;

      // The locale files have structure: { "translation": { ... } }
      // We need to return just the translation object for the "translation" namespace
      return data.translation || data;
    } catch (error) {
      throw error;
    }
  }
}

export default LazyLocaleBackend;
