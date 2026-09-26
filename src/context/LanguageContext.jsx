/* eslint-disable react-refresh/only-export-components */
import { useContext, useEffect } from 'react';
import { LanguageContext } from './contexts';

// PaperTok's interface is English only. The context stays so that the places
// that pass the language on — the Worker's AI explanations and emails, date
// and number formatting, Wikipedia lookups — keep one source for it instead
// of a literal scattered through the code.
const VALUE = Object.freeze({ language: 'en', locale: 'en-US' });

export function LanguageProvider({ children }) {
  useEffect(() => {
    document.documentElement.lang = VALUE.language;
  }, []);

  return (
    <LanguageContext.Provider value={VALUE}>
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
