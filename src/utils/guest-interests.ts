type GuestStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type GuestAnswer = { areas?: unknown; topics?: unknown; readingLevel?: unknown; emailDigest?: unknown; institutionEmail?: unknown };

import { CATEGORIES } from '../data/categories.ts';
import { normalizeReadingPreferences } from './user-settings.ts';
import { institutionDomainOf } from './institution-domain.ts';

/**
 * What a visitor told us they care about, before they had an account.
 *
 * This is the one browser key on purpose NOT scoped to a user id: a guest has
 * no id to scope it to. It is a bridge, not a store — it lives from the
 * moment a guest answers the welcome until the answer has somewhere
 * better to go. Two things end it: the onboarding writes it into
 * `users/{uid}.preferences` (AuthContext's `completeOnboarding` clears it),
 * or a session that was already onboarded loads on this device (the profile
 * is the authority, and a pick left waiting here would seed the next new
 * account on a shared machine with a stranger's interests). Either way, the
 * next guest on this device starts from nothing.
 *
 * The answer is a list of area keys (`cs`, `bio`, …) and, optionally, the
 * specific topics chosen inside them (`cs.LG`, `bio.neuro`, … — the same
 * subcategory ids a member's `preferences` hold). An area with topics picked
 * means those topics; an area with none means all of it. So the quick answer
 * (areas only, which is also every answer stored before topics existed) keeps
 * meaning what it always did, and the onboarding pre-fills from either.
 */
export const GUEST_INTERESTS_STORAGE_KEY = 'papertok_guestInterests';

const AREA_KEYS = Object.freeze(Object.keys(CATEGORIES));

function getStorage(storage?: GuestStorage | null) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Unknown keys dropped, duplicates folded, taxonomy order kept: the stored
 * list is always something every consumer (the feed plan, the onboarding)
 * can hand straight to CATEGORIES.
 */
export function normalizeGuestAreas(areas: unknown) {
  if (!Array.isArray(areas)) return [];
  const wanted = new Set(areas.filter(area => typeof area === 'string'));
  return AREA_KEYS.filter(key => wanted.has(key));
}

/**
 * Topics are kept only where they mean something: a known subcategory of an
 * area that is itself chosen. Taxonomy order, deduplicated — so dropping an
 * area drops its topics with it.
 */
export function normalizeGuestTopics(topics: unknown, areas: unknown) {
  if (!Array.isArray(topics)) return [];
  const wanted = new Set(topics.filter(topic => typeof topic === 'string'));
  return normalizeGuestAreas(areas)
    .flatMap(key => Object.keys(CATEGORIES[key].subcategories))
    .filter(id => wanted.has(id));
}

/**
 * What a guest answer becomes when it turns into an account's `preferences`.
 *
 * Not every category of every area: the signed-in feed only sends its first
 * five preferences to arXiv and OpenAlex (three to PubMed), ranked by an
 * affinity a new account does not have yet, and its exploration step draws
 * from the siblings the preferences left out. Handing it all 26 physics
 * categories gave a physics-only first page and nothing left to explore. The
 * first GUEST_SEED_PER_AREA subcategories of each area, interleaved across
 * areas — physics[0], eess[0], mech[0], physics[1], … — so that a ranking
 * with nothing to go on still spreads its window over every area picked.
 * All thirteen areas make 63, well under the rules' cap of 100.
 */
export const GUEST_SEED_PER_AREA = 5;

// The rules' cap on a profile's preferences (firestore.rules), restated here
// so this module stays free of the onboarding's imports; guest-interests.test.ts
// holds the two to the same value.
export const GUEST_SEED_MAX = 100;

/**
 * An area the welcome narrowed to specific topics seeds exactly those — the
 * visitor named them — and one left whole seeds its first `perArea`. The
 * interleave keeps every area represented before any gets a second seat, and
 * the whole seed stops at the rules' cap, so even a visitor who ticked every
 * topic of every area gets a profile the rules accept.
 */
function guestSeedLists(areas: unknown, perArea: number, topics: unknown) {
  const chosen = normalizeGuestAreas(areas);
  const narrowed = new Set(normalizeGuestTopics(topics, chosen));
  return chosen.map((key) => {
    const all = Object.keys(CATEGORIES[key].subcategories);
    const picked = all.filter(id => narrowed.has(id));
    return picked.length > 0 ? picked : all.slice(0, perArea);
  });
}

/**
 * How many categories the same answer stands for BEFORE the cap: what the
 * onboarding shows the reader so they can drop topics themselves, rather than
 * have `guestSeedCategoriesForAreas` drop them without a word.
 */
export function guestSeedSizeForAreas(areas: readonly string[], perArea = GUEST_SEED_PER_AREA, topics: readonly string[] = []) {
  return guestSeedLists(areas, perArea, topics).reduce((count, list) => count + list.length, 0);
}

export function guestSeedCategoriesForAreas(areas: readonly string[], perArea = GUEST_SEED_PER_AREA, topics: readonly string[] = []) {
  const lists = guestSeedLists(areas, perArea, topics);
  const picked = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const list of lists) {
      if (index < list.length) {
        picked.push(list[index]);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked.slice(0, GUEST_SEED_MAX);
}

/**
 * `null` when the welcome has never been answered on this device. Otherwise
 * `{ areas, topics, dismissed, readingLevel?, emailDigest?, institutionEmail? }`: `dismissed`
 * marks an answer with no areas, which seeds nothing.
 */
export function readGuestInterests(storage?: GuestStorage | null) {
  const target = getStorage(storage);
  if (!target) return null;

  try {
    const parsed = JSON.parse(target.getItem(GUEST_INTERESTS_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const areas = normalizeGuestAreas(parsed.areas);
    const topics = normalizeGuestTopics(parsed.topics, areas);
    const dismissed = parsed.dismissedAt != null || areas.length === 0;
    const reading = ['beginner', 'university', 'researcher'].includes(parsed.readingLevel)
      ? { readingLevel: parsed.readingLevel } : {};
    // Present only as an explicit yes: email is opt-in, so anything else —
    // an old answer, a no, a malformed value — reads as no.
    const email = parsed.emailDigest === true ? { emailDigest: true } : {};
    const institution = institutionDomainOf(parsed.institutionEmail)
      ? { institutionEmail: String(parsed.institutionEmail).trim().toLowerCase() } : {};
    return { areas, topics, dismissed, ...reading, ...email, ...institution };
  } catch {
    return null;
  }
}

/**
 * Takes the areas alone or `{ areas, topics }` (the welcome). Returns the normalized list of areas that was actually stored;
 * `readGuestInterests` has the topics and optional reading level. The level
 * travels with this guest bridge until account onboarding saves it to the UID,
 * and so does an explicit yes to the email digest (`emailDigest: true`) and a
 * university address, which the account onboarding sends a verification to.
 */
export function saveGuestInterests(answer: GuestAnswer | unknown[] | null | undefined, storage?: GuestStorage | null) {
  const areas = Array.isArray(answer) ? answer : answer?.areas;
  const normalized = normalizeGuestAreas(areas);
  const topics = Array.isArray(answer) ? [] : normalizeGuestTopics(answer?.topics, normalized);
  const target = getStorage(storage);
  if (!target) return normalized;

  try {
    if (normalized.length === 0) {
      // An emptied pick is kept as dismissed: it seeds nothing.
      target.setItem(GUEST_INTERESTS_STORAGE_KEY, JSON.stringify({ areas: [], dismissedAt: Date.now() }));
    } else {
      target.setItem(GUEST_INTERESTS_STORAGE_KEY, JSON.stringify({
        areas: normalized,
        topics,
        ...((answer as GuestAnswer | null | undefined)?.readingLevel ? { readingLevel: normalizeReadingPreferences({ aiExplanationLevel: (answer as GuestAnswer).readingLevel }).aiExplanationLevel } : {}),
        ...((answer as GuestAnswer | null | undefined)?.emailDigest === true ? { emailDigest: true } : {}),
        ...(institutionDomainOf((answer as GuestAnswer | null | undefined)?.institutionEmail)
          ? { institutionEmail: String((answer as GuestAnswer).institutionEmail).trim().toLowerCase() } : {}),
        dismissedAt: null,
        updatedAt: Date.now(),
      }));
    }
  } catch {
    // A device that cannot remember the answer still gets the feed it asked
    // for this visit; it is only asked again next time.
  }
  return normalized;
}

export function clearGuestInterests(storage?: GuestStorage | null) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(GUEST_INTERESTS_STORAGE_KEY);
  } catch {
    // Nothing to do: the next read fails closed to "never answered".
  }
}
