import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, LoaderCircle, Search, UserRound } from 'lucide-react';
import { useLanguage } from '../../context/LanguageContext';
import {
  USER_SEARCH_DEBOUNCE_MS,
  USER_SEARCH_MIN_LENGTH,
  isSearchableTerm,
  normalizeUserSearchTerm,
  searchUsers,
} from '../../services/userSearchService';
import { isReadTimeout, withReadTimeout } from '../../utils/boundedRead';
import './UserSearchPage.css';

/**
 * Finding people on PaperTok (F9).
 *
 * The list this page reads is `userSearch/`, not `userProfiles/`: the profile
 * collection has been unlistable since the F1 security review and stays that
 * way, so a result row carries a name and a handle and nothing else — no photo,
 * which is precisely what that review closed the door on.
 *
 * Only public profiles are in there. That is not a filter this component
 * applies: a private profile has no document in the index at all, and the rules
 * refuse to let one exist. Nothing here can leak what is not in the data.
 *
 * A search fires on submit or after a quiet period, never per keystroke: each
 * one costs two queries, and the daily read quota of the free tier is the real
 * backstop.
 */

/** Placeholders wait this long, so a fast answer never flashes a spinner. */
const SPINNER_DELAY_MS = 320;
const SEARCH_TIMEOUT_MS = 6000;

function initialOf(name, handle) {
  const source = (name || handle || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

export default function UserSearchPage() {
  const navigate = useNavigate();
  const { isEnglish } = useLanguage();
  const prefersReducedMotion = useReducedMotion();

  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null);
  const [searchedFor, setSearchedFor] = useState('');
  const [status, setStatus] = useState('idle');
  const [showSpinner, setShowSpinner] = useState(false);

  // Only the newest search may write state: two searches in flight would
  // otherwise race, and the slower one would win by arriving last.
  const requestRef = useRef(0);
  const inputRef = useRef(null);

  const copy = isEnglish ? {
    title: 'Find people',
    subtitle: 'Search by handle or by name. Only public profiles appear here.',
    placeholder: 'Handle or name',
    action: 'Search',
    back: 'Back',
    tooShort: `Type at least ${USER_SEARCH_MIN_LENGTH} characters.`,
    empty: 'Nobody matches that.',
    emptyHint: 'It searches from the start of the handle or the name, so "nico" finds "Nicolás" but "muñoz" does not.',
    failed: 'The search could not be completed.',
    slow: 'The search is taking longer than usual.',
    retry: 'Try again',
    resultsLabel: 'Search results',
  } : {
    title: 'Buscar personas',
    subtitle: 'Busca por handle o por nombre. Aquí solo aparecen los perfiles públicos.',
    placeholder: 'Handle o nombre',
    action: 'Buscar',
    back: 'Volver',
    tooShort: `Escribe al menos ${USER_SEARCH_MIN_LENGTH} caracteres.`,
    empty: 'No hay nadie con ese nombre.',
    emptyHint: 'Busca desde el principio del handle o del nombre, así que "nico" encuentra "Nicolás" pero "muñoz" no.',
    failed: 'No se ha podido completar la búsqueda.',
    slow: 'La búsqueda está tardando más de lo normal.',
    retry: 'Reintentar',
    resultsLabel: 'Resultados de la búsqueda',
  };

  const run = useCallback(async (raw) => {
    const normalized = normalizeUserSearchTerm(raw);
    if (!isSearchableTerm(normalized)) {
      requestRef.current += 1;
      setStatus('idle');
      setResults(null);
      return;
    }

    const ticket = requestRef.current + 1;
    requestRef.current = ticket;
    setShowSpinner(false);
    setStatus('searching');
    setSearchedFor(normalized);

    try {
      // Firestore has no client-side timeout: a stalled connection leaves the
      // promise pending forever, and a search box that never stops searching is
      // worse than one that says it failed.
      const found = await withReadTimeout(searchUsers(normalized), {
        ms: SEARCH_TIMEOUT_MS,
        label: 'user search',
      });
      if (requestRef.current !== ticket) return;
      setResults(found);
      setStatus('done');
    } catch (error) {
      if (requestRef.current !== ticket) return;
      console.error('User search failed:', error);
      setResults(null);
      setStatus(isReadTimeout(error) ? 'slow' : 'failed');
    }
  }, []);

  // Debounced, never per keystroke. The submit button runs the same function,
  // so pressing Enter simply skips the wait.
  useEffect(() => {
    if (!isSearchableTerm(term)) return undefined;
    const timer = setTimeout(() => run(term), USER_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, run]);

  // A spinner that appears instantly for a 90 ms answer reads as slowness the
  // search does not have.
  useEffect(() => {
    if (status !== 'searching') return undefined;
    const timer = setTimeout(() => setShowSpinner(true), SPINNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const onSubmit = (event) => {
    event.preventDefault();
    run(term);
  };

  // Emptying the box drops the results with it. Done here rather than in an
  // effect: it is a consequence of the keystroke, not of a render.
  const onType = (value) => {
    setTerm(value);
    if (isSearchableTerm(value)) return;
    // Invalidates whatever is in flight, so a late answer cannot repopulate a
    // list the user has just cleared.
    requestRef.current += 1;
    setStatus('idle');
    setResults(null);
  };

  const typed = normalizeUserSearchTerm(term);
  const tooShort = typed.length > 0 && typed.length < USER_SEARCH_MIN_LENGTH;

  return (
    <div className="user-search-page">
      <header className="user-search-header">
        <button
          type="button"
          className="user-search-back"
          onClick={() => navigate(-1)}
          aria-label={copy.back}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="user-search-heading">
          <h1>{copy.title}</h1>
          <p>{copy.subtitle}</p>
        </div>
      </header>

      <form className="user-search-form" onSubmit={onSubmit} role="search">
        <div className="user-search-field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            className="user-search-input"
            value={term}
            onChange={event => onType(event.target.value)}
            placeholder={copy.placeholder}
            aria-label={copy.placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck="false"
            maxLength={80}
          />
        </div>
        <button type="submit" className="user-search-submit" disabled={!isSearchableTerm(term)}>
          {copy.action}
        </button>
      </form>

      <div className="user-search-body" aria-live="polite" aria-busy={status === 'searching'}>
        {tooShort && <p className="user-search-note">{copy.tooShort}</p>}

        {status === 'searching' && showSpinner && (
          <p className="user-search-note user-search-note--busy">
            <LoaderCircle size={16} className="user-search-spinner" aria-hidden="true" />
            {copy.action}…
          </p>
        )}

        {(status === 'failed' || status === 'slow') && (
          <div className="user-search-note user-search-note--error">
            <p>{status === 'slow' ? copy.slow : copy.failed}</p>
            <button type="button" className="user-search-retry" onClick={() => run(searchedFor)}>
              {copy.retry}
            </button>
          </div>
        )}

        {status === 'done' && results?.length === 0 && (
          <div className="user-search-empty">
            <UserRound size={22} aria-hidden="true" />
            <p>{copy.empty}</p>
            {/* The prefix limit said out loud, so an empty result is not read
                as "this person is not on PaperTok". */}
            <p className="user-search-empty-hint">{copy.emptyHint}</p>
          </div>
        )}

        {status === 'done' && results?.length > 0 && (
          <ul className="user-search-results" aria-label={copy.resultsLabel}>
            <AnimatePresence initial={false}>
              {results.map((person, index) => (
                <motion.li
                  key={person.uid}
                  initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      delay: prefersReducedMotion ? 0 : Math.min(index, 6) * 0.03,
                      duration: prefersReducedMotion ? 0.08 : 0.2,
                      ease: 'easeOut',
                    },
                  }}
                >
                  <button
                    type="button"
                    className="user-search-result"
                    onClick={() => navigate(`/public/user/${person.handle}`)}
                  >
                    {/* A monogram, not a photo: the index holds no photo, and
                        that is the point rather than an omission. */}
                    <span className="user-search-avatar" aria-hidden="true">
                      {initialOf(person.name, person.handle)}
                    </span>
                    <span className="user-search-identity">
                      <span className="user-search-name">{person.name || person.handle}</span>
                      <span className="user-search-handle">@{person.handle}</span>
                    </span>
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
