import type { OpenAlexAuthor, OpenAlexTopic } from '../services/adapters/open-alex-types.ts';
import { ingredientKey, parseFeedIngredient, type FeedIngredient } from './custom-feeds.ts';
import { getLocalizedInstitutionName } from './institution-localization.ts';

// What the feed window's search finds, as ingredients. Each one comes out of
// `parseFeedIngredient`, the one validator the store holds a feed to.

const MAX_AUTHOR_RESULTS = 5;

/** A local area (level 0), a local category (level 1), or an OpenAlex research topic or concept. */
export function ingredientOfTopic(topic: OpenAlexTopic): FeedIngredient | null {
  if (topic._localTopic && topic.level === 0) return parseFeedIngredient({ kind: 'area', id: topic.id });
  if (topic._localTopic && topic.level === 1) return parseFeedIngredient({ kind: 'category', id: topic.id });
  return parseFeedIngredient({ kind: 'topic', id: topic.id, label: topic.display_name });
}

export function ingredientOfAuthor(author: OpenAlexAuthor): FeedIngredient | null {
  return parseFeedIngredient({ kind: 'author', id: author.id, label: author.display_name });
}

export function keywordIngredient(text: string): FeedIngredient | null {
  return parseFeedIngredient({ kind: 'keyword', query: text });
}

function distinct(ingredients: Array<FeedIngredient | null>, leaveOut: Set<string> = new Set()) {
  const kept = new Map<string, FeedIngredient>();
  for (const ingredient of ingredients) {
    if (ingredient && !leaveOut.has(ingredientKey(ingredient)) && !kept.has(ingredientKey(ingredient))) kept.set(ingredientKey(ingredient), ingredient);
  }
  return [...kept.values()];
}

/** The reader's own topics (leaf or area ids) that the feed does not hold yet. */
export function suggestedIngredients(preferences: string[], chosen: FeedIngredient[], limit = 6): FeedIngredient[] {
  const candidates = preferences.map(id => parseFeedIngredient({ kind: 'area', id }) ?? parseFeedIngredient({ kind: 'category', id }));
  return distinct(candidates, new Set(chosen.map(ingredientKey))).slice(0, limit);
}

/**
 * An author found by the search, with the institution OpenAlex gave for
 * them, or null when it gave none. The institution is only shown to tell
 * namesakes apart; the feed keeps the ingredient alone.
 */
export type AuthorResult = { ingredient: FeedIngredient; institution: string | null };

function authorResults(authors: OpenAlexAuthor[]): AuthorResult[] {
  const kept = new Map<string, AuthorResult>();
  for (const author of authors) {
    const ingredient = ingredientOfAuthor(author);
    if (!ingredient || kept.has(ingredientKey(ingredient))) continue;
    const institution = getLocalizedInstitutionName(author.institutionData || { display_name: author.institution }) || null;
    kept.set(ingredientKey(ingredient), { ingredient, institution });
  }
  return [...kept.values()].slice(0, MAX_AUTHOR_RESULTS);
}

/**
 * The search's groups: every topic once, in the order the sources gave them,
 * the first authors with their institutions, and the typed text as a keyword
 * when it makes one.
 */
export function ingredientResults({ text, topics, authors }: { text: string; topics: OpenAlexTopic[]; authors: OpenAlexAuthor[] }): { topics: FeedIngredient[]; authors: AuthorResult[]; keyword: FeedIngredient | null } {
  return {
    topics: distinct(topics.map(ingredientOfTopic)),
    authors: authorResults(authors),
    keyword: keywordIngredient(text),
  };
}

/**
 * What the search says when a remote source failed for the current term, or
 * null when neither did. The keyword and the app's own areas and categories
 * do not depend on either source.
 */
export function searchFailureNotice(failed: { topics: boolean; authors: boolean }): string | null {
  if (failed.topics && failed.authors) return 'Topics and authors could not be searched.';
  if (failed.topics) return 'Topics could not be searched.';
  if (failed.authors) return 'Authors could not be searched.';
  return null;
}
