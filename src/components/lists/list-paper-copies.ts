import type { Paper } from '../../models/paper.ts';
import { paperLegacyAdapter, storedAbstractSource, withRetractionOf } from '../../models/paper.ts';

/**
 * A list's paper when the library holds two copies of it: the interaction's
 * (`libraryCopy`: a read mark, Read later, a note or tags) and another
 * (`otherCopy`: the `savedPapers` document read back, or the interaction's
 * copy as the library read it on load, which a write in this session can
 * have replaced since). The interaction's copy fills the links and the text.
 *
 * The credit for the text (ENG-109) is the one the copy holding that text
 * gives it. The two copies can hold different texts, and taking the other
 * copy's credit named a source under a text it did not supply.
 */
export function listPaperFromCopies(libraryCopy: Partial<Paper>, otherCopy: Partial<Paper>): Partial<Paper> {
  const merged = {
    ...libraryCopy,
    ...otherCopy,
    doi: libraryCopy.doi || otherCopy.doi,
    arxivId: libraryCopy.arxivId || otherCopy.arxivId,
    openUrl: libraryCopy.openUrl || otherCopy.openUrl,
    landingPageUrl: libraryCopy.landingPageUrl || otherCopy.landingPageUrl,
    pdfUrl: libraryCopy.pdfUrl || otherCopy.pdfUrl,
    abstract: libraryCopy.abstract || otherCopy.abstract,
    summary: libraryCopy.summary || otherCopy.summary,
    concepts: libraryCopy.concepts?.length ? libraryCopy.concepts : otherCopy.concepts,
  };
  // The text the paper shows: its abstract once a copy was read back as a
  // paper, else the summary, as `paperLegacyAdapter` reads a copy.
  const text = merged.sources ? merged.abstract : merged.summary || merged.abstract;
  const paper = withRetractionOf(
    { ...merged, abstractSource: storedAbstractSource(libraryCopy, text) ?? storedAbstractSource(otherCopy, text) },
    libraryCopy,
  );
  return paper.sources ? paper : paperLegacyAdapter(paper);
}

/**
 * The lists screen's papers after one metadata answer. A `savedPapers`
 * document replaces an interaction copy already in hand, and an interaction
 * copy only fills a gap, but a retraction either copy records stands in
 * either arrival order: the `savedPapers` document keeps no status.
 */
export function mergeListPaperCopies(
  current: Record<string, Partial<Paper>>,
  loaded: Record<string, Partial<Paper>>,
  source: 'saved' | 'interaction',
) {
  const next = { ...current };
  Object.entries(loaded).forEach(([paperId, paper]) => {
    const known = next[paperId];
    next[paperId] = source === 'saved' || !known ? withRetractionOf(paper, known) : withRetractionOf(known, paper);
  });
  return next;
}
