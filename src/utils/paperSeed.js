import { hasUsableAIAbstract } from './aiExplanationAccess.js';
import { LEGACY_STORED_SUMMARY_CAP, STORED_AUTHOR_CAP, STORED_SUMMARY_CAP } from './readingLibrary.js';

/**
 * Whether the copy of a paper a link handed over is worth painting as the
 * page, or only worth keeping as the fallback.
 *
 * The screens that hand the paper page a stored copy — a list, a profile tab —
 * carry a title, authors and sometimes a truncated summary, and often no
 * abstract at all. Painting such a copy on arrival showed "Abstract
 * unavailable." for a beat and then, when arXiv and OpenAlex answered, the
 * real text popped in under it. A copy with no abstract is not the paper yet:
 * the page shows its skeleton until the providers answer, exactly as it does
 * for a link with no copy at all, and still falls back to the copy if they
 * never do. A copy that carries its abstract paints at once, as before.
 */
export function seedPaintsWhole(paper) {
  if (!paper || typeof paper !== 'object') return false;
  if (!String(paper.title || '').trim()) return false;
  return hasUsableAIAbstract(paper.abstract);
}

const present = (value) => (Array.isArray(value)
  ? value.length > 0
  : !(value === undefined || value === null || (typeof value === 'string' && value.trim() === '')));

// A stored summary that stops exactly at a cap was cut there, not finished.
const summaryLooksCut = (text) => text.length === LEGACY_STORED_SUMMARY_CAP || text.length >= STORED_SUMMARY_CAP;

/**
 * The abstract the page shows once the providers have answered, given the
 * one the copy carried. The copy's text is the one the reader saw in the
 * feed, so it stays whenever it is whole; a copy cut at the cap gives way to
 * the provider's whole text, and a copy with no usable abstract takes
 * whatever the provider has.
 */
export function hydratedAbstract(seedAbstract, providerAbstract) {
  const seed = hasUsableAIAbstract(seedAbstract) ? String(seedAbstract) : '';
  const provider = hasUsableAIAbstract(providerAbstract) ? String(providerAbstract) : '';
  if (!seed) return provider || providerAbstract || seedAbstract || '';
  if (!provider) return seed;
  return summaryLooksCut(seed) ? provider : seed;
}

/**
 * The author list to show: the copy's, in the form the feed printed it, unless
 * the copy was cut at the cap and the provider knows more of them.
 */
export function hydratedAuthors(seedAuthors, providerAuthors) {
  if (!present(seedAuthors)) return providerAuthors;
  const providerCount = Array.isArray(providerAuthors) ? providerAuthors.length : 0;
  if (seedAuthors.length >= STORED_AUTHOR_CAP && providerCount > seedAuthors.length) return providerAuthors;
  return seedAuthors;
}

/**
 * The paper the page shows once the providers have answered for a paper that
 * arrived with a copy: the provider's paper, with the copy laid over it where
 * the copy speaks.
 *
 * A paper the feed showed under "Strongly correlated electrons", with the
 * authors as arXiv lists them and the abstract arXiv carries, was hydrated
 * from OpenAlex by its DOI and came back filed under "Electrical &
 * electronic engineering", with OpenAlex's concept chips, author names and
 * abstract — and under OpenAlex's own id, so the read mark the reader had
 * just set, keyed by the feed's id, did not apply to it. Same paper, a
 * different provider's account of it, and nothing the reader recognised.
 *
 * So the copy keeps what identifies the paper and how the reader saw it:
 * its id (the interactions' key), title, branch and categories, authors,
 * abstract, links. The provider fills everything the copy never carried —
 * citations, concepts, institutions, open-access copies, the related graph —
 * and the fields where fresher is simply better, the date.
 */
export function hydrateSeededPaper(seed, hydrated) {
  if (!hydrated || typeof hydrated !== 'object') return seed || null;
  if (!seed || typeof seed !== 'object') return hydrated;
  const keep = (field) => (present(seed[field]) ? seed[field] : hydrated[field]);
  const fresh = (field) => (present(hydrated[field]) ? hydrated[field] : seed[field]);
  return {
    ...hydrated,
    id: keep('id'),
    title: keep('title'),
    authors: hydratedAuthors(seed.authors, hydrated.authors),
    abstract: hydratedAbstract(seed.abstract, hydrated.abstract),
    primaryCategory: keep('primaryCategory'),
    categories: keep('categories'),
    doi: keep('doi'),
    arxivId: keep('arxivId'),
    journal: keep('journal'),
    pdfUrl: keep('pdfUrl'),
    landingPageUrl: keep('landingPageUrl'),
    year: fresh('year'),
    published: fresh('published'),
  };
}
