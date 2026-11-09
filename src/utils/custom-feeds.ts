import { getAllLeafCategories, getAreaLeaves, getCategoryLabel } from '../data/category-taxonomy.ts';
import type { FollowEntity } from './following.ts';
import { createQueryTopic } from './topic-navigation.ts';

// A custom feed: a named list of ingredients (whole areas, categories,
// OpenAlex topics and authors, keywords) and an order, which the corpus serves
// as one request. This module validates what an account stores, holds its
// limits and turns a feed into that request.

export const MAX_CUSTOM_FEEDS = 8;
export const MAX_FEED_INGREDIENTS = 20;
/** Authors and research topics, counted once each across the account's feeds. */
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
  | { kind: 'keyword'; query: string };
export type CustomFeedOrder = 'newest' | 'best';
export interface CustomFeedInput { name: string; order: CustomFeedOrder; ingredients: FeedIngredient[] }
export interface CustomFeed extends CustomFeedInput { id: string }

type CustomFeedErrorCode = 'feed-limit' | 'missing' | 'invalid';

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
const OPENALEX_URL = /^https?:\/\/openalex\.org\//i;
const ORDERS = new Set<unknown>(['newest', 'best']);
const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));

const nameLength = (name: string) => [...name.trim()].length;
const openAlexId = (value: unknown) => (typeof value === 'string' ? value.trim().replace(OPENALEX_URL, '') : '');

function cleanLabel(value: unknown) {
  const label = typeof value === 'string' ? value.trim() : '';
  return label.length >= 1 && label.length <= MAX_LABEL_LENGTH ? label : null;
}

/** A keyword as it is stored: lowercased, single-spaced, and a query a search can be made of. */
function cleanKeyword(value: unknown) {
  const query = typeof value === 'string' ? value.replace(/[\p{Cc}\s]+/gu, ' ').trim().toLowerCase() : '';
  return query.length <= MAX_KEYWORD_LENGTH && createQueryTopic(query) ? query : null;
}

function parseIngredient(raw: unknown): FeedIngredient | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, id, label, query } = raw as Record<string, unknown>;
  if (kind === 'area') return typeof id === 'string' && getAreaLeaves(id) ? { kind, id } : null;
  if (kind === 'category') return typeof id === 'string' && LEAF_IDS.has(id) ? { kind, id } : null;
  if (kind === 'topic' || kind === 'author') {
    const entityId = openAlexId(id);
    const entityLabel = cleanLabel(label);
    if (!entityLabel || !(kind === 'topic' ? TOPIC_ID : AUTHOR_ID).test(entityId)) return null;
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
  if (ingredient.kind === 'author' || ingredient.kind === 'topic') return { kinds: ['author', 'topic'], max: MAX_ACCOUNT_ENTITIES, problem: 'entities-full' as const };
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
  for (const item of Array.isArray(ingredients) ? ingredients : []) {
    const ingredient = parseIngredient(item);
    if (ingredient && !parsed.has(ingredientKey(ingredient))) parsed.set(ingredientKey(ingredient), ingredient);
  }
  return { id, name: name.trim(), order: order as CustomFeedOrder, ingredients: [...parsed.values()].slice(0, MAX_FEED_INGREDIENTS) };
}

/**
 * The feeds an account stored, keeping only what is well formed: a feed whose
 * id, name or order is invalid goes, as does a later feed with an id already
 * seen. Within the limits, walking the feeds in order, an author, research
 * topic or keyword the account does not yet hold is dropped once its ceiling
 * is reached.
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

export function feedNameProblem(name: string, feeds: CustomFeed[], exceptId?: string): 'empty' | 'too-long' | 'taken' | null {
  const length = nameLength(name);
  if (length === 0) return 'empty';
  if (length > MAX_FEED_NAME_LENGTH) return 'too-long';
  const folded = name.trim().toLowerCase();
  return feeds.some(feed => feed.id !== exceptId && feed.name.trim().toLowerCase() === folded) ? 'taken' : null;
}

/**
 * Why `ingredient` cannot join a feed being edited, whose ingredients are
 * `feed`, given the account's `otherFeeds`, or null when it can. An
 * ingredient another feed already holds counts once and passes the ceilings.
 */
export function ingredientProblem(ingredient: FeedIngredient, feed: FeedIngredient[], otherFeeds: CustomFeed[]): 'duplicate' | 'feed-full' | 'entities-full' | 'keywords-full' | null {
  const key = ingredientKey(ingredient);
  if (feed.some(held => ingredientKey(held) === key)) return 'duplicate';
  if (feed.length >= MAX_FEED_INGREDIENTS) return 'feed-full';
  const ceiling = accountCeiling(ingredient);
  if (!ceiling) return null;
  const held = new Set([...feed, ...otherFeeds.flatMap(other => other.ingredients)]
    .filter(other => ceiling.kinds.includes(other.kind))
    .map(ingredientKey));
  return !held.has(key) && held.size >= ceiling.max ? ceiling.problem : null;
}

const feedOf = (id: string, input: CustomFeedInput): CustomFeed => ({ id, name: input.name.trim(), order: input.order, ingredients: [...input.ingredients] });

export function withFeedAdded(feeds: CustomFeed[], input: CustomFeedInput, id: string): CustomFeed[] {
  if (feeds.length >= MAX_CUSTOM_FEEDS) throw new CustomFeedError('feed-limit');
  return [...feeds, feedOf(id, input)];
}

export function withFeedChanged(feeds: CustomFeed[], id: string, input: CustomFeedInput): CustomFeed[] {
  if (!feeds.some(feed => feed.id === id)) throw new CustomFeedError('missing');
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

export function corpusRequestOf(feed: CustomFeed): { categories: string[]; areas: string[]; follows: FollowEntity[]; order: 'daily' | 'relevance' } {
  const categories: string[] = [];
  const areas: string[] = [];
  const follows: FollowEntity[] = [];
  for (const ingredient of feed.ingredients) {
    if (ingredient.kind === 'area') areas.push(ingredient.id);
    else if (ingredient.kind === 'category') categories.push(ingredient.id);
    else if (ingredient.kind === 'keyword') {
      follows.push({ type: 'topic', canonicalId: createQueryTopic(ingredient.query)!.id, displayName: ingredient.query, metadata: { query: ingredient.query } });
    } else follows.push({ type: ingredient.kind, canonicalId: ingredient.id, displayName: ingredient.label });
  }
  return { categories, areas, follows, order: feed.order === 'newest' ? 'daily' : 'relevance' };
}

/**
 * The ingredient a followed entity names: one of the app's areas or
 * categories, an OpenAlex topic or concept, a free-text topic as a keyword, or
 * an author by OpenAlex id. Anything else, an author known by name only
 * included, is null.
 */
export function ingredientFromFollow(entity: { type: string; id?: string; canonicalId?: string; displayName?: string; metadata?: { query?: string; categoryIds?: string[] } }): FeedIngredient | null {
  const id = entity.canonicalId ?? entity.id ?? '';
  if (entity.type === 'author') return parseIngredient({ kind: 'author', id, label: entity.displayName });
  if (entity.type !== 'topic' && entity.type !== 'concept') return null;
  if (getAreaLeaves(id)) return { kind: 'area', id };
  if (LEAF_IDS.has(id)) return { kind: 'category', id };
  if (TOPIC_ID.test(openAlexId(id))) return parseIngredient({ kind: 'topic', id, label: entity.displayName });
  return parseIngredient({ kind: 'keyword', query: entity.metadata?.query || entity.displayName });
}
