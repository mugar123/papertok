// The language an account last chose for a paper translation. Nothing writes
// it now, but browsers that used the title-and-abstract translation still
// hold it, so an account change or deletion clears it.
export function getTranslationLanguageStorageKey(uid: string) {
  return `papertok:paper-translation-language:${uid}`;
}

export function forgetTranslationLanguage(uid: string, storage?: Pick<Storage, 'removeItem'> | null) {
  try {
    (storage ?? (typeof window === 'undefined' ? null : window.localStorage))?.removeItem(getTranslationLanguageStorageKey(uid));
  } catch {
    // Storage cleanup must not interrupt account deletion.
  }
}
