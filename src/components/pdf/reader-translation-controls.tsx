import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '../ui/button.tsx';
import { isTranslationLanguage, TRANSLATION_LANGUAGES, type TranslationLanguage } from '../../utils/paper-translation-contract.ts';
import './reader-translation-controls.css';

type Mode = 'abstract' | 'paper';
type Props = {
  signedIn: boolean;
  abstractAvailable: boolean;
  paperAvailable: boolean;
  paperUnavailable: string;
  defaultLanguage: TranslationLanguage | '';
  pending: boolean;
  progress?: { completed: number; total: number };
  message: string;
  toggle?: Partial<Record<Mode, { label: string; action: () => void }>>;
  onTranslate: (mode: Mode, language: TranslationLanguage) => void;
  onCancel: () => void;
  children?: ReactNode;
};

export function ReaderTranslationControls({
  signedIn, abstractAvailable, paperAvailable, paperUnavailable, defaultLanguage, pending, progress, message,
  toggle, onTranslate, onCancel, children,
}: Props) {
  const [selection, setChoice] = useState<Mode>(abstractAvailable ? 'abstract' : 'paper');
  const choice = paperAvailable ? selection : 'abstract';
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
  const unavailable = choice === 'paper' ? paperUnavailable : '';
  const noticeId = useId();
  const showNotice = choice === 'paper' && !unavailable;
  const abstractView = toggle?.abstract;
  return (
    <section className="reader-translation" translate="no" aria-label="Paper translation">
      <details ref={disclosure}>
        <summary ref={summary}>Translate</summary>
        <div className="reader-translation-panel">
          {!signedIn
            ? (abstractAvailable || !paperUnavailable) && <p>Sign in to translate this paper.</p>
            : (abstractAvailable || paperAvailable) && (
              <form ref={focusOnControlRemoval} onSubmit={event => {
                event.preventDefault();
                const code = language.current?.value;
                if (!pending && !unavailable && isTranslationLanguage(code)) onTranslate(choice, code);
              }}>
                <label>
                  <span>Translate</span>
                  <select value={choice} disabled={pending} onChange={event => setChoice(event.target.value === 'paper' ? 'paper' : 'abstract')}>
                    {abstractAvailable && <option value="abstract">Title and abstract</option>}
                    {paperAvailable && <option value="paper">Full paper</option>}
                  </select>
                </label>
                <label>
                  <span>Translation language</span>
                  <select ref={language} defaultValue={defaultLanguage} required disabled={pending}>
                    <option value="">Choose a language</option>
                    {Object.entries(TRANSLATION_LANGUAGES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
                  </select>
                </label>
                <Button ref={submit} variant="outline" size="sm" type="submit" aria-disabled={pending || Boolean(unavailable)} aria-describedby={showNotice ? noticeId : undefined}>Translate {choice === 'paper' ? 'full paper' : 'abstract'}</Button>
                {showNotice && <p id={noticeId}>Sends the article text to Anthropic. <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy policy</a></p>}
                {choice === 'abstract' && abstractView && !pending && <Button variant="ghost" size="sm" type="button" onClick={abstractView.action}>{abstractView.label}</Button>}
              </form>
            )}
          {!paperAvailable && !abstractAvailable && !message && <p>Full-paper translation is currently unavailable.</p>}
          {paperAvailable && (signedIn ? unavailable : paperUnavailable) && <p>{signedIn ? unavailable : paperUnavailable}</p>}
          {choice === 'abstract' && children}
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
        {toggle?.paper && <Button variant="ghost" size="sm" type="button" onClick={toggle.paper.action}>{toggle.paper.label}</Button>}
      </div>
    </section>
  );
}
