/**
 * i18n hook — instant language switching without page refresh.
 * Language is persisted in IndexedDB settings and applied instantly
 * via React state (no reload needed).
 */
import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { translate, translations } from './translations';
import { LANGUAGES, DEFAULT_LANGUAGE } from './types';
import type { LanguageCode, LanguageInfo } from './types';
import { loadSettings, patchSettings } from '../wallet/storage';

interface I18nContextValue {
  lang: LanguageCode;
  setLang: (lang: LanguageCode) => Promise<void>;
  t: (key: string) => string;
  languages: LanguageInfo[];
  currentLanguage: LanguageInfo;
  isRTL: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<LanguageCode>(DEFAULT_LANGUAGE);

  // Load language from settings on mount
  useEffect(() => {
    loadSettings()
      .then((s) => {
        const storedLang = (s as { language?: string }).language as LanguageCode | undefined;
        if (storedLang && translations[storedLang]) {
          setLangState(storedLang);
        }
      })
      .catch(() => {});
  }, []);

  // Apply RTL/LTR direction
  useEffect(() => {
    const langInfo = LANGUAGES.find((l) => l.code === lang);
    document.documentElement.dir = langInfo?.rtl ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback(async (newLang: LanguageCode) => {
    // Apply instantly in-memory so the whole tree re-renders immediately.
    setLangState(newLang);
    try {
      // Merge-only write: never clobber concurrently-changed settings
      // (e.g. the network switcher writing rpcUrl at the same time).
      await patchSettings({ language: newLang });
    } catch {
      // Settings not yet available — language still applied in-memory
    }
  }, []);

  const t = useCallback((key: string) => translate(lang, key), [lang]);

  const currentLanguage = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0]!;
  const isRTL = currentLanguage?.rtl ?? false;

  return (
    <I18nContext.Provider
      value={{ lang, setLang, t, languages: LANGUAGES, currentLanguage, isRTL }}
    >
      {children}
    </I18nContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fallback if used outside provider — return English
    return {
      lang: DEFAULT_LANGUAGE,
      setLang: async () => {},
      t: (key: string) => translate(DEFAULT_LANGUAGE, key),
      languages: LANGUAGES,
      currentLanguage: LANGUAGES[0]!,
      isRTL: false,
    };
  }
  return ctx;
}
