import { useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { CATEGORIES } from '../../data/categories.js';
import { normalizeGuestAreas } from '../../utils/guestInterests.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './GuestInterestsPrompt.css';

// The first thing a guest sees, and the one question they are asked. The
// first ask opens with two lines on what PaperTok is — a visitor who has just
// landed has not read a single card yet, so the sheet has to say what the
// cards behind it are — and then which areas. The first ask has to be
// answered: no X, no Escape, no scrim — the feed behind it is built from the
// answer. Editing later (from the header chip) can be cancelled. The answer rebuilds the guest feed on the spot, and the onboarding
// picks it up if the guest ever signs up: that is the whole reason to ask.
//
// Areas rather than the 100-odd subcategories: a guest gets a question that
// takes five seconds, and the onboarding is where the fine grain gets chosen,
// pre-filled from this.

const AREA_ENTRIES = Object.entries(CATEGORIES);

const COPY = {
  es: {
    kicker: { first: 'Te damos la bienvenida', edit: 'Tus intereses' },
    title: { first: 'Esto es PaperTok', edit: '¿Qué te interesa?' },
    lede: {
      first: 'Un feed de papers científicos para deslizar, con lo esencial de cada uno explicado en claro y recomendaciones que aprenden de lo que lees.',
      edit: 'Cambia las áreas y el feed se vuelve a armar con ellas.',
    },
    question: '¿Qué te interesa?',
    questionHint: 'Marca las áreas que te llamen y armamos el feed con ellas. Si luego creas una cuenta, se guardan en tu perfil.',
    areasLabel: 'Áreas de interés',
    picked: n => `${n} ${n === 1 ? 'área marcada' : 'áreas marcadas'}`,
    primary: { first: 'Ver mi feed', edit: 'Actualizar feed' },
    secondary: 'Cancelar',
    close: 'Cerrar',
  },
  en: {
    kicker: { first: 'Welcome', edit: 'Your interests' },
    title: { first: 'This is PaperTok', edit: 'What are you into?' },
    lede: {
      first: 'A scrollable feed of scientific papers, each one explained in plain words, with recommendations that learn from what you read.',
      edit: 'Change the areas and the feed is rebuilt from them.',
    },
    question: 'What are you into?',
    questionHint: 'Pick the areas that catch you and we build the feed from them. If you create an account later, they are saved to your profile.',
    areasLabel: 'Areas of interest',
    picked: n => `${n} ${n === 1 ? 'area picked' : 'areas picked'}`,
    primary: { first: 'Show my feed', edit: 'Update feed' },
    secondary: 'Cancel',
    close: 'Close',
  },
};

// GuestFeedPage mounts this only while it is open, so the dialog opens on
// mount and owns its `open` flag. Every way out — an answer, or on an edit
// "Cancel", the X, Escape, the scrim — flips it; Base UI plays the leave, and
// only then `onOpenChangeComplete(false)` hands the outcome to the parent:
// the answer through `onSubmit`, anything else through `onDismiss`. One
// call, once. On the first ask the only way out is the answer:
// `requestOpenChange` refuses every close that does not carry one.
export default function GuestInterestsPrompt({ initialAreas = [], firstAsk = true, onSubmit, onDismiss }) {
  const { isEnglish } = useLanguage();
  const [open, setOpen] = useState(true);
  const answerRef = useRef(null);
  const titleRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set(normalizeGuestAreas(initialAreas)));
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const mode = firstAsk ? 'first' : 'edit';

  const initialKey = useMemo(() => normalizeGuestAreas(initialAreas).join('+'), [initialAreas]);
  const selectedKey = normalizeGuestAreas(Array.from(selected)).join('+');
  // A first answer needs at least one area — "none" is what "Not now" says.
  // An edit only needs to be a change, and emptying the pick is one.
  const canSubmit = firstAsk ? selected.size > 0 : selectedKey !== initialKey;

  const toggle = (key) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const submit = () => {
    if (!canSubmit) return;
    answerRef.current = normalizeGuestAreas(Array.from(selected));
    setOpen(false);
  };

  const dismiss = () => setOpen(false);

  // Base UI asks to close on Escape, an outside press or the X. A first ask
  // with no answer stays open; the visitor has to pick.
  const requestOpenChange = (nextOpen) => {
    if (!nextOpen && firstAsk && !answerRef.current) return;
    setOpen(nextOpen);
  };

  const settle = (isOpen) => {
    if (isOpen) return;
    const answer = answerRef.current;
    if (answer) onSubmit?.(answer);
    else onDismiss?.();
  };

  return (
    <Dialog open={open} onOpenChange={requestOpenChange} onOpenChangeComplete={settle} modal>
      <DialogContent
        className="gip"
        overlayClassName="gip-backdrop"
        showClose={!firstAsk}
        closeLabel={copy.close}
        initialFocus={titleRef}
      >
        <p className="gip-kicker">{copy.kicker[mode]}</p>
        <DialogTitle className="gip-title" ref={titleRef} tabIndex={-1}>{copy.title[mode]}</DialogTitle>
        <DialogDescription className="gip-lede">{copy.lede[mode]}</DialogDescription>

        {/* The question itself, once the first ask has said what PaperTok
            is. An edit already has the question as its title. */}
        {firstAsk && (
          <div className="gip-question">
            <h3 className="gip-question-title">{copy.question}</h3>
            <p className="gip-question-hint">{copy.questionHint}</p>
          </div>
        )}

        <div className="gip-areas" role="group" aria-label={copy.areasLabel}>
          {AREA_ENTRIES.map(([key, area]) => {
            const isSelected = selected.has(key);
            return (
              // A shared Toggle: a native button carrying `aria-pressed` and
              // `data-pressed`, which the area's CSS styles.
              <Toggle
                key={key}
                variant="outline"
                className="gip-area"
                pressed={isSelected}
                onPressedChange={() => toggle(key)}
                style={{ '--area-accent': area.gradient }}
              >
                <span className="gip-area-icon" aria-hidden="true">
                  <area.icon size={17} strokeWidth={1.75} />
                </span>
                <span className="gip-area-name">{isEnglish ? area.labelEn : area.label}</span>
                <span className="gip-area-check" aria-hidden="true">
                  <Check size={11} strokeWidth={3.5} />
                </span>
              </Toggle>
            );
          })}
        </div>

        <footer className="gip-foot">
          <p className={`gip-tally ${selected.size > 0 ? 'is-on' : ''}`} aria-live="polite">
            {selected.size > 0 ? copy.picked(selected.size) : ''}
          </p>
          <div className="gip-actions">
            {!firstAsk && (
              <Button variant="ghost" onClick={dismiss}>
                {copy.secondary}
              </Button>
            )}
            <Button variant="default" className="gip-submit" onClick={submit} disabled={!canSubmit}>
              <span>{copy.primary[mode]}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
