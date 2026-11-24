import { isTranslationLanguage, type TranslationLanguage } from './full-paper-translation-contract.ts';

export function getTranslationLanguageStorageKey(uid: string) {
  return `papertok:paper-translation-language:${uid}`;
}

export function preferredTranslationLanguage(uid: string): TranslationLanguage | '' {
  try {
    const saved = globalThis.window?.localStorage.getItem(getTranslationLanguageStorageKey(uid));
    if (isTranslationLanguage(saved)) return saved;
  } catch {
    // The picker can still use browser languages when storage is blocked.
  }
  for (const tag of globalThis.navigator?.languages ?? []) {
    const [language, ...subtags] = tag.toLowerCase().split('-');
    if (language === 'zh') {
      if (subtags.includes('hans')) return 'zh-Hans';
      return subtags.some(subtag => ['hant', 'tw', 'hk', 'mo'].includes(subtag)) ? 'zh-Hant' : 'zh-Hans';
    }
    if (language === 'iw') return 'he';
    if (isTranslationLanguage(language)) return language;
  }
  return '';
}

export function forgetTranslationLanguage(uid: string, storage?: Pick<Storage, 'removeItem'> | null) {
  try {
    (storage ?? (typeof window === 'undefined' ? null : window.localStorage))?.removeItem(getTranslationLanguageStorageKey(uid));
  } catch {
    // Storage cleanup must not interrupt account deletion.
  }
}
