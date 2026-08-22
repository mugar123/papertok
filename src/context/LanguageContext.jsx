/* eslint-disable react-refresh/only-export-components */
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { LanguageContext } from './contexts';
import { useAuth } from './AuthContext';

const LANGUAGE_STORAGE_KEY = 'papertok_language';
const LANGUAGE_MODE_STORAGE_KEY = 'papertok_language_mode';
const SUPPORTED_LANGUAGES = new Set(['es', 'en']);

function normalizeLanguage(value) {
  return SUPPORTED_LANGUAGES.has(value) ? value : 'en';
}

function readStoredManualLanguage() {
  try {
    const language = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    const mode = window.localStorage.getItem(LANGUAGE_MODE_STORAGE_KEY);
    return mode === 'manual' && SUPPORTED_LANGUAGES.has(language) ? language : null;
  } catch {
    return null;
  }
}

function readStoredLanguage() {
  try {
    const language = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return SUPPORTED_LANGUAGES.has(language) ? language : null;
  } catch {
    return null;
  }
}

function persistLanguage(language) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    window.localStorage.setItem(LANGUAGE_MODE_STORAGE_KEY, 'manual');
  } catch {
    // The active language still works for this session if storage is unavailable.
  }
}

export function LanguageProvider({ children }) {
  const { user, readingPreferences, updateReadingPreferences } = useAuth();
  const [guestManualLanguage, setGuestManualLanguage] = useState(readStoredManualLanguage);
  // Keep the initial protected-route loader in the user's last chosen language.
  // The Firestore profile is loaded asynchronously, after that loader is visible.
  const [detectedLanguage] = useState(
    () => readStoredLanguage() || 'en',
  );
  const accountManualLanguage = user
    && readingPreferences?.languagePreferenceSet === true
    && SUPPORTED_LANGUAGES.has(readingPreferences?.language)
    ? readingPreferences.language
    : null;
  const manualLanguage = accountManualLanguage || guestManualLanguage;
  const language = manualLanguage || detectedLanguage;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    if (accountManualLanguage) persistLanguage(accountManualLanguage);
  }, [accountManualLanguage]);

  const setLanguage = useCallback(async (nextLanguage) => {
    const normalized = normalizeLanguage(nextLanguage);
    setGuestManualLanguage(normalized);
    persistLanguage(normalized);

    if (user) {
      await updateReadingPreferences({ language: normalized, languagePreferenceSet: true });
    }
  }, [updateReadingPreferences, user]);

  const value = useMemo(() => ({
    language,
    locale: language === 'en' ? 'en-US' : 'es-ES',
    isEnglish: language === 'en',
    setLanguage,
  }), [language, setLanguage]);

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
