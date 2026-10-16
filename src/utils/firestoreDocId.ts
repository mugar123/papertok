/**
 * A paper id as a Firestore document name, and back.
 *
 * Papers are keyed by the feed's `paper.id`, and some of those carry a slash:
 * pre-2007 arXiv ids (`hep-th/0603001`, `math.GT/0309136`) and DOI-keyed
 * ids. A slash is a path separator to Firestore, so `doc(collection, id)`
 * threw — for interactions AFTER the aggregate had recorded the like, for
 * saved papers AFTER `markSaved` had recorded the save — and an `in` filter
 * holding one rejected the whole query.
 *
 * Percent-encoding only `%` and `/` keeps every legal id unchanged (existing
 * documents keep their names) and makes the mapping reversible. Shared by the
 * `interactions` and `savedPapers` collections.
 */
export function encodeFirestoreDocId(paperId) {
  return String(paperId || '').replace(/%/g, '%25').replace(/\//g, '%2F');
}

export function decodeFirestoreDocId(documentId) {
  return String(documentId || '').replace(/%2F/g, '/').replace(/%25/g, '%');
}
