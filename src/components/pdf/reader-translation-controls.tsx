import { useCallback, useId, useRef } from 'react';
import { Button } from '../ui/button.tsx';
import { isTranslationLanguage, TRANSLATION_LANGUAGES, type TranslationLanguage } from '../../utils/full-paper-translation-contract.ts';
import './reader-translation-controls.css';

type Props = {
  signedIn: boolean;
  unavailable?: string;
  pending: boolean;
  progress?: { completed: number; total: number };
  message: string;
  toggle?: { label: string; action: () => void };
  onTranslate: (language: TranslationLanguage) => void;
  onCancel: () => void;
};

export function ReaderTranslationControls({
  signedIn, unavailable, pending, progress, message, toggle, onTranslate, onCancel,
}: Props) {
  const language = useRef<HTMLSelectElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const disclosure = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const focusOnControlRemoval = useCallback((control: HTMLElement | null) => {
    if (!control) return;
    return () => {
      if (control.contains(document.activeElement)) summary.current?.focus();
    };
  }, []);
  const noticeId = useId();
  return (
    <section className="reader-translation" translate="no" aria-label="Paper translation">
      <details ref={disclosure}>
        <summary ref={summary}>Translate paper</summary>
        <div className="reader-translation-panel">
          {unavailable || !signedIn
            ? <p>{unavailable || 'Sign in to translate this paper.'}</p>
            : (
              <form ref={focusOnControlRemoval} onSubmit={event => {
                event.preventDefault();
                const code = language.current?.value;
                if (!pending && isTranslationLanguage(code)) onTranslate(code);
              }}>
                <label>
                  <span>Translation language</span>
                  <select ref={language} defaultValue="" required disabled={pending}>
                    <option value="">Choose a language</option>
                    {Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </label>
                <Button ref={submit} variant="outline" size="sm" type="submit" aria-disabled={pending} aria-describedby={noticeId}>Translate paper</Button>
                <p id={noticeId}>Sends the article text to Anthropic. <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>
              </form>
            )}
        </div>
      </details>
      <div className="reader-translation-status">
        {progress && pending && (
          <>
            <progress aria-label="Full-paper translation progress" value={progress.completed} max={progress.total} />
            <Button ref={focusOnControlRemoval} variant="ghost" size="sm" type="button" onClick={() => {
              onCancel();
              if (disclosure.current?.open) submit.current?.focus();
              else summary.current?.focus();
            }}>Cancel translation</Button>
          </>
        )}
        <p role="status">{message}</p>
        {toggle && <Button variant="ghost" size="sm" type="button" onClick={toggle.action}>{toggle.label}</Button>}
      </div>
    </section>
  );
}
