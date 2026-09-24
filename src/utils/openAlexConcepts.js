/**
 * The OpenAlex concepts (or topics) a paper may show as subjects.
 *
 * The OpenAlex adapter always kept only concepts scored above 0.3; the feed
 * enrichment and the Explorer's mapper took all of them, which is how the
 * database concept "MEDLINE" (C2779473830, on 27% of sampled works) became a
 * chip on PubMed cards (audit 2026-09-23, issue 7). Bibliographic databases
 * say where a work is indexed, not what it is about, whatever their score.
 */
const MIN_CONCEPT_SCORE = 0.3;
const BIBLIOGRAPHIC_DATABASES = new Set([
  'medline', 'pubmed', 'embase', 'cinahl', 'scopus', 'web of science',
  'psycinfo', 'google scholar', 'cochrane library',
]);

function conceptName(concept) {
  return String(concept?.display_name || concept?.displayName || concept?.name || '').trim().toLowerCase();
}

export function usableOpenAlexConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];
  return concepts.filter(concept => concept
    && (concept.score === undefined || concept.score > MIN_CONCEPT_SCORE)
    && !BIBLIOGRAPHIC_DATABASES.has(conceptName(concept)));
}
