import { useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { CATEGORIES } from '../../data/categories.js';
import { normalizeGuestAreas } from '../../utils/guestInterests.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './GuestInterestsPrompt.css';

// The one question a guest is asked: which areas. It arrives after the sample
// feed is on screen, never before it — a visitor who has not yet seen a single
// card has no reason to answer anything — and it can be waved away in one
// tap. The answer rebuilds the guest feed on the spot, and the onboarding
// picks it up if the guest ever signs up: that is the whole reason to ask.
//
// Areas rather than the 100-odd subcategories: a guest gets a question that
// takes five seconds, and the onboarding is where the fine grain gets chosen,
// pre-filled from this.

const AREA_ENTRIES = Object.entries(CATEGORIES);

const COPY = {
  es: {
    kicker: { first: 'Para empezar', edit: 'Tus intereses' },
    title: '¿Qué te interesa?',
    lede: {
      first: 'Marca las áreas que te llamen y armamos el feed con ellas. Si luego creas una cuenta, se guardan en tu perfil.',
      edit: 'Cambia las áreas y el feed se vuelve a armar con ellas.',
    },
    areasLabel: 'Áreas de interés',
    none: 'Ninguna marcada · verás una muestra de todo',
    picked: n => `${n} ${n === 1 ? 'área marcada' : 'áreas marcadas'}`,
    primary: { first: 'Ver mi feed', edit: 'Actualizar feed' },
    secondary: { first: 'Ahora no', edit: 'Cancelar' },
    close: { first: 'Ahora no', edit: 'Cerrar' },
  },
  en: {
    kicker: { first: 'To begin', edit: 'Your interests' },
    title: 'What are you into?',
    lede: {
      first: 'Pick the areas that catch you and we build the feed from them. If you create an account later, they are saved to your profile.',
      edit: 'Change the areas and the feed is rebuilt from them.',
    },
    areasLabel: 'Areas of interest',
    none: 'None picked · you get a sample of everything',
    picked: n => `${n} ${n === 1 ? 'area picked' : 'areas picked'}`,
    primary: { first: 'Show my feed', edit: 'Update feed' },
    secondary: { first: 'Not now', edit: 'Cancel' },
    close: { first: 'Not now', edit: 'Close' },
  },
};

// GuestFeedPage mounts this only while it is open, so the dialog opens on
// mount and owns its `open` flag. Every way out — an answer, "Not now", the
// X, Escape, the scrim — flips it; Base UI plays the leave, and only then
// `onOpenChangeComplete(false)` hands the outcome to the parent: the answer
// through `onSubmit`, anything else through `onDismiss`. One call, once.
export default function GuestInterestsPrompt({ initialAreas = [], firstAsk = true, onSubmit, onDismiss }) {
  const { isEnglish } = useLanguage();
  const [open, setOpen] = useState(true);
  const answerRef = useRef(null);
  const firstAreaRef = useRef(null);
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

  const settle = (isOpen) => {
    if (isOpen) return;
    const answer = answerRef.current;
    if (answer) onSubmit?.(answer);
    else onDismiss?.();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen} onOpenChangeComplete={settle} modal>
      <DialogContent
        className="gip"
        overlayClassName="gip-backdrop"
        closeLabel={copy.close[mode]}
        initialFocus={firstAreaRef}
      >
        <p className="gip-kicker">{copy.kicker[mode]}</p>
        <DialogTitle className="gip-title">{copy.title}</DialogTitle>
        <DialogDescription className="gip-lede">{copy.lede[mode]}</DialogDescription>

        <div className="gip-areas" role="group" aria-label={copy.areasLabel}>
          {AREA_ENTRIES.map(([key, area], index) => {
            const isSelected = selected.has(key);
            return (
              // A shared Toggle: a native button carrying `aria-pressed` and
              // `data-pressed`, which the area's CSS styles. It forwards the
              // ref, so the dialog's initialFocus still lands on the first one.
              <Toggle
                key={key}
                variant="outline"
                className="gip-area"
                pressed={isSelected}
                onPressedChange={() => toggle(key)}
                style={{ '--area-accent': area.gradient }}
                ref={index === 0 ? firstAreaRef : undefined}
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
            {selected.size > 0 ? copy.picked(selected.size) : copy.none}
          </p>
          <div className="gip-actions">
            <Button variant="ghost" onClick={dismiss}>
              {copy.secondary[mode]}
            </Button>
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
