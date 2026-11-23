import { useEffect, useRef } from 'react';
import { Translate } from '@phosphor-icons/react';
import type { usePaperTranslation } from '../../hooks/use-paper-translation.ts';
import {
  isTranslationLanguage,
  SOURCE_LANGUAGES,
  TRANSLATION_LANGUAGES,
  type PaperTranslation,
} from '../../utils/paper-translation-contract.ts';
import ScientificText from '../scientific-text.ts';
import { Button } from '../ui/button.tsx';
import './paper-translation.css';

export type PaperTranslationState = ReturnType<typeof usePaperTranslation>;

export function TranslatedPaperText({ translation }: { translation: PaperTranslation }) {
  const { title, abstract, language, sourceLanguage } = translation;
  const target = TRANSLATION_LANGUAGES[language];
  const label = sourceLanguage ? `${SOURCE_LANGUAGES[sourceLanguage]} to ${target}` : target;
  return (
    <span className="paper-translation-text" translate="no">
      <span className="paper-translation-label" lang="en">AI translation · {label}</span>
      <span lang={language} dir="auto" className="paper-translation-title"><ScientificText>{title}</ScientificText></span>
      <span lang={language} dir="auto" className="paper-translation-abstract"><ScientificText>{abstract}</ScientificText></span>
    </span>
  );
}

export function PaperTranslationButton({ state, onAuthRequired, onChooseLanguage }: {
  state: PaperTranslationState;
  onAuthRequired: () => void;
  onChooseLanguage: () => void;
}) {
  if (!state.eligible) return null;
  const { pending, showing, translation } = state.current;
  return (
    <Button
      type="button"
      variant="ghost"
      size={showing ? 'sm' : 'icon-sm'}
      className="paper-translation-button"
      translate="no"
      aria-label={showing ? undefined : 'Translate'}
      aria-disabled={pending}
      aria-busy={pending}
      onClick={() => {
        if (pending) return;
        if (!state.signedIn) {
          onAuthRequired();
        } else if (showing) {
          state.showOriginal();
        } else {
          const language = state.chooseLanguage() || translation?.language;
          if (language) void state.translate(language);
          else onChooseLanguage();
        }
      }}
    >
      {showing ? <span>Show original</span> : <Translate aria-hidden="true" />}
    </Button>
  );
}

export function PaperTranslationPicker({ state, focusRequested, onFocus }: {
  state: PaperTranslationState;
  focusRequested?: boolean;
  onFocus?: () => void;
}) {
  const picker = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (focusRequested) picker.current?.focus();
  }, [focusRequested]);
  if (!state.eligible || !state.signedIn) return null;
  return (
    <form
      className="paper-translation-picker"
      onSubmit={event => {
        event.preventDefault();
        const language = picker.current?.value;
        if (isTranslationLanguage(language)) void state.translate(language);
      }}
    >
      <label>
        <span>Translation language</span>
        <select ref={picker} onFocus={onFocus} defaultValue={state.chooseLanguage() || state.current.translation?.language} required>
          <option value="">Choose a language</option>
          {Object.entries(TRANSLATION_LANGUAGES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
        </select>
      </label>
      <Button type="submit" variant="ghost" size="sm" aria-disabled={state.current.pending}>Translate paper</Button>
    </form>
  );
}

export function PaperTranslationStatus({ state, announce = true }: { state: PaperTranslationState; announce?: boolean }) {
  if (!state.eligible) return null;
  const { pending, translation, showing, error } = state.current;
  return (
    <span role={announce ? 'status' : undefined} translate="no" className={error ? 'paper-translation-error' : 'visually-hidden'}>
      {pending ? 'Translating title and abstract.'
        : error || (translation && (showing ? `Showing AI translation in ${TRANSLATION_LANGUAGES[translation.language]}.` : 'Showing original title and abstract.'))}
    </span>
  );
}
