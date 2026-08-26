import { useEffect, useRef } from 'react';
import { ArrowRight, Bookmark, Infinity as InfinityIcon, Users } from 'lucide-react';
import { useAnalyticsConsent } from '../../context/AnalyticsContext.jsx';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { Button } from '../ui/button.jsx';
import './GuestEndCard.css';

// The last card of the guest feed. It is a card, not a modal: the feed hands it
// over on the same swipe as any paper, so reaching it feels like arriving at the
// end of the road rather than being interrupted — and swiping back up returns to
// the last paper with nothing to dismiss.
//
// The button opens the AuthPrompt modal through the page's `requestAccount`
// rather than routing to /login: design.md reserves the page for journeys that
// already moved the user somewhere else, and this one has not moved anybody.

const COPY = {
  es: {
    end: 'Fin de la prueba',
    count: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    heading: '¿Quieres continuar?',
    lede: 'Esto es todo lo que se ve sin cuenta. Al otro lado, el feed no se acaba.',
    perks: [
      'El feed sigue, y aprende de lo que lees',
      'Guarda en tus listas lo que te interese',
      'Sigue a autores, temas e instituciones',
    ],
    cta: 'Regístrate',
    foot: 'Con Google o GitHub, y sin salir de esta pantalla.',
    region: 'Continúa en PaperTok con una cuenta',
  },
  en: {
    end: 'End of the preview',
    count: count => `${count} ${count === 1 ? 'paper' : 'papers'}`,
    heading: 'Want to keep going?',
    lede: 'This is everything you get without an account. On the other side, the feed does not end.',
    perks: [
      'The feed keeps going, and learns from what you read',
      'Save whatever interests you to your lists',
      'Follow authors, topics and institutions',
    ],
    cta: 'Sign up',
    foot: 'With Google or GitHub, without leaving this screen.',
    region: 'Keep going on PaperTok with an account',
  },
};

const PERK_ICONS = [InfinityIcon, Bookmark, Users];

export default function GuestEndCard({ paperCount = 0, position = 0, onSignUp }) {
  const { isEnglish, language } = useLanguage();
  const { trackEvent } = useAnalyticsConsent();
  const copy = COPY[isEnglish ? 'en' : 'es'];
  const cardRef = useRef(null);
  const trackedRef = useRef(false);

  // Mounting proves nothing: the card is built while it is still a screen below
  // the last paper. Only a majority of it being on screen counts as "a guest
  // reached the end", which is the same bar PaperCard holds `paper_view` to.
  useEffect(() => {
    const node = cardRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (trackedRef.current || !entry.isIntersecting || entry.intersectionRatio <= 0.5) return;
        trackedRef.current = true;
        trackEvent('guest_demo_end', { position, language });
      },
      { threshold: [0, 0.5] },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [language, position, trackEvent]);

  return (
    <section className="gec" ref={cardRef} aria-label={copy.region}>
      <div className="gec-sheet">
        <p className="gec-kicker">
          <span>{copy.count(paperCount)}</span>
          <span className="gec-kicker-dot" aria-hidden="true">·</span>
          <span>{copy.end}</span>
        </p>

        <h2 className="gec-heading">{copy.heading}</h2>
        <p className="gec-lede">{copy.lede}</p>

        <ul className="gec-perks">
          {copy.perks.map((perk, index) => {
            const Icon = PERK_ICONS[index];
            return (
              <li className="gec-perk" key={perk}>
                <Icon size={16} aria-hidden="true" />
                <span>{perk}</span>
              </li>
            );
          })}
        </ul>

        <div className="gec-actions">
          <Button variant="default" size="lg" className="gec-cta" onClick={onSignUp}>
            <span>{copy.cta}</span>
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>

        <p className="gec-foot">{copy.foot}</p>
      </div>
    </section>
  );
}
