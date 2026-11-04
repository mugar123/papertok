import type { Paper } from '../models/paper.ts';
import { normalizeDoi } from '../utils/public-navigation.ts';

// Which papers the feed shows. By their type: not books or book reviews, nor
// errata, retraction notices, datasets, peer-review records, front matter or
// supplementary files. Nor a retracted paper (`publicationStatus`, from
// OpenAlex's `is_retracted` or the `Retracted Publication` type of PubMed's
// and Europe PMC's records). For the browser's Crossref lookups and the
// Worker's paper store alike.

const BOOK_TYPES = new Set(['book', 'monograph', 'edited-book', 'reference-book', 'book-set', 'book-series']);
const NON_RESEARCH_TYPES = new Set(['erratum', 'retraction', 'dataset', 'peer-review', 'paratext', 'supplementary-materials']);
// These publishers explicitly identify book reviews that Crossref calls journal-article.
// Checked 2026-10-18; corrections match identifiers, never titles or the word "review".
const BOOK_REVIEWS = new Map([
  ['10.2307/2309205', 'jstor'], // https://www.jstor.org/stable/i314912
  ['10.2307/2307774', 'jstor'], // https://www.jstor.org/stable/i314811
  ['10.1038/162006a0', 'nature'], // https://www.nature.com/articles/162006a0 (Books Received)
]);

function confirmedPublication(paper: Partial<Paper>) {
  const source = BOOK_REVIEWS.get(normalizeDoi(paper.doi));
  if (source) return { type: 'book-review', source };
  // Oda's book has no DOI in this OpenAlex record. Its author and ISBN link
  // identify https://link.springer.com/book/9783642725494, not a research review.
  if (paper.id === 'openalex:W1503277431'
    || (paper.sources?.primary === 'openalex' && paper.id === 'W1503277431')) {
    return { type: 'book', source: 'springer' };
  }
  return null;
}

/**
 * Whether the feed shows papers of this one's type, retracted or not. The
 * Worker's paper store turns away a record of another type. A retracted record
 * it keeps under no lane, so that a reader's like of it still ranks their feed
 * and a later listing of the paper finds it retracted.
 */
export function isFeedPublicationType(paper: Partial<Paper>) {
  return !confirmedPublication(paper)
    && ![paper.publicationType, paper.sourceType].some(type => type === 'book-review' || BOOK_TYPES.has(type || '') || NON_RESEARCH_TYPES.has(type || ''));
}

export function isFeedPublication(paper: Partial<Paper>) {
  return paper.publicationStatus !== 'retracted' && isFeedPublicationType(paper);
}

/**
 * The paper with the type Crossref gave its DOI, when that type is a book or
 * a book review; any other answer leaves it as it is. The Worker's paper store
 * applies its own lookups through this too.
 */
export function withCrossrefType(paper: Paper, crossrefType: string | null | undefined): Paper {
  const confirmed = confirmedPublication(paper);
  const type = confirmed?.type || crossrefType || null;
  // journal-article describes a format, not a research purpose: it must not
  // replace an existing scientific review classification.
  if (!type || (!BOOK_TYPES.has(type) && type !== 'book-review')) return paper;
  const source = confirmed?.source || 'crossref';
  return {
    ...paper,
    publicationType: type,
    sources: { ...paper.sources, enrichedBy: [...new Set([...paper.sources.enrichedBy, source])] },
  };
}
