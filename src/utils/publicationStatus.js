/**
 * Whether a paper is a preprint, read from what each provider actually says
 * about it (audit 2026-09-23, issue 12a: chapters and accepted papers carried
 * the «Preprint» chip).
 */

// An arXiv comment that says the paper was accepted by, or appears in, a
// venue: «Accepted for publication as a book chapter», «To appear as a
// chapter», «Accepted at AAAI» all escaped the old `… in` alone (2607.02734,
// 2608.12077, 2606.06074). «Submitted to» still says nothing of the kind.
const ARXIV_PUBLISHED_COMMENT = /\b(?:(?:accepted|published|appears|to appear) in|accepted (?:for|at|to)|to appear (?:as|at))\b/i;

export function arxivCommentSaysPublished(comment) {
  return ARXIV_PUBLISHED_COMMENT.test(String(comment || ''));
}

// OpenAlex types a preprint as such; every other type it gives — an article,
// a book chapter, a proceedings paper — is a published work, whatever
// repository its best copy sits in: 8 in 100 random chapters had one as their
// primary location and were labelled preprints for it. A work typed as a
// preprint is still published once any copy of it is the published one. This
// is the rule the enrichment mapper already kept; the card mappers now share it.
const OPENALEX_PREPRINT_TYPES = new Set(['preprint', 'posted-content']);

export function openAlexPublicationStatus(work) {
  const type = String(work?.type || '').trim().toLowerCase();
  if (type && !OPENALEX_PREPRINT_TYPES.has(type)) return 'published';
  const published = work?.primary_location?.is_published
    || (Array.isArray(work?.locations) && work.locations.some(location => location?.is_published));
  return published ? 'published' : 'preprint';
}

// Semantic Scholar's `Review` is a kind of article: PMID 30617335, a review
// in Nature Medicine, carried the chip.
export function semanticScholarIsPreprint(publicationTypes) {
  return Array.isArray(publicationTypes)
    && publicationTypes.some(type => String(type).trim().toLowerCase() === 'preprint');
}
