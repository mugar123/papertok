import { ArrowRight } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext.jsx';
import { Button } from '../ui/button.jsx';
import './ExplorerGuestGate.css';

// The foot of a list somebody is reading without an account. Two rows are
// shown above it; this block says what the other rows are and opens the same
// in-context door the rest of the explorer uses (`onAuthRequired` → AuthPrompt),
// so signing up happens here rather than on a page that would lose the entity.
//
// It is a block in the flow, not an overlay: nothing is dismissed, nothing is
// covered, and a visitor who does not want an account can still read the two
// rows above and leave through any of the entity's links. The wall is where
// the list stops, not on top of it.
//
// The count comes from the entity's own publication total — the same number
// the stats box above already shows — and `guestGateTotal` hands over `null`
// rather than a figure that would not explain the wall. With no number the
// copy makes no claim about size.

const COPY = {
  papers: {
    es: {
      kicker: 'Vista sin cuenta',
      title: total => (total ? `Aquí hay ${total} publicaciones` : 'La lista sigue'),
      body: 'Estás viendo las dos primeras. Con una cuenta se abre entera, con su buscador y sus filtros.',
    },
    en: {
      kicker: 'Preview without an account',
      title: total => (total ? `There are ${total} publications here` : 'The list keeps going'),
      body: 'You are seeing the first two. An account opens the whole list, with its search and its filters.',
    },
  },
  authors: {
    es: {
      kicker: 'Vista sin cuenta',
      title: () => 'La lista de autores sigue',
      body: 'Estás viendo a los dos primeros. Con una cuenta se abre entera.',
    },
    en: {
      kicker: 'Preview without an account',
      title: () => 'The author list keeps going',
      body: 'You are seeing the first two. An account opens the whole list.',
    },
  },
};

const CTA = {
  es: { cta: 'Regístrate', foot: 'Con Google o GitHub, y sin salir de esta pantalla.' },
  en: { cta: 'Sign up', foot: 'With Google or GitHub, without leaving this screen.' },
};

export default function ExplorerGuestGate({ kind = 'papers', total = null, onSignUp }) {
  const { isEnglish, locale } = useLanguage();
  const lang = isEnglish ? 'en' : 'es';
  const copy = COPY[kind][lang];
  const action = CTA[lang];
  const formattedTotal = typeof total === 'number' ? total.toLocaleString(locale) : null;

  return (
    <div className="explorer-guest-gate">
      <span className="egg-kicker">{copy.kicker}</span>
      <h3 className="egg-title">{copy.title(formattedTotal)}</h3>
      <p className="egg-body">{copy.body}</p>
      <div className="egg-action">
        <Button size="sm" onClick={onSignUp}>
          {action.cta}
          <ArrowRight size={15} aria-hidden="true" />
        </Button>
        <span className="egg-foot">{action.foot}</span>
      </div>
    </div>
  );
}
