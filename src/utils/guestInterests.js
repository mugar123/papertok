import { CATEGORIES } from '../data/categories.js';

/**
 * What a visitor told us they care about, before they had an account.
 *
 * This is the one browser key on purpose NOT scoped to a user id: a guest has
 * no id to scope it to. It is a bridge, not a store — it lives from the
 * moment a guest answers the interests prompt until the answer has somewhere
 * better to go. Two things end it: the onboarding writes it into
 * `users/{uid}.preferences` (AuthContext's `completeOnboarding` clears it),
 * or a session that was already onboarded loads on this device (the profile
 * is the authority, and a pick left waiting here would seed the next new
 * account on a shared machine with a stranger's interests). Either way, the
 * next guest on this device starts from nothing.
 *
 * The answer is a list of area keys (`cs`, `bio`, …), not subcategories: a
 * guest is asked one quick question, and the onboarding is where the fine
 * grain gets chosen — pre-filled from this.
 */
export const GUEST_INTERESTS_STORAGE_KEY = 'papertok_guestInterests';

const AREA_KEYS = Object.freeze(Object.keys(CATEGORIES));

function getStorage(storage) {
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
export function normalizeGuestAreas(areas) {
  if (!Array.isArray(areas)) return [];
  const wanted = new Set(areas.filter(area => typeof area === 'string'));
  return AREA_KEYS.filter(key => wanted.has(key));
}

/**
 * Every subcategory id under the given areas, in taxonomy order. This is what
 * `preferences` holds for a signed-in user, so it is what the onboarding
 * pre-selects and what the domain source plan is routed by.
 */
export function guestCategoriesForAreas(areas) {
  return normalizeGuestAreas(areas)
    .flatMap(key => Object.keys(CATEGORIES[key].subcategories));
}

/**
 * `null` when the prompt has never been answered on this device. Otherwise
 * `{ areas, dismissed }`: `dismissed` is a "not now" (or a pick emptied out),
 * which the prompt honours by not asking again — the header chip stays as
 * the way back in.
 */
export function readGuestInterests(storage) {
  const target = getStorage(storage);
  if (!target) return null;

  try {
    const parsed = JSON.parse(target.getItem(GUEST_INTERESTS_STORAGE_KEY) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const areas = normalizeGuestAreas(parsed.areas);
    const dismissed = parsed.dismissedAt != null || areas.length === 0;
    return { areas, dismissed };
  } catch {
    return null;
  }
}

/** Returns the normalized list that was actually stored. */
export function saveGuestInterests(areas, storage) {
  const normalized = normalizeGuestAreas(areas);
  const target = getStorage(storage);
  if (!target) return normalized;

  try {
    if (normalized.length === 0) {
      // An emptied pick is a "not now": the feed goes back to the default
      // sample and the prompt does not come back on its own.
      target.setItem(GUEST_INTERESTS_STORAGE_KEY, JSON.stringify({ areas: [], dismissedAt: Date.now() }));
    } else {
      target.setItem(GUEST_INTERESTS_STORAGE_KEY, JSON.stringify({
        areas: normalized,
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

export function dismissGuestInterests(storage) {
  saveGuestInterests([], storage);
}

export function clearGuestInterests(storage) {
  const target = getStorage(storage);
  if (!target) return;

  try {
    target.removeItem(GUEST_INTERESTS_STORAGE_KEY);
  } catch {
    // Nothing to do: the next read fails closed to "never answered".
  }
}
