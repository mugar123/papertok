import { getAllLeafCategories, getAreaLeaves, getCategoryLabel } from '../data/category-taxonomy.ts';
import { MAX_FOLLOWED_JOURNALS, type FollowEntity } from './following.ts';
import { createQueryTopic } from './topic-navigation.ts';

// A custom feed: a named list of ingredients (whole areas, categories,
// OpenAlex topics, authors and journals, keywords) and an order, which the corpus serves
// as one request. This module validates what an account stores, holds its
// limits and turns a feed into that request.

export const MAX_CUSTOM_FEEDS = 8;
export const MAX_FEED_INGREDIENTS = 20;
/**
 * Authors, research topics and journals, counted once each across the
 * account's feeds: each is a lane the nightly harvest lists.
 */
export const MAX_ACCOUNT_ENTITIES = 30;
export const MAX_ACCOUNT_KEYWORDS = 10;
export const MAX_FEED_NAME_LENGTH = 32;

const MAX_KEYWORD_LENGTH = 120;
const MAX_LABEL_LENGTH = 200;

export type FeedIngredient =
  | { kind: 'area'; id: string }
  | { kind: 'category'; id: string }
  | { kind: 'topic'; id: string; label: string }
  | { kind: 'author'; id: string; label: string }
  | { kind: 'journal'; id: string; label: string }
  | { kind: 'keyword'; query: string };
export type CustomFeedOrder = 'newest' | 'best';
export interface CustomFeedInput { name: string; order: CustomFeedOrder; ingredients: FeedIngredient[] }
export interface CustomFeed extends CustomFeedInput { id: string }

type CustomFeedErrorCode = 'feed-limit' | 'taken' | 'missing' | 'invalid';

export class CustomFeedError extends Error {
  readonly code: CustomFeedErrorCode;

  constructor(code: CustomFeedErrorCode) {
    super(`Custom feed error: ${code}`);
    this.name = 'CustomFeedError';
    this.code = code;
  }
}

const FEED_ID = /^[a-z0-9]{8,24}$/;
const TOPIC_ID = /^[TC]\d+$/;
const AUTHOR_ID = /^A\d+$/;
const JOURNAL_ID = /^S\d+$/;
const ENTITY_IDS = { topic: TOPIC_ID, author: AUTHOR_ID, journal: JOURNAL_ID };
const OPENALEX_URL = /^https?:\/\/(?:api\.)?openalex\.org\//i;
const ORDERS = new Set<unknown>(['newest', 'best']);
const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));

const nameLength = (name: string) => [...name.trim()].length;
/** An OpenAlex id, its URL (`https://openalex.org/A1`, `https://api.openalex.org/authors/A1`) read as its last segment. */
function openAlexId(value: unknown) {
  const id = typeof value === 'string' ? value.trim() : '';
  return OPENALEX_URL.test(id) ? id.split('/').pop()! : id;
}

/**
 * A label as it is stored: lone surrogates replaced as `toWellFormed()` does
 * (`\p{Cs}` matches only a lone one under the `u` flag; the TypeScript lib is
 * ES2023, which lacks `toWellFormed`), control characters removed, whitespace
 * collapsed and trimmed. Each of those would otherwise travel as a six-byte
 * JSON escape and could push a feed's follows out of the request.
 */
function cleanLabel(value: unknown) {
  const label = typeof value === 'string'
    ? value.replace(/\p{Cs}/gu, '�').replace(/\p{Cc}/gu, char => (/\s/.test(char) ? ' ' : '')).replace(/\s+/g, ' ').trim()
    : '';
  return label.length >= 1 && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** A keyword as it is stored: lowercased, single-spaced, and a query a search can be made of. */
function cleanKeyword(value: unknown) {
  const query = typeof value === 'string' ? value.replace(/[\p{Cc}\s]+/gu, ' ').trim().toLowerCase() : '';
  return query.length <= MAX_KEYWORD_LENGTH && createQueryTopic(query) ? query : null;
}

/**
 * One ingredient as this module stores it, normalised (an OpenAlex URL read as
 * its id, a keyword lowercased and single-spaced, a label trimmed), or null
 * when it is not one.
 */
export function parseFeedIngredient(raw: unknown): FeedIngredient | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, id, label, query } = raw as Record<string, unknown>;
  if (kind === 'area') return typeof id === 'string' && getAreaLeaves(id) ? { kind, id } : null;
  if (kind === 'category') return typeof id === 'string' && LEAF_IDS.has(id) ? { kind, id } : null;
  if (kind === 'topic' || kind === 'author' || kind === 'journal') {
    const entityId = openAlexId(id);
    const entityLabel = cleanLabel(label);
    if (!entityLabel || !ENTITY_IDS[kind].test(entityId)) return null;
    return { kind, id: entityId, label: entityLabel };
  }
  if (kind === 'keyword') {
    const keyword = cleanKeyword(query);
    return keyword ? { kind, query: keyword } : null;
  }
  return null;
}

export function ingredientKey(ingredient: FeedIngredient): string {
  return ingredient.kind === 'keyword' ? `keyword:${ingredient.query}` : `${ingredient.kind}:${ingredient.id}`;
}

export function ingredientLabel(ingredient: FeedIngredient): string {
  switch (ingredient.kind) {
    case 'area': return getAreaLeaves(ingredient.id) ? getCategoryLabel(ingredient.id) : ingredient.id;
    case 'category': return LEAF_IDS.has(ingredient.id) ? getCategoryLabel(ingredient.id) : ingredient.id;
    case 'keyword': return ingredient.query;
    default: return ingredient.label;
  }
}

/** The account ceiling an ingredient counts against, or null when it counts against none. */
function accountCeiling(ingredient: FeedIngredient) {
  if (ingredient.kind === 'author' || ingredient.kind === 'topic' || ingredient.kind === 'journal') return { kinds: ['author', 'topic', 'journal'], max: MAX_ACCOUNT_ENTITIES, problem: 'entities-full' as const };
  if (ingredient.kind === 'keyword') return { kinds: ['keyword'], max: MAX_ACCOUNT_KEYWORDS, problem: 'keywords-full' as const };
  return null;
}

function parseFeed(raw: unknown): CustomFeed | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, name, order, ingredients } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !FEED_ID.test(id)) return null;
  if (typeof name !== 'string' || nameLength(name) < 1 || nameLength(name) > MAX_FEED_NAME_LENGTH) return null;
  if (!ORDERS.has(order)) return null;
  const parsed = new Map<string, FeedIngredient>();
  let journals = 0;
  for (const item of Array.isArray(ingredients) ? ingredients : []) {
    const ingredient = parseFeedIngredient(item);
    if (!ingredient || parsed.has(ingredientKey(ingredient))) continue;
    // The Worker reads only the first journals of a request (servedFollows).
    if (ingredient.kind === 'journal' && journals++ >= MAX_FOLLOWED_JOURNALS) continue;
    parsed.set(ingredientKey(ingredient), ingredient);
  }
  return { id, name: name.trim(), order: order as CustomFeedOrder, ingredients: [...parsed.values()].slice(0, MAX_FEED_INGREDIENTS) };
}

/**
 * The feeds an account stored, keeping only what is well formed: a feed whose
 * id, name or order is invalid goes, as does a later feed with an id already
 * seen. A feed keeps its first ten journals. Within the limits, walking the
 * feeds in order, an author, research topic, journal or keyword the account
 * does not yet hold is dropped once its ceiling is reached.
 */
export function parseCustomFeeds(raw: unknown): CustomFeed[] {
  if (!Array.isArray(raw)) return [];
  const feeds: CustomFeed[] = [];
  for (const item of raw) {
    const feed = parseFeed(item);
    if (feed && !feeds.some(kept => kept.id === feed.id)) feeds.push(feed);
    if (feeds.length === MAX_CUSTOM_FEEDS) break;
  }
  const held = new Map<string, Set<string>>();
  return feeds.map(feed => ({
    ...feed,
    ingredients: feed.ingredients.filter((ingredient) => {
      const ceiling = accountCeiling(ingredient);
      if (!ceiling) return true;
      const keys = held.get(ceiling.problem) ?? new Set<string>();
      held.set(ceiling.problem, keys);
      const key = ingredientKey(ingredient);
      if (!keys.has(key) && keys.size >= ceiling.max) return false;
      keys.add(key);
      return true;
    }),
  }));
}

export type IngredientProblem = 'duplicate' | 'feed-full' | 'journals-full' | 'entities-full' | 'keywords-full';

export function feedNameProblem(name: string, feeds: CustomFeed[], exceptId?: string): 'empty' | 'too-long' | 'taken' | null {
  const length = nameLength(name);
  if (length === 0) return 'empty';
  if (length > MAX_FEED_NAME_LENGTH) return 'too-long';
  const folded = name.trim().toLowerCase();
  return feeds.some(feed => feed.id !== exceptId && feed.name.trim().toLowerCase() === folded) ? 'taken' : null;
}

/**
 * Why `ingredient` cannot join a feed being edited, whose ingredients are
 * `feed`, given the account's `otherFeeds`, or null when it can. A feed holds
 * at most MAX_FOLLOWED_JOURNALS journals, since the Worker reads no more of a
 * request. An ingredient another feed already holds counts once and passes
 * the account ceilings.
 */
export function ingredientProblem(ingredient: FeedIngredient, feed: FeedIngredient[], otherFeeds: CustomFeed[]): IngredientProblem | null {
  const key = ingredientKey(ingredient);
  if (feed.some(held => ingredientKey(held) === key)) return 'duplicate';
  if (feed.length >= MAX_FEED_INGREDIENTS) return 'feed-full';
  if (ingredient.kind === 'journal' && feed.filter(held => held.kind === 'journal').length >= MAX_FOLLOWED_JOURNALS) return 'journals-full';
  const ceiling = accountCeiling(ingredient);
  if (!ceiling) return null;
  const held = new Set([...feed, ...otherFeeds.flatMap(other => other.ingredients)]
    .filter(other => ceiling.kinds.includes(other.kind))
    .map(ingredientKey));
  return !held.has(key) && held.size >= ceiling.max ? ceiling.problem : null;
}

/**
 * What a one-press "Make it a feed" does with `ingredient`: a feed named
 * `name` (trimmed and cut to the name limit as a reader counts characters)
 * holding just that ingredient, newest first. `create` when the account can
 * take it as it is; `edit`, with the same content, when the name is taken,
 * the account already holds its eight feeds or the ingredient passes an
 * account ceiling, so the feed window settles it.
 */
export function feedShortcutPlan(ingredient: FeedIngredient, name: string, feeds: CustomFeed[]):
  | { kind: 'create'; input: CustomFeedInput }
  | { kind: 'edit'; preset: Partial<CustomFeedInput> } {
  const input: CustomFeedInput = {
    name: [...name.trim()].slice(0, MAX_FEED_NAME_LENGTH).join('').trim(),
    order: 'newest',
    ingredients: [ingredient],
  };
  const fits = feedNameProblem(input.name, feeds) === null
    && feeds.length < MAX_CUSTOM_FEEDS
    && ingredientProblem(ingredient, [], feeds) === null;
  return fits ? { kind: 'create', input } : { kind: 'edit', preset: input };
}

const feedOf = (id: string, input: CustomFeedInput): CustomFeed => ({ id, name: input.name.trim(), order: input.order, ingredients: [...input.ingredients] });

/**
 * The feeds with a feed `id` made of `input` added at the end. When the list
 * already holds `id`, `input` replaces that feed in its place: a create
 * retried after a write that outran its deadline but landed must not make a
 * second feed, and the retry carries what the reader changed since.
 */
export function withFeedAdded(feeds: CustomFeed[], input: CustomFeedInput, id: string): CustomFeed[] {
  if (feeds.some(feed => feed.id === id)) return withFeedChanged(feeds, id, input);
  if (feeds.length >= MAX_CUSTOM_FEEDS) throw new CustomFeedError('feed-limit');
  if (feedNameProblem(input.name, feeds) === 'taken') throw new CustomFeedError('taken');
  return [...feeds, feedOf(id, input)];
}

export function withFeedChanged(feeds: CustomFeed[], id: string, input: CustomFeedInput): CustomFeed[] {
  if (!feeds.some(feed => feed.id === id)) throw new CustomFeedError('missing');
  if (feedNameProblem(input.name, feeds, id) === 'taken') throw new CustomFeedError('taken');
  return feeds.map(feed => (feed.id === id ? feedOf(id, input) : feed));
}

export function withFeedRemoved(feeds: CustomFeed[], id: string): CustomFeed[] {
  return feeds.filter(feed => feed.id !== id);
}

/** The feeds with `id` one place earlier or later; unchanged at either end or when no feed has `id`. */
export function withFeedMoved(feeds: CustomFeed[], id: string, delta: -1 | 1): CustomFeed[] {
  const from = feeds.findIndex(feed => feed.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= feeds.length) return feeds;
  const moved = [...feeds];
  [moved[from], moved[to]] = [moved[to], moved[from]];
  return moved;
}

/**
 * Where a feed stands among the account's feeds, as the tab menu and
 * Settings announce a saved move; empty for a feed that is not among them.
 */
export function feedPositionSentence(feeds: readonly Pick<CustomFeed, 'id' | 'name'>[], id: string): string {
  const index = feeds.findIndex(feed => feed.id === id);
  return index < 0 ? '' : `Moved ${feeds[index].name} to position ${index + 1} of ${feeds.length}.`;
}

/**
 * The `custom_feed_create` event of a feed: how many of its ingredients are
 * areas, categories and research topics, authors and keywords, and its order.
 * Journals are counted in none of the three.
 */
export function customFeedCreateEvent(feed: CustomFeed) {
  const count = (kinds: readonly FeedIngredient['kind'][]) => feed.ingredients.filter(ingredient => kinds.includes(ingredient.kind)).length;
  return {
    topic_count: count(['area', 'category', 'topic']),
    author_count: count(['author']),
    keyword_count: count(['keyword']),
    feed_order: feed.order,
  };
}

export function corpusRequestOf(feed: CustomFeed): { categories: string[]; areas: string[]; follows: FollowEntity[]; order: 'daily' | 'relevance' } {
  const categories: string[] = [];
  const areas: string[] = [];
  const follows: FollowEntity[] = [];
  for (const ingredient of feed.ingredients) {
    if (ingredient.kind === 'area') areas.push(ingredient.id);
    else if (ingredient.kind === 'category') categories.push(ingredient.id);
    else if (ingredient.kind === 'keyword') {
      // A feed may arrive here without having been parsed: a keyword no search can be made of is left out.
      const queryTopic = createQueryTopic(ingredient.query);
      if (queryTopic) follows.push({ type: 'topic', canonicalId: queryTopic.id, displayName: ingredient.query, metadata: { query: ingredient.query } });
    } else follows.push({ type: ingredient.kind, canonicalId: ingredient.id, displayName: ingredient.label });
  }
  return { categories, areas, follows, order: feed.order === 'newest' ? 'daily' : 'relevance' };
}

/**
 * The ingredient a followed entity names: one of the app's areas or
 * categories, an OpenAlex topic or concept, a free-text topic as a keyword, an
 * author by OpenAlex id, or a journal by its OpenAlex source id. Anything
 * else, an author known by name only or a journal without a source id
 * included, is null.
 */
export function ingredientFromFollow(entity: { type: string; id?: string; canonicalId?: string; displayName?: string; metadata?: { query?: string; categoryIds?: string[] } }): FeedIngredient | null {
  const id = entity.canonicalId ?? entity.id ?? '';
  if (entity.type === 'author' || entity.type === 'journal') return parseFeedIngredient({ kind: entity.type, id, label: entity.displayName });
  if (entity.type !== 'topic' && entity.type !== 'concept') return null;
  if (getAreaLeaves(id)) return { kind: 'area', id };
  if (LEAF_IDS.has(id)) return { kind: 'category', id };
  if (TOPIC_ID.test(openAlexId(id))) return parseFeedIngredient({ kind: 'topic', id, label: entity.displayName });
  return parseFeedIngredient({ kind: 'keyword', query: entity.metadata?.query || entity.displayName });
}
