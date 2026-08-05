/**
 * i18n types and language registry.
 * Supports 20 world languages with instant switching (no page refresh).
 */

export type LanguageCode =
  | 'en'
  | 'zh'
  | 'hi'
  | 'es'
  | 'fr'
  | 'ar'
  | 'bn'
  | 'ru'
  | 'pt'
  | 'id'
  | 'ur'
  | 'de'
  | 'ja'
  | 'sw'
  | 'tr'
  | 'ko'
  | 'ta'
  | 'it'
  | 'th'
  | 'vi';

export interface LanguageInfo {
  code: LanguageCode;
  name: string; // Native name
  englishName: string;
  flag: string;
  rtl?: boolean; // Right-to-left
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', englishName: 'English', flag: '🇺🇸' },
  { code: 'zh', name: '中文', englishName: 'Chinese', flag: '🇨🇳' },
  { code: 'hi', name: 'हिन्दी', englishName: 'Hindi', flag: '🇮🇳' },
  { code: 'es', name: 'Español', englishName: 'Spanish', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', englishName: 'French', flag: '🇫🇷' },
  { code: 'ar', name: 'العربية', englishName: 'Arabic', flag: '🇸🇦', rtl: true },
  { code: 'bn', name: 'বাংলা', englishName: 'Bengali', flag: '🇧🇩' },
  { code: 'ru', name: 'Русский', englishName: 'Russian', flag: '🇷🇺' },
  { code: 'pt', name: 'Português', englishName: 'Portuguese', flag: '🇵🇹' },
  { code: 'id', name: 'Indonesia', englishName: 'Indonesian', flag: '🇮🇩' },
  { code: 'ur', name: 'اردو', englishName: 'Urdu', flag: '🇵🇰', rtl: true },
  { code: 'de', name: 'Deutsch', englishName: 'German', flag: '🇩🇪' },
  { code: 'ja', name: '日本語', englishName: 'Japanese', flag: '🇯🇵' },
  { code: 'sw', name: 'Kiswahili', englishName: 'Swahili', flag: '🇰🇪' },
  { code: 'tr', name: 'Türkçe', englishName: 'Turkish', flag: '🇹🇷' },
  { code: 'ko', name: '한국어', englishName: 'Korean', flag: '🇰🇷' },
  { code: 'ta', name: 'தமிழ்', englishName: 'Tamil', flag: '🇮🇳' },
  { code: 'it', name: 'Italiano', englishName: 'Italian', flag: '🇮🇹' },
  { code: 'th', name: 'ไทย', englishName: 'Thai', flag: '🇹🇭' },
  { code: 'vi', name: 'Tiếng Việt', englishName: 'Vietnamese', flag: '🇻🇳' },
];

export const DEFAULT_LANGUAGE: LanguageCode = 'en';

/** Translation key paths — dot notation for nested keys */
export type TranslationKey = string;

/** Flat translation dictionary */
export type Translations = Record<string, string>;
