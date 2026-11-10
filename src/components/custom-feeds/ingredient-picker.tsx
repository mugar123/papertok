import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Plus, X } from '@phosphor-icons/react';
import { Input } from '../ui/input.tsx';
import { searchAuthors, searchConcepts, searchLocalTopics } from '../../services/open-alex-service.ts';
import type { OpenAlexAuthor, OpenAlexTopic } from '../../services/adapters/open-alex-types.ts';
import { ingredientKey, ingredientLabel, type FeedIngredient } from '../../utils/custom-feeds.ts';
import { ingredientResults, searchFailureNotice } from '../../utils/feed-ingredient-search.ts';

const SEARCH_DELAY_MS = 320;
const TOPIC_LIMIT = 6;

const COPY = {
  label: 'What goes in it',
  hint: 'A paper shows up if it matches any of these.',
  search: 'Add a topic, author or keyword',
  suggestions: 'Start from one of your topics',
  topics: 'Topics',
  authors: 'Authors',
  keyword: 'Keyword',
  keywordHint: 'Any paper that mentions it',
  remove: (label: string) => `Remove ${label}`,
  count: (n: number) => (n === 0 ? 'No results' : `${n} ${n === 1 ? 'result' : 'results'}`),
};

const KIND: Record<FeedIngredient['kind'], string> = {
  area: 'Area',
  category: 'Category',
  topic: 'Topic',
  author: 'Author',
  keyword: 'Keyword',
};

/** A source's results, `failed` when its request failed, or null while it is asked. */
type Answer = { term: string; topics: OpenAlexTopic[] | 'failed' | null; authors: OpenAlexAuthor[] | 'failed' | null };

/**
 * The remote half of the search: research topics and authors for `term`,
 * asked once the typing has paused, each source on its own so one that fails
 * or runs out of time leaves the other's results. A failure is kept as one,
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
      setAnswer(current => ({ ...(current?.term === term ? current : { term, topics: null, authors: null }), ...part }));
    };
    const timer = window.setTimeout(() => {
      searchConcepts(term, { signal: controller.signal, limit: TOPIC_LIMIT, throwOnError: true })
        .then(topics => settle({ topics }), () => settle({ topics: 'failed' }));
      searchAuthors(term, { signal: controller.signal, typeahead: true, throwOnError: true })
        .then(authors => settle({ authors }), () => settle({ authors: 'failed' }));
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
    failed: { topics: current?.topics === 'failed', authors: current?.authors === 'failed' },
    pending: !current || current.topics === null || current.authors === null,
  };
}

function IngredientButton({ ingredient, chosen, onToggle, hint }: { ingredient: FeedIngredient; chosen: boolean; onToggle: (ingredient: FeedIngredient) => void; hint?: string }) {
  const label = ingredient.kind === 'keyword' ? `“${ingredient.query}”` : ingredientLabel(ingredient);
  return (
    <li>
      <button type="button" className="feed-result" aria-pressed={chosen} onClick={() => onToggle(ingredient)}>
        <span className="feed-result-mark" aria-hidden="true">{chosen ? <Check size={14} weight="bold" /> : <Plus size={14} />}</span>
        <span className="feed-result-text">
          <span className="feed-result-label">{label}</span>
          {hint && <span className="feed-result-hint">{hint}</span>}
        </span>
        <span className="feed-kind">{KIND[ingredient.kind]}</span>
      </button>
    </li>
  );
}

function ResultGroup({ title, ingredients, chosen, onToggle, hint }: { title: string; ingredients: FeedIngredient[]; chosen: Set<string>; onToggle: (ingredient: FeedIngredient) => void; hint?: string }) {
  const titleId = useId();
  if (ingredients.length === 0) return null;
  return (
    <div className="feed-results-group" role="group" aria-labelledby={titleId}>
      <span id={titleId} className="feed-section-label">{title}</span>
      <ul className="feed-results-list">
        {ingredients.map(ingredient => (
          <IngredientButton key={ingredientKey(ingredient)} ingredient={ingredient} chosen={chosen.has(ingredientKey(ingredient))} onToggle={onToggle} hint={hint} />
        ))}
      </ul>
    </div>
  );
}

/**
 * "What goes in it": the chosen ingredients as removable chips, and one
 * search field that finds ingredients of every kind. Areas and categories
 * come from the app's own taxonomy as the reader types; research topics and
 * authors from OpenAlex once the typing pauses. With the field empty, the
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
    () => ingredientResults({ text: term, topics: [...local, ...remote.topics], authors: remote.authors }),
    [term, local, remote.topics, remote.authors],
  );
  const chosen = useMemo(() => new Set(ingredients.map(ingredientKey)), [ingredients]);
  const count = results.topics.length + results.authors.length + (results.keyword ? 1 : 0);
  const failure = remote.pending ? null : searchFailureNotice(remote.failed);

  // A removed chip takes its button with it; focus goes to the chip that took
  // its place, or to the search field when none is left.
  const chipsRef = useRef<HTMLUListElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const focusAfterRemove = useRef<number | null>(null);
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const buttons = chipsRef.current?.querySelectorAll('button');
    const next = buttons?.[Math.min(index, buttons.length - 1)];
    (next ?? searchRef.current)?.focus();
  }, [ingredients]);

  return (
    <div className="feed-field" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      <span id={labelId} className="feed-field-label">{COPY.label}</span>
      {ingredients.length > 0 && (
        <ul className="feed-chips" ref={chipsRef}>
          {ingredients.map((ingredient, index) => {
            const label = ingredientLabel(ingredient);
            return (
              <li key={ingredientKey(ingredient)} className="feed-chip">
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
              </li>
            );
          })}
        </ul>
      )}
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
      <span className="visually-hidden" role="status">{term && !remote.pending ? [COPY.count(count), failure].filter(Boolean).join('. ') : ''}</span>
      {term ? (
        <div className="feed-results">
          <ResultGroup title={COPY.topics} ingredients={results.topics} chosen={chosen} onToggle={onToggle} />
          <ResultGroup title={COPY.authors} ingredients={results.authors} chosen={chosen} onToggle={onToggle} />
          <ResultGroup title={COPY.keyword} ingredients={results.keyword ? [results.keyword] : []} chosen={chosen} onToggle={onToggle} hint={COPY.keywordHint} />
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
