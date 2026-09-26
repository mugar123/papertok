import { useMemo, useRef, useState } from 'react';
import { ArrowRight, Check } from '@phosphor-icons/react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { CATEGORIES } from '../../data/categories.js';
import { normalizeGuestAreas } from '../../utils/guestInterests.js';
import { Button } from '../ui/button.jsx';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog.jsx';
import { Toggle } from '../ui/toggle.jsx';
import './GuestInterestsPrompt.css';

// The guest's areas, edited from the header chip once the feed is up. The
// first answer is not asked here: a first visit is the welcome page
// (GuestWelcome), which ends on the same question. This sheet only changes an
// answer that exists, so every way out is open — X, Escape, the scrim and
// Cancel. The answer rebuilds the guest feed on the spot, and the onboarding
// picks it up if the guest ever signs up.
//
// Areas rather than the 100-odd subcategories: a guest gets a question that
// takes five seconds, and the onboarding is where the fine grain gets chosen,
// pre-filled from this.

const AREA_ENTRIES = Object.entries(CATEGORIES);

const COPY = {
  es: {
    kicker: 'Tus intereses',
    title: '¿Qué te interesa?',
    lede: 'Cambia las áreas y el feed se vuelve a armar con ellas.',
    areasLabel: 'Áreas de interés',
    picked: n => `${n} ${n === 1 ? 'área marcada' : 'áreas marcadas'}`,
    primary: 'Actualizar feed',
    secondary: 'Cancelar',
    close: 'Cerrar',
  },
  en: {
    kicker: 'Your interests',
    title: 'What are you into?',
    lede: 'Change the areas and the feed is rebuilt from them.',
    areasLabel: 'Areas of interest',
    picked: n => `${n} ${n === 1 ? 'area picked' : 'areas picked'}`,
    primary: 'Update feed',
    secondary: 'Cancel',
    close: 'Close',
  },
};

// GuestFeedPage mounts this only while it is open, so the dialog opens on
// mount and owns its `open` flag. Every way out — an answer, "Cancel", the X,
// Escape, the scrim — flips it; Base UI plays the leave, and only then
// `onOpenChangeComplete(false)` hands the outcome to the parent: the answer
// through `onSubmit`, anything else through `onDismiss`. One call, once.
export default function GuestInterestsPrompt({ initialAreas = [], onSubmit, onDismiss }) {
  const { isEnglish } = useLanguage();
  const [open, setOpen] = useState(true);
  const answerRef = useRef(null);
  const titleRef = useRef(null);
  const [selected, setSelected] = useState(() => new Set(normalizeGuestAreas(initialAreas)));
  const copy = COPY[isEnglish ? 'en' : 'es'];

  const initialKey = useMemo(() => normalizeGuestAreas(initialAreas).join('+'), [initialAreas]);
  const selectedKey = normalizeGuestAreas(Array.from(selected)).join('+');
  // An edit only needs to be a change, and emptying the pick is one.
  const canSubmit = selectedKey !== initialKey;

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
        closeLabel={copy.close}
        initialFocus={titleRef}
      >
        <p className="gip-kicker">{copy.kicker}</p>
        <DialogTitle className="gip-title" ref={titleRef} tabIndex={-1}>{copy.title}</DialogTitle>
        <DialogDescription className="gip-lede">{copy.lede}</DialogDescription>

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
                  <area.icon size={17} />
                </span>
                <span className="gip-area-name">{isEnglish ? area.labelEn : area.label}</span>
                <span className="gip-area-check" aria-hidden="true">
                  <Check size={11} weight="bold" />
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
            <Button variant="ghost" onClick={dismiss}>
              {copy.secondary}
            </Button>
            <Button variant="default" className="gip-submit" onClick={submit} disabled={!canSubmit}>
              <span>{copy.primary}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
