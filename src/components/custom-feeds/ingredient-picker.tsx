import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Plus, X } from '@phosphor-icons/react';
import { Input } from '../ui/input.tsx';
import { searchAuthors, searchConcepts, searchJournals, searchLocalTopics } from '../../services/open-alex-service.ts';
import type { OpenAlexAuthor, OpenAlexJournal, OpenAlexTopic } from '../../services/adapters/open-alex-types.ts';
import { ingredientKey, ingredientLabel, type FeedIngredient } from '../../utils/custom-feeds.ts';
import { ingredientResults, searchFailureNotice } from '../../utils/feed-ingredient-search.ts';
import { EASE_IN_OUT, EASE_OUT, MOTION_BASE_S, pulseIcon } from '../../utils/motion-curves.ts';

const SEARCH_DELAY_MS = 320;
const TOPIC_LIMIT = 6;

const COPY = {
  label: 'What goes in it',
  hint: 'A paper shows up if it matches any of these.',
  search: 'Add a topic, author, journal or keyword',
  suggestions: 'Start from one of your topics',
  topics: 'Topics',
  authors: 'Authors',
  journals: 'Journals',
  keyword: 'Keyword',
  keywordHint: 'Any paper that mentions it',
  remove: (label: string) => `Remove ${label}`,
  searching: 'Searching',
  count: (n: number) => (n === 0 ? 'No results' : `${n} ${n === 1 ? 'result' : 'results'}`),
};

const KIND: Record<FeedIngredient['kind'], string> = {
  area: 'Area',
  category: 'Category',
  topic: 'Topic',
  author: 'Author',
  journal: 'Journal',
  keyword: 'Keyword',
};

/** A source's results, `failed` when its request failed, or null while it is asked. */
type Answer = {
  term: string;
  topics: OpenAlexTopic[] | 'failed' | null;
  authors: OpenAlexAuthor[] | 'failed' | null;
  journals: OpenAlexJournal[] | 'failed' | null;
};

/**
 * The remote half of the search: research topics, authors and journals for
 * `term`, asked once the typing has paused, each source on its own so one
 * that fails or runs out of time leaves the others' results. A failure is kept as one,
 * not as an empty list, so the picker can say so; typing again asks again.
 * Typing again also aborts the requests in flight, which then say nothing.
 * An answer is kept with the term it answers, so a late one never shows
 * under another query. `searchConcepts` still answers with the app's own
 * areas and categories when OpenAlex fails, so a failure is seen only for a
 * term none of them matches.
 */
function useRemoteResults(term: string) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  useEffect(() => {
    if (!term) return undefined;
    const controller = new AbortController();
    const settle = (part: Partial<Answer>) => {
      if (controller.signal.aborted) return;
      setAnswer(current => ({ ...(current?.term === term ? current : { term, topics: null, authors: null, journals: null }), ...part }));
    };
    const timer = window.setTimeout(() => {
      searchConcepts(term, { signal: controller.signal, limit: TOPIC_LIMIT, throwOnError: true })
        .then(topics => settle({ topics }), () => settle({ topics: 'failed' }));
      searchAuthors(term, { signal: controller.signal, typeahead: true, throwOnError: true })
        .then(authors => settle({ authors }), () => settle({ authors: 'failed' }));
      searchJournals(term, { signal: controller.signal, throwOnError: true })
        .then(journals => settle({ journals }), () => settle({ journals: 'failed' }));
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [term]);
  const current = answer?.term === term ? answer : null;
  const listOf = <T,>(part: T[] | 'failed' | null | undefined) => (Array.isArray(part) ? part : []);
  return {
    topics: listOf(current?.topics),
    authors: listOf(current?.authors),
    journals: listOf(current?.journals),
    failed: { topics: current?.topics === 'failed', authors: current?.authors === 'failed', journals: current?.journals === 'failed' },
    pending: !current || current.topics === null || current.authors === null || current.journals === null,
  };
}

/** A search result, and the line under its name: an author's institution, a journal's publisher, or what a keyword does. */
type ResultItem = { ingredient: FeedIngredient; hint?: string };

function IngredientButton({ ingredient, chosen, onToggle, hint }: ResultItem & { chosen: boolean; onToggle: (ingredient: FeedIngredient) => void }) {
  const label = ingredient.kind === 'keyword' ? `“${ingredient.query}”` : ingredientLabel(ingredient);
  // The mark gives under the press the way Follow's icon does, once the
  // window has taken the ingredient in or out; a refused one does not move.
  const markRef = useRef<HTMLSpanElement | null>(null);
  const wasChosen = useRef(chosen);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (wasChosen.current === chosen) return;
    wasChosen.current = chosen;
    if (!reducedMotion) pulseIcon(markRef.current, chosen);
  }, [chosen, reducedMotion]);
  return (
    <li>
      <button type="button" className="feed-result" aria-pressed={chosen} onClick={() => onToggle(ingredient)}>
        <span className="feed-result-mark" aria-hidden="true" ref={markRef}>{chosen ? <Check size={14} weight="bold" /> : <Plus size={14} />}</span>
        <span className="feed-result-text">
          <span className="feed-result-label">{label}</span>
          {hint && <span className="feed-result-hint">{hint}</span>}
        </span>
        <span className="feed-kind">{KIND[ingredient.kind]}</span>
      </button>
    </li>
  );
}

function ResultGroup({ title, items, chosen, onToggle }: { title: string; items: ResultItem[]; chosen: Set<string>; onToggle: (ingredient: FeedIngredient) => void }) {
  const titleId = useId();
  if (items.length === 0) return null;
  return (
    <div className="feed-results-group" role="group" aria-labelledby={titleId}>
      <span id={titleId} className="feed-section-label">{title}</span>
      <ul className="feed-results-list">
        {items.map(({ ingredient, hint }) => (
          <IngredientButton key={ingredientKey(ingredient)} ingredient={ingredient} chosen={chosen.has(ingredientKey(ingredient))} onToggle={onToggle} hint={hint} />
        ))}
      </ul>
    </div>
  );
}

/**
 * "What goes in it": the chosen ingredients as removable chips, and one
 * search field that finds ingredients of every kind. Areas and categories
 * come from the app's own taxonomy as the reader types; research topics,
 * authors and journals from OpenAlex once the typing pauses. With the field empty, the
 * reader's own topics are offered instead. A result already in the feed is
 * pressed, and pressing it takes it out. Whether an ingredient may join is
 * the window's call (`onToggle`), as is the sentence when it may not.
 */
export default function IngredientPicker({ ingredients, suggestions, notice, onToggle, onRemove }: {
  ingredients: FeedIngredient[];
  suggestions: FeedIngredient[];
  /** Why the last ingredient pressed could not join, or null; `n` changes with each refusal. */
  notice: { text: string; n: number } | null;
  onToggle: (ingredient: FeedIngredient) => void;
  onRemove: (key: string) => void;
}) {
  const labelId = useId();
  const hintId = useId();
  const noticeId = useId();
  const suggestionsId = useId();
  const [query, setQuery] = useState('');
  const term = query.trim();
  const remote = useRemoteResults(term);
  const local = useMemo(() => (term ? searchLocalTopics(term, TOPIC_LIMIT) : []), [term]);
  const results = useMemo(
    () => ingredientResults({ text: term, topics: [...local, ...remote.topics], authors: remote.authors, journals: remote.journals }),
    [term, local, remote.topics, remote.authors, remote.journals],
  );
  const chosen = useMemo(() => new Set(ingredients.map(ingredientKey)), [ingredients]);
  const count = results.topics.length + results.authors.length + results.journals.length + (results.keyword ? 1 : 0);
  const failure = remote.pending ? null : searchFailureNotice(remote.failed);

  // Reduced motion keeps the fade and drops the rise; MotionConfig only
  // stills framer's own transform values, not a `transform` string.
  const chipOffset = useReducedMotion() ? 'none' : 'translateY(8px)';
  // The chips close up only once a removed one has left. Without a
  // dependency framer measures them on every render, and the window, centred
  // and as tall as its content, would carry them on a slide of their own
  // each time the results below change height.
  const [departures, setDepartures] = useState(0);

  // A removed chip takes its button with it; focus goes to the chip that took
  // its place, or to the search field when none is left. It is found by its
  // ingredient, not its position: the removed chip stays in the list while
  // it leaves.
  const chipsRef = useRef<HTMLUListElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusAfterRemove = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const next = ingredients[Math.min(index, ingredients.length - 1)];
    const button = next && chipsRef.current?.querySelector<HTMLButtonElement>(`[data-ingredient="${CSS.escape(ingredientKey(next))}"] button`);
    (button || searchRef.current)?.focus();
  }, [ingredients]);

  return (
    <div className="feed-field" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      <span id={labelId} className="feed-field-label">{COPY.label}</span>
      {/* A chip rises into the list as its result is pressed and sinks out
          when removed; the chips after it then close up. Two beats, as in
          Following, so two chips never share a place. The list stays mounted
          (hidden while empty) so the last chip can leave too. */}
      <ul className="feed-chips" ref={chipsRef}>
        <AnimatePresence initial={false} onExitComplete={() => setDepartures(n => n + 1)}>
          {ingredients.map((ingredient, index) => {
            const label = ingredientLabel(ingredient);
            return (
              <motion.li
                key={ingredientKey(ingredient)}
                data-ingredient={ingredientKey(ingredient)}
                className="feed-chip"
                layout="position"
                layoutDependency={departures}
                initial={{ opacity: 0, transform: chipOffset }}
                animate={{ opacity: 1, transform: 'none' }}
                exit={{ opacity: 0, transform: chipOffset }}
                transition={{ duration: MOTION_BASE_S, ease: EASE_OUT, layout: { duration: MOTION_BASE_S, ease: EASE_IN_OUT } }}
              >
                <span className="feed-kind">{KIND[ingredient.kind]}</span>
                <span className="feed-chip-label">{label}</span>
                <button
                  type="button"
                  className="feed-chip-remove"
                  aria-label={COPY.remove(label)}
                  onClick={() => {
                    focusAfterRemove.current = index;
                    onRemove(ingredientKey(ingredient));
                  }}
                >
                  <X size={12} weight="bold" aria-hidden="true" />
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      <p id={hintId} className="feed-field-hint">{COPY.hint}</p>
      <Input
        ref={searchRef}
        type="search"
        className="feed-input"
        placeholder={COPY.search}
        aria-label={COPY.search}
        aria-describedby={notice ? noticeId : undefined}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={event => setQuery(event.target.value)}
        // Escape with text in the field clears it here, in place of the
        // browser's own clearing, and the window stays open (FeedDialog's
        // onOpenChange). With the field empty, Escape closes the window.
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || query === '') return;
          event.preventDefault();
          setQuery('');
        }}
      />
      {notice && <p key={notice.n} id={noticeId} className="feed-notice" role="alert">{notice.text}</p>}
      <span className="visually-hidden" role="status">{term ? (remote.pending ? COPY.searching : [COPY.count(count), failure].filter(Boolean).join('. ')) : ''}</span>
      {/* Until every source has answered, rows of the results' shape stand
          in for them, so the list arrives once instead of growing under the
          reader's pointer. */}
      {term && remote.pending ? (
        <ul className="feed-results-list" aria-hidden="true">
          {[0, 1, 2, 3].map(index => (
            <li key={index} className="feed-skeleton-row">
              <span className="feed-skeleton-mark" />
              <span className="feed-skeleton-text"><span className="feed-skeleton-label" /><span className="feed-skeleton-hint" /></span>
              <span className="feed-skeleton-kind" />
            </li>
          ))}
        </ul>
      ) : term ? (
        <div className="feed-results">
          <ResultGroup title={COPY.topics} items={results.topics.map(ingredient => ({ ingredient }))} chosen={chosen} onToggle={onToggle} />
          <ResultGroup title={COPY.authors} items={results.authors.map(({ ingredient, institution }) => ({ ingredient, hint: institution ?? undefined }))} chosen={chosen} onToggle={onToggle} />
          <ResultGroup title={COPY.journals} items={results.journals.map(({ ingredient, publisher }) => ({ ingredient, hint: publisher ?? undefined }))} chosen={chosen} onToggle={onToggle} />
          <ResultGroup title={COPY.keyword} items={results.keyword ? [{ ingredient: results.keyword, hint: COPY.keywordHint }] : []} chosen={chosen} onToggle={onToggle} />
          {failure && <p className="feed-notice">{failure}</p>}
        </div>
      ) : suggestions.length > 0 && (
        <div className="feed-results-group" role="group" aria-labelledby={suggestionsId}>
          <span id={suggestionsId} className="feed-section-label">{COPY.suggestions}</span>
          <ul className="feed-results-list">
            {suggestions.map(ingredient => (
              <IngredientButton key={ingredientKey(ingredient)} ingredient={ingredient} chosen={chosen.has(ingredientKey(ingredient))} onToggle={onToggle} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
