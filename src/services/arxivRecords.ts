import { PaperBuilder } from './PaperBuilder.ts';
import { arxivCommentSaysPublished } from '../utils/publicationStatus.ts';

// arXiv's categories and records as the app's papers, for the browser's arXiv
// lookups and the Worker's paper store alike.

// The areas whose categories arXiv answers: by `cat:` for its own, by a phrase
// search of the label for the app's engineering leaves.
export const ARXIV_FEED_AREAS = Object.freeze([
  'physics', 'math', 'cs', 'q-fin', 'eess', 'stat', 'econ', 'mech', 'civil', 'chemeng',
]);

const ARXIV_PREFIXES = ['cs', 'math', 'physics', 'eess', 'q-bio', 'q-fin', 'stat', 'econ', 'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph', 'math-ph'];
export function isArxivCategory(category: string) {
  return ARXIV_PREFIXES.some(prefix => category === prefix || category.startsWith(`${prefix}.`));
}

// One arXiv record as a paper, whether it came from the Atom API or the
// paper store's harvest (paperStoreService.ts).
export function arxivPaper({ arxivId, title, abstract, authors, doi, journalRef, comment, published, allCategories, primaryCategory, pdfUrl }: {
  arxivId: string; title: string; abstract: string; authors: string[]; doi: string; journalRef: string; comment: string;
  published: string; allCategories: string[]; primaryCategory: string; pdfUrl?: string;
}) {
  const isPublishedInArxiv = !!(doi || journalRef || arxivCommentSaysPublished(comment));
  return PaperBuilder.create({
    id: arxivId,
    arxivId,
    sources: { primary: 'arxiv', enrichedBy: [] },
    title,
    abstract,
    authors: authors.map(name => ({ name })),
    doi,
    journal: journalRef,
    year: new Date(published).getFullYear(),
    publicationType: isPublishedInArxiv ? 'article' : 'preprint',
    publicationStatus: isPublishedInArxiv ? 'published' : 'preprint',
    openAccess: true,
    pdfUrl: pdfUrl || `https://arxiv.org/pdf/${arxivId}`,
    landingPageUrl: `https://arxiv.org/abs/${arxivId}`,
    categories: allCategories,
    keywords: allCategories,
    primaryCategory,
    published,
  });
}
