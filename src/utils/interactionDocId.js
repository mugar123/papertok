/**
 * The name of a paper's interaction document.
 *
 * Interaction documents are keyed by the feed's `paper.id`, and some of those
 * carry a slash: pre-2007 arXiv ids (`hep-th/0603001`, `math.GT/0309136`) and
 * DOI-keyed papers (`doi:10.1103/physrevb.42.892`). A slash is a path
 * separator to Firestore, so `doc(collection, id)` threw — AFTER the aggregate
 * had already recorded the like. The read side then choked on the same ids
 * (a slash inside an `in` filter rejects the whole query), and the Liked tab
 * never loaded.
 *
 * Percent-encoding only `%` and `/` keeps every legal id unchanged (existing
 * documents keep their names) and makes the mapping reversible.
 */
export function encodeInteractionDocId(paperId) {
  return String(paperId || '').replace(/%/g, '%25').replace(/\//g, '%2F');
}

export function decodeInteractionDocId(documentId) {
  return String(documentId || '').replace(/%2F/g, '/').replace(/%25/g, '%');
}
