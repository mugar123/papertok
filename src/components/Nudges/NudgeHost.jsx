import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { MailWarning, Star } from 'lucide-react';
import { GithubMark } from '../ui/GithubMark.jsx';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import { useAuth } from '../../context/AuthContext';
import { useEmailNotifications } from '../../context/EmailNotificationsContext';
import { useLanguage } from '../../context/LanguageContext';
import {
  NUDGE_DWELL_MS,
  STAR_FETCH_BUDGET_MS,
  cacheStarCount,
  emailNudgeProblem,
  pickNudge,
  readCachedStarCount,
  readDismissedNudges,
  rememberNudgeDismissal,
} from '../../utils/nudges.js';
import NudgePanel from './NudgePanel.jsx';

// The one place that decides whether anybody is asked anything, and when.
//
// The rules it keeps, in order of how badly each one hurts when broken:
//   · Once per device, forever. A nudge that comes back is not a nudge.
//   · One per visit, and never two. The corner belongs to the reader.
//   · Not until a minute in, and only on the feed — asking somebody something
//     before they have read a line is asking a stranger for a favour.
//   · Never over the consent banner, which owns this corner while it is up.
// Guests are out entirely: they already have one thing being asked of them.

export const REPO_URL = 'https://github.com/mugar123/papertok';
const REPO_API_URL = 'https://api.github.com/repos/mugar123/papertok';

// How long the thanks beat is on screen before the panel leaves.
const THANKS_HOLD_MS = 600;

const COPY = {
  es: {
    dismiss: 'Cerrar y no volver a mostrarlo',
    starsLabel: count => `${count} ${count === 1 ? 'estrella' : 'estrellas'} en GitHub`,
    'open-source': {
      title: 'PaperTok es código abierto',
      body: 'Licencia MIT. Una estrella ayuda a difundirlo.',
      cta: 'Dale una estrella',
    },
    'email-down': {
      'not-configured': {
        title: 'Avisos por correo en pausa',
        body: 'El servicio aún no está conectado, así que no saldrá ningún resumen.',
      },
      unavailable: {
        title: 'Avisos por correo en pausa',
        body: 'El servicio de correo no responde ahora mismo y los resúmenes no salen.',
      },
      cta: 'Ajustes',
    },
  },
  en: {
    dismiss: 'Dismiss and do not show again',
    starsLabel: count => `${count} ${count === 1 ? 'star' : 'stars'} on GitHub`,
    'open-source': {
      title: 'PaperTok is open source',
      body: 'MIT licensed. A star helps other people find it.',
      cta: 'Star on GitHub',
    },
    'email-down': {
      'not-configured': {
        title: 'Email updates are paused',
        body: 'The service is not connected yet, so no digest will go out.',
      },
      unavailable: {
        title: 'Email updates are paused',
        body: 'The email service is not responding right now, so digests are not going out.',
      },
      cta: 'Settings',
    },
  },
};

export default function NudgeHost() {
  const { user, loading: authLoading, onboardingComplete } = useAuth();
  const { consent } = useAnalyticsConsent();
  const { isEnglish, locale } = useLanguage();
  const { health, loading: emailLoading } = useEmailNotifications();
  const location = useLocation();
  const navigate = useNavigate();

  const [dismissed, setDismissed] = useState(() => readDismissedNudges());
  const [dwellDone, setDwellDone] = useState(false);
  // `null` until one is picked. The star count is `undefined` while it is
  // still being resolved and a number-or-null once it is: the panel does not
  // appear until then, so the count travels with it and never lands late on a
  // reader's copy.
  const [picked, setPicked] = useState(null);
  const [stars, setStars] = useState(undefined);
  const [thanked, setThanked] = useState(false);
  // One per visit: flipped the moment the choice is made, so a re-render, a
  // navigation or the health request landing cannot start a second one. State
  // and not a ref, because this is read during render — the same shape (and
  // the same reason) as the guest interests sheet.
  const [choiceMade, setChoiceMade] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  const signedIn = Boolean(user) && !authLoading && onboardingComplete;
  const emailProblem = emailNudgeProblem({ loading: emailLoading, health });

  useEffect(() => {
    if (!signedIn || dwellDone) return undefined;
    const timer = window.setTimeout(() => setDwellDone(true), NUDGE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [signedIn, dwellDone]);

  const openable = dwellDone
    && signedIn
    && location.pathname === '/'
    // `null` is "has not answered yet", and while that is true the consent
    // banner is either up or about to be.
    && consent !== null;

  // Picked during render rather than in an effect: this derives state from
  // state, which an effect would turn into a second render pass — and the
  // linter says so, twice. Same shape the guest interests sheet uses.
  if (openable && !choiceMade) {
    setChoiceMade(true);
    const id = pickNudge({
      eligible: ['open-source', ...(emailProblem ? ['email-down'] : [])],
      dismissed,
    });
    if (id) {
      setPicked(id);
      setStars(id === 'open-source' ? (readCachedStarCount() ?? undefined) : null);
    }
  }

  // The count, when it was not already cached. A short budget, and then the
  // panel goes without it: a chip that arrives late would push the copy.
  useEffect(() => {
    if (picked !== 'open-source' || stars !== undefined) return undefined;
    let settled = false;
    const reveal = (value) => {
      if (settled || !aliveRef.current) return;
      settled = true;
      setStars(value);
    };
    const budget = window.setTimeout(() => reveal(null), STAR_FETCH_BUDGET_MS);
    fetch(REPO_API_URL, { headers: { Accept: 'application/vnd.github+json' } })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        const count = Number(payload?.stargazers_count);
        const usable = Number.isInteger(count) && count >= 0;
        if (usable) cacheStarCount(count);
        reveal(usable ? count : null);
      })
      .catch(() => reveal(null));
    return () => window.clearTimeout(budget);
  }, [picked, stars]);

  const close = useCallback((id) => {
    setDismissed(rememberNudgeDismissal(id));
    setPicked(null);
    setThanked(false);
  }, []);

  // Pressing the star opens GitHub in its own tab (the button is a link, so
  // the browser does that itself) and the panel nods once before leaving.
  const handleStar = useCallback(() => {
    setThanked(true);
    window.setTimeout(() => close('open-source'), THANKS_HOLD_MS);
  }, [close]);

  const handleSettings = useCallback(() => {
    close('email-down');
    navigate('/settings');
  }, [close, navigate]);

  const copy = COPY[isEnglish ? 'en' : 'es'];
  const isStar = picked === 'open-source';
  const emailCopy = emailProblem ? copy['email-down'][emailProblem] : null;
  const ready = picked !== null && stars !== undefined;

  return (
    <AnimatePresence>
      {ready && (isStar || emailCopy) && (
        isStar ? (
          <NudgePanel
            key="nudge-open-source"
            icon={<GithubMark size={19} />}
            iconClassName={`nudge-icon--github${thanked ? ' is-thanked' : ''}`}
            title={(
              <>
                {copy['open-source'].title}
                {stars !== null && (
                  <span className="nudge-stars" aria-label={copy.starsLabel(stars)}>
                    <Star size={11} aria-hidden="true" />
                    {stars.toLocaleString(locale)}
                  </span>
                )}
              </>
            )}
            body={copy['open-source'].body}
            action={{ label: copy['open-source'].cta, href: REPO_URL, onClick: handleStar }}
            dismissLabel={copy.dismiss}
            onDismiss={() => close('open-source')}
          />
        ) : (
          <NudgePanel
            key="nudge-email-down"
            icon={<MailWarning size={19} />}
            title={emailCopy.title}
            body={emailCopy.body}
            action={{ label: copy['email-down'].cta, onClick: handleSettings }}
            dismissLabel={copy.dismiss}
            onDismiss={() => close('email-down')}
          />
        )
      )}
    </AnimatePresence>
  );
}
