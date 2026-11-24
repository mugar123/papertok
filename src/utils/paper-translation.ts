// The language an account chose for the removed title-and-abstract
// translation. Nothing reads or writes it now. Browsers that used it may still
// hold it, so loading, changing or deleting the account clears it.
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
