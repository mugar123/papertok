import {
  feedNameProblem,
  ingredientKey,
  ingredientProblem,
  MAX_CUSTOM_FEEDS,
  parseFeedIngredient,
  type CustomFeed,
  type CustomFeedInput,
  type CustomFeedOrder,
  type FeedIngredient,
} from './custom-feeds.ts';

// The state behind the window that creates and edits a custom feed. The store
// refuses a list that is not already in the parser's form, so the form holds
// only ingredients that came out of `parseFeedIngredient` and is checked here
// before it is sent: a refusal can then only mean another device changed the
// account's feeds meanwhile.

/** `saved`: the write landed and the window is leaving; nothing about the form is reported any more. */
export interface FeedFormState { name: string; order: CustomFeedOrder; ingredients: FeedIngredient[]; busy: boolean; failed: boolean; saved: boolean }
export type FeedFormAction =
  | { type: 'open'; preset?: Partial<CustomFeedInput> }
  | { type: 'name'; value: string } | { type: 'order'; value: CustomFeedOrder }
  | { type: 'add'; ingredient: FeedIngredient } | { type: 'remove'; key: string }
  | { type: 'submit' } | { type: 'failed' } | { type: 'saved' };

export const FEED_FORM_INITIAL: FeedFormState = Object.freeze({ name: '', order: 'newest', ingredients: [], busy: false, failed: false, saved: false });

export function feedFormReducer(state: FeedFormState, action: FeedFormAction): FeedFormState {
  switch (action.type) {
    case 'open':
      // Nothing from the last time the window was open survives an open.
      return {
        ...FEED_FORM_INITIAL,
        name: action.preset?.name ?? '',
        order: action.preset?.order ?? 'newest',
        ingredients: action.preset?.ingredients ?? [],
      };
    case 'name':
      return { ...state, name: action.value, failed: false };
    case 'order':
      return { ...state, order: action.value, failed: false };
    case 'add': {
      const key = ingredientKey(action.ingredient);
      if (state.ingredients.some(held => ingredientKey(held) === key)) return state;
      return { ...state, ingredients: [...state.ingredients, action.ingredient], failed: false };
    }
    case 'remove':
      return { ...state, ingredients: state.ingredients.filter(held => ingredientKey(held) !== action.key), failed: false };
    case 'submit':
      // Enter reaches the submit by its own path; a busy or saved form stays as it is.
      return state.busy || state.saved ? state : { ...state, busy: true, failed: false };
    case 'failed':
      return { ...state, busy: false, failed: true };
    case 'saved':
      // Still busy: the button stays pressed-out while the window leaves.
      return { ...state, failed: false, saved: true };
    default:
      return state;
  }
}

/**
 * The account's feeds other than the form's own: the feed being edited, or the
 * new feed's id once a create that outran its deadline has landed under it.
 */
export function otherFeedsOf(feeds: CustomFeed[], ownId?: string): CustomFeed[] {
  return feeds.filter(feed => feed.id !== ownId);
}

/**
 * Why the form cannot be sent, or null when it can. `feeds` are the account's
 * feeds; `ownId` the form's own feed (otherFeedsOf), which neither counts
 * against the eight nor takes its own name. A form being sent or saved
 * reports nothing.
 */
export function feedFormProblem(state: FeedFormState, feeds: CustomFeed[], ownId?: string): 'empty' | 'too-long' | 'taken' | 'no-ingredients' | 'feed-limit' | null {
  // The list a write commits is shown before the write resolves, and once it
  // holds this feed its own name is taken and the eight may be full. A form
  // being sent or already saved is not measured against it.
  if (state.busy || state.saved) return null;
  if (otherFeedsOf(feeds, ownId).length >= MAX_CUSTOM_FEEDS) return 'feed-limit';
  const nameProblem = feedNameProblem(state.name, feeds, ownId);
  if (nameProblem) return nameProblem;
  return state.ingredients.length === 0 ? 'no-ingredients' : null;
}

/**
 * The ingredients of a preset the form can hold, parsed and in order, given
 * the account's other feeds, and the first limit that kept one out.
 */
export function admitIngredients(raw: readonly unknown[], otherFeeds: CustomFeed[]): { ingredients: FeedIngredient[]; refused: 'feed-full' | 'entities-full' | 'keywords-full' | null } {
  const ingredients: FeedIngredient[] = [];
  let refused: 'feed-full' | 'entities-full' | 'keywords-full' | null = null;
  for (const item of raw) {
    const ingredient = parseFeedIngredient(item);
    if (!ingredient) continue;
    const problem = ingredientProblem(ingredient, ingredients, otherFeeds);
    if (!problem) ingredients.push(ingredient);
    else if (problem !== 'duplicate') refused ??= problem;
  }
  return { ingredients, refused };
}
