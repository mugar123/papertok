/**
 * Derived aggregate of `users/{uid}/interactions`.
 *
 * The feed used to rebuild its whole recommendation profile by reading that
 * subcollection in full on every load, which costs one Firestore read per paper
 * the user has ever scrolled past. This module holds the same information in a
 * single document that is maintained incrementally, so a feed load costs one
 * read no matter how old the account is.
 *
 * The individual interaction documents remain the source of truth. Everything
 * here is reconstructible from them, which is what makes it safe for the
 * browser to write the aggregate directly: a corrupt or stale aggregate is
 * repaired by bumping the schema version and letting the bounded rebuild path
 * run once.
 *
 * ── How the category affinities survive being incremental ──
 * The old full scan weighted every interaction by `max(0.2, exp(-ageDays/30))`,
 * a factor that changes every second, so a plain running total cannot
 * reproduce it. Exponential decay is separable, though: an interaction's weight
 * at read time is its weight at its own cohort's day start times a factor that
 * depends only on the cohort. So each category keeps one bucket per day for the
 * ~48 days where the exponential is above the 0.2 floor, holding the sum of
 * `impact * exp((t - dayStart)/30d)`. Reading multiplies each bucket by
 * `exp(-cohortAgeDays/30)`, which reproduces the original per-item decay
 * exactly. Once a whole bucket falls past the floor its raw impact merges into
 * a single aged accumulator weighted at the flat 0.2, and the bucket is
 * dropped. That bounds a category at ~50 numbers regardless of history.
 */
import { CATEGORIES, getCategorySimilarity } from '../data/categories.js';
import {
  addSeenPaper,
  createSeenFilter,
  deserializeSeenFilter,
  hasSeenPaper,
  isSeenFilterEmpty,
  serializeSeenFilter,
} from './seenPaperFilter.js';

export const INTERACTION_PROFILE_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_DAYS = 30;
const DECAY_FLOOR = 0.2;
// exp(-age/30) crosses the 0.2 floor here; buckets older than this plus a full
// day have every item past the floor and can be merged away.
const FLOOR_AGE_DAYS = DECAY_DAYS * Math.log(1 / DECAY_FLOOR);
const MAX_COHORT_AGE_DAYS = FLOOR_AGE_DAYS + 1;

export const AFFINITY_MIN = -10;
export const AFFINITY_MAX = 100;

// Impact weights, byte for byte the ones the full scan used.
const IMPACT_LIKED = 5;
const IMPACT_SAVED = 8;
const IMPACT_OPENED_PDF = 4;
const IMPACT_VIEW_TIME_PER_SECOND = 0.25;
const IMPACT_VIEW_TIME_CAP_SECONDS = 60;
const IMPACT_SKIP = -1;
const IMPACT_PDF_BOUNCE = -2;
const IMPACT_NOT_INTERESTED = -10;

export const CURATED_SETS = Object.freeze(['liked', 'saved', 'read', 'notInterested', 'readLater']);

// Caps chosen so the serialised curated payload stays far below the 1 MiB
// document limit even with long DOI-shaped ids. Anything evicted moves into the
// Bloom filter, so the feed still never repeats it.
export const CURATED_ID_CAPS = Object.freeze({
  liked: 2000,
  saved: 2000,
  read: 4000,
  notInterested: 3000,
  readLater: 1000,
});

export const MAX_CURATED_JSON_BYTES = 320000;
export const MAX_AFFINITY_JSON_BYTES = 120000;
export const MAX_TRACKED_CATEGORIES = 300;

function dayIndexOf(timestampMs) {
  return Math.floor(timestampMs / DAY_MS);
}

function toTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function createEmptyInteractionProfile() {
  return {
    version: INTERACTION_PROFILE_SCHEMA_VERSION,
    updatedAt: null,
    categories: new Map(),
    cooldowns: new Map(),
    curated: new Map(CURATED_SETS.map(name => [name, { order: [], members: new Set() }])),
    seenFilter: null,
    counters: { interactions: 0, evicted: 0 },
    // Papers already counted towards sourceDocCount in this session. In memory
    // only: it exists to stop one session counting the same paper twice.
    countedPapers: new Set(),
    sourceDocCount: 0,
    truncated: false,
  };
}

function categoryBucket(profile, category) {
  let bucket = profile.categories.get(category);
  if (!bucket) {
    bucket = { cohorts: new Map(), aged: 0 };
    profile.categories.set(category, bucket);
  }
  return bucket;
}

/**
 * Adds `impact` to `category`, dated at `timestampMs`. Interactions with no
 * usable timestamp keep the full scan's behaviour of an undecayed weight of 1,
 * which is modelled as a cohort dated now.
 */
function addImpact(profile, category, impact, timestampMs) {
  if (typeof category !== 'string' || !category) return;
  const bucket = categoryBucket(profile, category);
  if (impact === 0) return;

  const day = dayIndexOf(timestampMs);
  const dayStart = day * DAY_MS;
  // Rebase to the cohort's own day start so the stored exponent stays inside
  // [0, 1/30] and no global re-basing pass is ever needed.
  const rebased = impact * Math.exp((timestampMs - dayStart) / (DECAY_DAYS * DAY_MS));
  const cohort = bucket.cohorts.get(day) || { weighted: 0, raw: 0 };
  cohort.weighted += rebased;
  cohort.raw += impact;
  bucket.cohorts.set(day, cohort);
}

function compactCategories(profile, now) {
  const oldestLiveDay = dayIndexOf(now - MAX_COHORT_AGE_DAYS * DAY_MS);
  profile.categories.forEach((bucket) => {
    bucket.cohorts.forEach((cohort, day) => {
      if (day < oldestLiveDay) {
        bucket.aged += cohort.raw;
        bucket.cohorts.delete(day);
      }
    });
  });

  if (profile.categories.size <= MAX_TRACKED_CATEGORIES) return;
  // Keep the categories that actually move the ranking.
  const ranked = [...profile.categories.keys()]
    .map(category => [category, Math.abs(categoryAffinityAt(profile, category, now))])
    .sort((a, b) => b[1] - a[1]);
  ranked.slice(MAX_TRACKED_CATEGORIES).forEach(([category]) => profile.categories.delete(category));
}

function categoryAffinityAt(profile, category, now) {
  const bucket = profile.categories.get(category);
  if (!bucket) return 0;
  let total = DECAY_FLOOR * bucket.aged;
  bucket.cohorts.forEach((cohort, day) => {
    const ageDays = (now - day * DAY_MS) / DAY_MS;
    const decay = Math.exp(-ageDays / DECAY_DAYS);
    total += decay >= DECAY_FLOOR ? cohort.weighted * decay : DECAY_FLOOR * cohort.raw;
  });
  return total;
}

/**
 * Materialises the two maps `scorePaperForRecommendation` consumes.
 */
export function readCategorySignals(profile, now = Date.now()) {
  const affinities = {};
  const cooldowns = {};
  if (!profile) return { affinities, cooldowns };

  profile.categories.forEach((_bucket, category) => {
    affinities[category] = Math.max(
      AFFINITY_MIN,
      Math.min(AFFINITY_MAX, categoryAffinityAt(profile, category, now)),
    );
  });
  profile.cooldowns.forEach((timestampMs, category) => {
    cooldowns[category] = timestampMs;
  });
  return { affinities, cooldowns };
}

function applyNotInterestedSpread(profile, category, timestampMs) {
  // The full scan walked every leaf category and penalised the ones that share
  // an area with the rejected one. getCategorySimilarity only ever returns 0.8
  // (same prefix) or 0.4 (same area) for distinct categories, so the walk is
  // bounded by the largest area.
  Object.keys(CATEGORIES).forEach((areaKey) => {
    Object.keys(CATEGORIES[areaKey].subcategories).forEach((otherCategory) => {
      if (otherCategory === category) return;
      const similarity = getCategorySimilarity(category, otherCategory);
      if (similarity <= 0) return;
      const penalty = similarity >= 0.8 ? -5 : similarity >= 0.4 ? -3 : -1;
      addImpact(profile, otherCategory, penalty, timestampMs);
    });
  });
}

function curatedSet(profile, name) {
  return profile.curated.get(name);
}

function ensureSeenFilter(profile) {
  if (!profile.seenFilter) profile.seenFilter = createSeenFilter();
  return profile.seenFilter;
}

function addCurated(profile, name, paperId) {
  const set = curatedSet(profile, name);
  if (!set || typeof paperId !== 'string' || !paperId) return;
  if (set.members.has(paperId)) {
    // Refresh recency so the newest action stays inside the cap.
    const position = set.order.indexOf(paperId);
    if (position > 0) {
      set.order.splice(position, 1);
      set.order.unshift(paperId);
    }
    return;
  }
  set.members.add(paperId);
  set.order.unshift(paperId);

  const cap = CURATED_ID_CAPS[name];
  while (set.order.length > cap) {
    const evicted = set.order.pop();
    set.members.delete(evicted);
    addSeenPaper(ensureSeenFilter(profile), evicted);
    profile.counters.evicted += 1;
  }
}

function removeCurated(profile, name, paperId) {
  const set = curatedSet(profile, name);
  if (!set || !set.members.has(paperId)) return;
  set.members.delete(paperId);
  const position = set.order.indexOf(paperId);
  if (position >= 0) set.order.splice(position, 1);
}

export function curatedIds(profile, name) {
  const set = profile && curatedSet(profile, name);
  return set ? [...set.order] : [];
}

export function curatedIdSet(profile, name) {
  const set = profile && curatedSet(profile, name);
  return set ? new Set(set.members) : new Set();
}

/**
 * True when the paper is already known to the profile and must stay out of the
 * feed. Exact for everything inside the caps; beyond them the Bloom filter can
 * only err towards hiding a paper the user has not seen, never towards
 * repeating one they have.
 */
export function isPaperKnown(profile, paperId) {
  if (!profile || typeof paperId !== 'string' || !paperId) return false;
  for (const name of CURATED_SETS) {
    if (name === 'readLater') continue;
    if (curatedSet(profile, name).members.has(paperId)) return true;
  }
  return hasSeenPaper(profile.seenFilter, paperId);
}

/**
 * Whether this paper's interaction document is already reflected in
 * `sourceDocCount`.
 *
 * Membership of a curated set proves the rebuild counted its document. Beyond
 * that we only know what this session has seen, so a paper touched in an
 * earlier session with nothing but skips gets counted again. That biases
 * `sourceDocCount` upwards, which is the safe direction: the drift check
 * subtracts it from the true document count, so an over-count can only
 * under-report drift, never invent it and trigger a needless rebuild.
 */
function isPaperAccountedFor(profile, paperId) {
  if (profile.countedPapers.has(paperId)) return true;
  return CURATED_SETS.some(name => curatedSet(profile, name).members.has(paperId));
}

/**
 * Folds one interaction into the profile.
 *
 * @param {object} profile
 * @param {object} event
 * @param {string} event.paperId
 * @param {string} event.kind one of like, unlike, save, read, unread, readLater,
 *   notInterested, openedPdf, pdfBounce, skip, viewTime, metadata
 * @param {string} [event.category] the paper's primary category
 * @param {number|string} [event.timestamp]
 * @param {number} [event.viewTime] seconds, for kind === 'viewTime'
 * @param {boolean} [event.value] for the toggles that carry one
 */
export function recordInteractionEvent(profile, event, now = Date.now()) {
  if (!profile || !event || typeof event.paperId !== 'string' || !event.paperId) return profile;
  const timestampMs = toTimestampMs(event.timestamp) ?? now;
  const category = typeof event.category === 'string' ? event.category : '';
  // Sampled before the switch: applying the event may add the id to a curated
  // set, which would make it look accounted for when it is not yet.
  const alreadyAccountedFor = isPaperAccountedFor(profile, event.paperId);

  switch (event.kind) {
    case 'like':
      addCurated(profile, 'liked', event.paperId);
      addImpact(profile, category, IMPACT_LIKED, timestampMs);
      break;
    case 'unlike':
      removeCurated(profile, 'liked', event.paperId);
      addImpact(profile, category, -IMPACT_LIKED, timestampMs);
      break;
    case 'save':
      addCurated(profile, 'saved', event.paperId);
      addImpact(profile, category, IMPACT_SAVED, timestampMs);
      break;
    case 'read':
      addCurated(profile, 'read', event.paperId);
      break;
    case 'unread':
      removeCurated(profile, 'read', event.paperId);
      break;
    case 'readLater':
      if (event.value === false) removeCurated(profile, 'readLater', event.paperId);
      else addCurated(profile, 'readLater', event.paperId);
      break;
    case 'notInterested':
      addCurated(profile, 'notInterested', event.paperId);
      addImpact(profile, category, IMPACT_NOT_INTERESTED, timestampMs);
      if (category) {
        applyNotInterestedSpread(profile, category, timestampMs);
        const current = profile.cooldowns.get(category);
        if (!current || timestampMs > current) profile.cooldowns.set(category, timestampMs);
      }
      break;
    case 'openedPdf':
      addImpact(profile, category, IMPACT_OPENED_PDF, timestampMs);
      break;
    case 'pdfBounce':
      addImpact(profile, category, IMPACT_PDF_BOUNCE, timestampMs);
      break;
    case 'skip':
      addImpact(profile, category, IMPACT_SKIP, timestampMs);
      break;
    case 'viewTime': {
      const seconds = Number(event.viewTime);
      if (!Number.isFinite(seconds) || seconds <= 0) return profile;
      addImpact(
        profile,
        category,
        Math.min(seconds, IMPACT_VIEW_TIME_CAP_SECONDS) * IMPACT_VIEW_TIME_PER_SECOND,
        timestampMs,
      );
      break;
    }
    case 'metadata':
      break;
    default:
      return profile;
  }

  if (!alreadyAccountedFor) {
    profile.countedPapers.add(event.paperId);
    // One interaction document per paper, so a paper new to this profile means
    // one more document the aggregate now accounts for.
    profile.sourceDocCount += 1;
  }
  profile.counters.interactions += 1;
  profile.updatedAt = new Date(now).toISOString();
  compactCategories(profile, now);
  return profile;
}

/**
 * Impact of one interaction document from its final state, exactly as the old
 * full scan derived it.
 */
export function interactionDocumentImpact(data) {
  let impact = 0;
  if (data.liked) impact += IMPACT_LIKED;
  if (data.saved) impact += IMPACT_SAVED;
  if (data.openedPdf) impact += IMPACT_OPENED_PDF;
  if (data.viewTime) {
    impact += Math.min(data.viewTime, IMPACT_VIEW_TIME_CAP_SECONDS) * IMPACT_VIEW_TIME_PER_SECOND;
  }
  if (data.skip) impact += IMPACT_SKIP;
  if (data.pdfBounce) impact += IMPACT_PDF_BOUNCE;
  if (data.notInterested) impact += IMPACT_NOT_INTERESTED;
  return impact;
}

/**
 * Rebuilds a profile from raw interaction documents. Used by the one-off client
 * fallback and by the offline backfill script, and it is the reference the unit
 * tests compare the incremental path against.
 *
 * @param {Array<{id: string, data: object}>} documents ordered newest first
 */
export function buildProfileFromInteractionDocuments(documents, { now = Date.now() } = {}) {
  const profile = createEmptyInteractionProfile();

  documents.forEach(({ id, data }) => {
    if (typeof id !== 'string' || !id || !data) return;
    profile.sourceDocCount += 1;

    if (data.liked) addCurated(profile, 'liked', id);
    if (data.saved) addCurated(profile, 'saved', id);
    if (data.read) addCurated(profile, 'read', id);
    if (data.notInterested) addCurated(profile, 'notInterested', id);
    if (data.readLater) addCurated(profile, 'readLater', id);

    const category = typeof data.paperCategory === 'string' ? data.paperCategory : '';
    if (!category) return;

    // Mirror the full scan: a category seen at all exists, even at zero.
    categoryBucket(profile, category);

    const timestampMs = toTimestampMs(data.timestamp);
    // No timestamp meant an undecayed weight of 1, which is a cohort dated now.
    const effectiveTimestamp = timestampMs ?? now;
    addImpact(profile, category, interactionDocumentImpact(data), effectiveTimestamp);

    if (data.notInterested) {
      applyNotInterestedSpread(profile, category, effectiveTimestamp);
      if (timestampMs !== null) {
        const current = profile.cooldowns.get(category);
        if (!current || timestampMs > current) profile.cooldowns.set(category, timestampMs);
      }
    }
  });

  documents.forEach(({ id }) => profile.countedPapers.add(id));
  profile.counters.interactions = profile.sourceDocCount;
  profile.updatedAt = new Date(now).toISOString();
  compactCategories(profile, now);
  return profile;
}

function serializeAffinities(profile) {
  const categories = {};
  profile.categories.forEach((bucket, category) => {
    const cohorts = {};
    bucket.cohorts.forEach((cohort, day) => {
      // Six significant digits keeps the payload small; the values feed a
      // ranking that is clamped and shuffled afterwards.
      cohorts[day] = [Number(cohort.weighted.toPrecision(6)), Number(cohort.raw.toPrecision(6))];
    });
    categories[category] = { c: cohorts, a: Number(bucket.aged.toPrecision(6)) };
  });
  const cooldowns = {};
  profile.cooldowns.forEach((timestampMs, category) => {
    cooldowns[category] = timestampMs;
  });
  return JSON.stringify({ categories, cooldowns });
}

function trimCuratedToBudget(payload) {
  let serialized = JSON.stringify(payload);
  while (serialized.length > MAX_CURATED_JSON_BYTES) {
    const largest = CURATED_SETS
      .map(name => [name, payload[name].length])
      .sort((a, b) => b[1] - a[1])[0];
    if (!largest || largest[1] === 0) break;
    // Drop the oldest quarter of the biggest set; the Bloom filter already
    // holds anything evicted, so the feed still cannot repeat these.
    payload[largest[0]] = payload[largest[0]].slice(0, Math.floor(largest[1] * 0.75));
    serialized = JSON.stringify(payload);
  }
  return serialized;
}

/**
 * @returns {object} the Firestore document body.
 */
export function serializeInteractionProfile(profile) {
  const curatedPayload = {};
  CURATED_SETS.forEach((name) => {
    curatedPayload[name] = curatedIds(profile, name);
  });

  const curatedJson = trimCuratedToBudget(curatedPayload);
  // Everything the budget trimmer dropped has to reach the Bloom filter too.
  CURATED_SETS.forEach((name) => {
    const kept = new Set(curatedPayload[name]);
    curatedIds(profile, name).forEach((paperId) => {
      if (!kept.has(paperId)) {
        addSeenPaper(ensureSeenFilter(profile), paperId);
        profile.counters.evicted += 1;
      }
    });
  });

  const affinitiesJson = serializeAffinities(profile);
  if (affinitiesJson.length > MAX_AFFINITY_JSON_BYTES) {
    throw new RangeError(
      `Serialised affinities are ${affinitiesJson.length} bytes, over the ${MAX_AFFINITY_JSON_BYTES} budget.`,
    );
  }

  const document = {
    schemaVersion: INTERACTION_PROFILE_SCHEMA_VERSION,
    updatedAt: profile.updatedAt || new Date().toISOString(),
    affinities: affinitiesJson,
    curated: curatedJson,
    interactionCount: profile.counters.interactions,
    evictedCount: profile.counters.evicted,
    sourceDocCount: profile.sourceDocCount,
    truncated: Boolean(profile.truncated),
  };

  const seenFilter = isSeenFilterEmpty(profile.seenFilter)
    ? null
    : serializeSeenFilter(profile.seenFilter);
  if (seenFilter) document.seenFilter = seenFilter;
  return document;
}

/**
 * @returns {object|null} null when the payload is missing, from another schema
 *   version or unparseable, which sends the caller down the rebuild path.
 */
export function deserializeInteractionProfile(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.schemaVersion !== INTERACTION_PROFILE_SCHEMA_VERSION) return null;

  const profile = createEmptyInteractionProfile();
  try {
    const affinities = JSON.parse(data.affinities || '{}');
    Object.entries(affinities.categories || {}).forEach(([category, bucket]) => {
      const cohorts = new Map();
      Object.entries(bucket?.c || {}).forEach(([day, pair]) => {
        if (!Array.isArray(pair)) return;
        cohorts.set(Number(day), { weighted: Number(pair[0]) || 0, raw: Number(pair[1]) || 0 });
      });
      profile.categories.set(category, { cohorts, aged: Number(bucket?.a) || 0 });
    });
    Object.entries(affinities.cooldowns || {}).forEach(([category, timestampMs]) => {
      const value = Number(timestampMs);
      if (Number.isFinite(value)) profile.cooldowns.set(category, value);
    });

    const curated = JSON.parse(data.curated || '{}');
    CURATED_SETS.forEach((name) => {
      const ids = Array.isArray(curated[name]) ? curated[name] : [];
      const set = curatedSet(profile, name);
      ids.forEach((paperId) => {
        if (typeof paperId !== 'string' || !paperId || set.members.has(paperId)) return;
        set.members.add(paperId);
        set.order.push(paperId);
      });
    });
  } catch {
    return null;
  }

  profile.seenFilter = deserializeSeenFilter(data.seenFilter);
  profile.counters.interactions = Number(data.interactionCount) || 0;
  profile.counters.evicted = Number(data.evictedCount) || 0;
  profile.sourceDocCount = Number(data.sourceDocCount) || 0;
  profile.truncated = Boolean(data.truncated);
  profile.updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null;
  return profile;
}

export function interactionProfileNeedsRebuild(data) {
  return deserializeInteractionProfile(data) === null;
}
