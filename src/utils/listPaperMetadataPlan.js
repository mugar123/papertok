/**
 * How a list's papers are asked of Firestore.
 *
 * The lists screen has no render test in this repo — there is no jsdom, no
 * testing-library, nothing that mounts a component — so every decision that
 * lives inside `openList` is a decision nothing checks. The batching is exactly
 * the kind that is wrong in silence: a batch one value too long is not caught by
 * the client SDK, it is rejected by the backend and arrives as the same generic
 * banner as a flaky network.
 *
 * So the arithmetic lives here, pure and tested, and `openList` keeps only the
 * I/O.
 */

import { FIRESTORE_IN_FILTER_MAX } from './firestoreLimits.js';

// Re-exported so callers and tests reach the batching rules and the platform
// limit they respect from one place.
export { FIRESTORE_IN_FILTER_MAX };

/**
 * One batch is one round trip, so this wants to be the ceiling and not a round
 * number. It was 10 — the cap as it stood when this code was written, before
 * Firestore raised it — which cost three times the round trips for the same
 * documents. A 47-paper list goes from five batches to two.
 */
export const PAPER_METADATA_BATCH_SIZE = FIRESTORE_IN_FILTER_MAX;

/**
 * Whether an id can be a Firestore document id at all.
 *
 * This is not defensive throat-clearing. arXiv ids from before 2007 carry the
 * archive in a path segment — `math/0309285` — and `arxivService.js` derives a
 * paper's id by stripping the URL prefix, so those keep the slash. A slash is
 * not a legal document id, and one of them inside `where(documentId(), 'in', […])`
 * does not skip that id: it REJECTS THE WHOLE QUERY. Every other paper sharing
 * the batch loses its metadata to a neighbour's id, and the bigger the batch the
 * more of them.
 *
 * The rules are Firestore's own: not empty, no `/`, not `.` or `..`, not
 * `__…__`, and at most 1500 bytes when UTF-8 encoded.
 */
export function isFetchableDocumentId(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.includes('/')) return false;
  if (id === '.' || id === '..') return false;
  if (/^__.*__$/.test(id)) return false;
  return new TextEncoder().encode(id).length <= 1500;
}

/**
 * Turns the ids a list is missing into the requests that will fetch them.
 *
 * Both collections are asked for every batch, in parallel and on purpose. A
 * paper reaches a list two ways — saved through the save modal, which writes
 * `savedPapers`, or liked/read through the feed, which writes `interactions` —
 * and which one holds it is not knowable from the list. Asking one first and
 * repairing the shortfall afterwards would halve the requests and turn one
 * round trip into two for exactly the papers that already take the longest, so
 * the duplication is the cheaper mistake.
 *
 * Returns the requests plus the ids that will never be asked for, so the caller
 * can stop those rows waiting instead of leaving them on a request that is not
 * coming.
 */
export function planMetadataRequests({ missingIds, batchSize = PAPER_METADATA_BATCH_SIZE } = {}) {
  const ids = Array.isArray(missingIds) ? missingIds : [];
  const size = Math.min(
    Math.max(1, Math.floor(batchSize) || 1),
    FIRESTORE_IN_FILTER_MAX,
  );

  const fetchable = [];
  const unfetchable = [];
  for (const id of ids) {
    (isFetchableDocumentId(id) ? fetchable : unfetchable).push(id);
  }

  const requests = [];
  for (let index = 0; index < fetchable.length; index += size) {
    const paperIds = fetchable.slice(index, index + size);
    requests.push({ source: 'saved', paperIds });
    requests.push({ source: 'interaction', paperIds });
  }

  return { requests, unfetchable };
}

/**
 * Rebuilds the requests for a retry, from the ids still missing.
 *
 * The retry used to replay the stored request objects verbatim. Two things went
 * wrong with that. A failure caused by the SHAPE of a batch — one bad id, one
 * value over the cap — would reissue the byte-identical query forever while the
 * screen presented it as a transient worth retrying. And the definitions were
 * filtered down to the ids still missing AFTER the branch that chose them, so a
 * retry could end up with an empty list of requests, issue nothing, and clear
 * the banner as though it had succeeded.
 *
 * Rebatching from the ids fixes both: the retry is a fresh plan over what is
 * actually still missing, and it is empty only when there is nothing left to
 * ask for.
 */
export function planRetryRequests({ failedRequests, missingIds, batchSize } = {}) {
  const stillMissing = new Set(Array.isArray(missingIds) ? missingIds : []);
  const sources = new Set();
  const retryIds = [];
  const seen = new Set();

  for (const request of Array.isArray(failedRequests) ? failedRequests : []) {
    if (request?.source) sources.add(request.source);
    for (const paperId of request?.paperIds || []) {
      if (stillMissing.has(paperId) && !seen.has(paperId)) {
        seen.add(paperId);
        retryIds.push(paperId);
      }
    }
  }

  const { requests, unfetchable } = planMetadataRequests({ missingIds: retryIds, batchSize });
  // Only the sources that actually failed: retrying the one that already
  // answered would re-read documents the screen is holding.
  return {
    requests: sources.size > 0 ? requests.filter((r) => sources.has(r.source)) : requests,
    unfetchable,
  };
}

/**
 * The batches for the library read (`fetchLibraryRecords`), under the rule the
 * lists' plan already follows: an id Firestore cannot hold never reaches a
 * query. A pre-2007 arXiv id (`hep-th/0603001`) inside an `in` filter rejects
 * the whole query, and with it every other paper of its batch.
 */
export function planLibraryBatches(ids, size) {
  const fetchable = [];
  const unfetchable = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    (isFetchableDocumentId(id) ? fetchable : unfetchable).push(id);
  }
  const batches = [];
  for (let index = 0; index < fetchable.length; index += size) {
    batches.push(fetchable.slice(index, index + size));
  }
  return { batches, unfetchable };
}
