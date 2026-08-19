/**
 * Loading strategy for the interaction profile aggregate.
 *
 * The happy path is a single document read. The rebuild path only runs when the
 * aggregate is missing, from an older schema version or unparseable, and it is
 * bounded twice over: by a hard document ceiling, and by a per-session cache so
 * a failing write can never turn the fallback back into the unbounded scan this
 * whole change exists to remove.
 *
 * Every dependency is injected, which keeps the module free of the Firebase SDK
 * and lets the cost test assert the exact number of reads a feed load performs.
 *
 * ── Why the result is a tagged union ──
 * An earlier version returned `{ profile, rebuildSuppressed }`, where a refusal
 * to load handed back an empty profile that looked exactly like a new account's.
 * FeedContext could not tell them apart and wrote the empty one into React
 * state, so a user with 39 likes saw none. The three outcomes now have three
 * different shapes, and the one that has no profile does not carry a `profile`
 * property at all — reaching for it yields undefined rather than a plausible
 * lie, so the states cannot be conflated by forgetting to check a flag.
 */
import {
  buildProfileFromInteractionDocuments,
  deserializeInteractionProfile,
  serializeInteractionProfile,
} from './interactionProfile.js';

export const REBUILD_PAGE_SIZE = 500;
// One rebuild is the price of onboarding a pre-aggregate account. This ceiling
// keeps that price bounded and predictable; accounts past it get a profile
// flagged `truncated` rather than an unbounded read.
export const REBUILD_MAX_DOCUMENTS = 5000;

// A profile can fall behind its subcollection: a session whose profile came back
// UNAVAILABLE records into `interactions` but is barred from writing the
// aggregate, and two tabs open at once resolve to last-write-wins. Neither loses
// data, but both leave likes the aggregate has never seen, so the user watches
// them vanish on the next load. Comparing the aggregate's own document count
// against the real one catches both.
//
// The comparison is deliberately slack. `sourceDocCount` is biased upwards (see
// isPaperAccountedFor), so the estimate already under-reports, and a rebuild
// costs up to REBUILD_MAX_DOCUMENTS reads: it must be worth paying for.
export const DRIFT_MIN_MISSING_DOCS = 25;
export const DRIFT_MISSING_RATIO = 0.02;

export function driftRebuildThreshold(accountedDocuments = 0) {
  return Math.max(DRIFT_MIN_MISSING_DOCS, Math.ceil(accountedDocuments * DRIFT_MISSING_RATIO));
}

export const INTERACTION_PROFILE_STATUS = Object.freeze({
  /** A real profile came back: from the stored aggregate, or from a rebuild. */
  LOADED: 'loaded',
  /** Determined with certainty that there is nothing yet. A new account. */
  EMPTY: 'empty',
  /** Could not be determined. Carries NO profile. Callers must keep what they have. */
  UNAVAILABLE: 'unavailable',
});

function loadedResult(profile, meta) {
  return Object.freeze({ status: INTERACTION_PROFILE_STATUS.LOADED, profile, ...meta });
}

function emptyResult(profile, meta) {
  return Object.freeze({ status: INTERACTION_PROFILE_STATUS.EMPTY, profile, ...meta });
}

/**
 * Deliberately has no `profile` key. This is the whole point of the union: code
 * that skips the status check gets `undefined`, not an empty profile it would
 * happily render over the user's real data.
 */
export function unavailableInteractionProfile({ reads = 0, reason = 'unknown' } = {}) {
  return Object.freeze({ status: INTERACTION_PROFILE_STATUS.UNAVAILABLE, reads, reason });
}

export function hasInteractionProfile(result) {
  return result?.status === INTERACTION_PROFILE_STATUS.LOADED
    || result?.status === INTERACTION_PROFILE_STATUS.EMPTY;
}

/**
 * One entry per account per session, holding the in-flight or settled rebuild.
 * Concurrent loads of the same account share it instead of racing, and a second
 * load after the first finished reuses its result for free.
 */
const sessionRebuilds = new Map();

export function resetSessionRebuilds() {
  sessionRebuilds.clear();
}

function sortByRecencyDescending(documents) {
  return [...documents].sort((a, b) => {
    const left = Date.parse(a?.data?.timestamp || a?.data?.libraryUpdatedAt || '') || 0;
    const right = Date.parse(b?.data?.timestamp || b?.data?.libraryUpdatedAt || '') || 0;
    return right - left;
  });
}

/**
 * Reads at most REBUILD_MAX_DOCUMENTS interaction documents, oldest page first,
 * paginating by document id so no document is silently skipped the way an
 * orderBy on an optional field would.
 */
export async function rebuildInteractionProfile({
  listInteractionPage,
  now = Date.now(),
  pageSize = REBUILD_PAGE_SIZE,
  maxDocuments = REBUILD_MAX_DOCUMENTS,
}) {
  const documents = [];
  let cursor = null;
  let reads = 0;
  let truncated = false;

  while (documents.length < maxDocuments) {
    const remaining = maxDocuments - documents.length;
    const page = await listInteractionPage({
      pageSize: Math.min(pageSize, remaining),
      startAfterId: cursor,
    });
    const batch = page?.documents || [];
    reads += batch.length;
    documents.push(...batch);
    cursor = batch.length ? batch[batch.length - 1].id : null;

    if (!page?.hasMore || !batch.length) break;
    if (documents.length >= maxDocuments) {
      truncated = true;
      break;
    }
  }

  const profile = buildProfileFromInteractionDocuments(sortByRecencyDescending(documents), { now });
  profile.truncated = truncated;
  return { profile, reads, truncated, documentsRead: documents.length };
}

/**
 * @param {object} deps
 * @param {() => Promise<{exists: boolean, data: object|null}>} deps.readAggregate one Firestore read
 * @param {(cursor: {pageSize: number, startAfterId: string|null}) => Promise<{documents: Array, hasMore: boolean}>} deps.listInteractionPage
 * @param {(document: object) => Promise<void>} [deps.writeAggregate]
 * @param {string} [deps.userId] keys the per-session rebuild cache
 * @returns {Promise<object>} one of the three shapes in INTERACTION_PROFILE_STATUS
 */
export async function loadInteractionProfile({
  readAggregate,
  listInteractionPage,
  writeAggregate,
  countInteractions,
  checkDrift = false,
  userId = null,
  now = Date.now(),
  pageSize = REBUILD_PAGE_SIZE,
  maxDocuments = REBUILD_MAX_DOCUMENTS,
  rebuildCache = sessionRebuilds,
}) {
  let reads = 0;
  let snapshot;
  try {
    snapshot = await readAggregate();
    reads += 1;
  } catch (error) {
    return unavailableInteractionProfile({ reads, reason: `aggregate-read-failed: ${error.message}` });
  }

  const stored = snapshot?.exists ? deserializeInteractionProfile(snapshot.data) : null;
  const cacheKey = userId ? `interactions:${userId}` : null;

  if (stored) {
    const drift = checkDrift && countInteractions
      ? await measureDrift(countInteractions, stored)
      : null;
    if (drift) reads += drift.reads;

    if (!drift?.exceedsThreshold) {
      // A stored aggregate is real data even when its id lists happen to be
      // empty, so this is LOADED rather than EMPTY.
      return loadedResult(stored, {
        reads, rebuilt: false, truncated: stored.truncated, drift: drift?.report || null,
      });
    }

    console.warn(
      `[Recomendador] El agregado ignora ${drift.missing} documentos de interacción `
      + `(${drift.accounted} contabilizados frente a ${drift.actual} reales); se reconstruye.`,
    );
    // Fall through to the rebuild, sharing the same per-session cache so the
    // repair is still paid for at most once.
    return rebuildAndCache({
      cacheKey, rebuildCache, listInteractionPage, writeAggregate,
      now, pageSize, maxDocuments, reads, drift: drift.report,
    });
  }

  return rebuildAndCache({
    cacheKey, rebuildCache, listInteractionPage, writeAggregate,
    now, pageSize, maxDocuments, reads, drift: null,
  });
}

/**
 * @returns {{reads: number, missing: number, exceedsThreshold: boolean}|null}
 *   null when the count could not be taken, which is never a reason to rebuild.
 */
async function measureDrift(countInteractions, stored) {
  try {
    const { count, reads = 1 } = await countInteractions();
    const accounted = stored.sourceDocCount || 0;
    const missing = count - accounted;
    const threshold = driftRebuildThreshold(accounted);
    return {
      reads,
      missing,
      accounted,
      actual: count,
      exceedsThreshold: missing > threshold,
      report: { accounted, actual: count, missing, threshold },
    };
  } catch (error) {
    // A failed count must never cost the user their profile.
    console.warn('Could not verify the interaction profile against its subcollection:', error);
    return null;
  }
}

async function rebuildAndCache({
  cacheKey, rebuildCache, listInteractionPage, writeAggregate,
  now, pageSize, maxDocuments, reads, drift,
}) {
  // Another load of this account is already rebuilding, or already did. Wait for
  // its result rather than starting a second scan or, worse, handing back an
  // empty profile that would blank the user's likes.
  if (cacheKey && rebuildCache.has(cacheKey)) {
    try {
      const shared = await rebuildCache.get(cacheKey);
      return finishRebuild(shared, { reads, reused: true, drift });
    } catch (error) {
      return unavailableInteractionProfile({ reads, reason: `rebuild-failed: ${error.message}` });
    }
  }

  const pending = (async () => {
    const rebuild = await rebuildInteractionProfile({
      listInteractionPage,
      now,
      pageSize,
      maxDocuments,
    });
    if (writeAggregate) {
      try {
        await writeAggregate(serializeInteractionProfile(rebuild.profile));
      } catch (error) {
        // The profile itself is fine; only its durability failed. Callers still
        // get the real thing, and the cache keeps the scan from repeating.
        console.warn('Could not persist the rebuilt interaction profile:', error);
      }
    }
    return rebuild;
  })();

  if (cacheKey) {
    // Kept even when it rejects: a repeatedly failing rebuild must short circuit
    // to UNAVAILABLE, never rescan. The no-op catch stops Node from reporting an
    // unhandled rejection on the cached promise.
    rebuildCache.set(cacheKey, pending);
    pending.catch(() => {});
  }

  try {
    const rebuild = await pending;
    return finishRebuild(rebuild, { reads, reused: false, drift });
  } catch (error) {
    return unavailableInteractionProfile({ reads, reason: `rebuild-failed: ${error.message}` });
  }
}

function finishRebuild(rebuild, { reads, reused, drift = null }) {
  // A reusing caller pays only for its own aggregate read; the scan was already
  // billed to whoever started it.
  const totalReads = reused ? reads : reads + rebuild.reads;
  const meta = {
    reads: totalReads,
    rebuilt: !reused,
    reusedRebuild: reused,
    truncated: rebuild.truncated,
    documentsRead: rebuild.documentsRead,
    drift,
    repairedDrift: Boolean(drift),
  };
  return rebuild.documentsRead === 0
    ? emptyResult(rebuild.profile, meta)
    : loadedResult(rebuild.profile, meta);
}
