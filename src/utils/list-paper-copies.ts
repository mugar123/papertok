import type { Paper } from '../models/paper.ts';
import { knownCitationCount, paperLegacyAdapter, readStoredClassification, storedAbstractSource, storedClassification, withRetractionOf } from '../models/paper.ts';

/**
 * `copy` with `other`'s authors when `other`, a copy of the same paper, lists
 * more. Each writer keeps its own number: a `savedPapers` document kept five
 * names, and none when a card's authors were `{ name }` objects; a record
 * without a copy keeps three; an interaction's copy twenty.
 */
const withAuthorsOf = (copy: Partial<Paper>, other: Partial<Paper> | undefined) => (
  other?.authors && other.authors.length > (copy.authors?.length ?? 0) ? { ...copy, authors: other.authors } : copy
);

/**
 * The field a copy holds, as a stored copy keeps it. A copy read back as a
 * paper states its own; a copy as stored is read by the rules for stored
 * copies, which take an old copy's category as evidence only under a bare
 * arXiv id (`readStoredClassification`).
 */
const fieldOf = (copy: Partial<Paper>) => (copy.sources ? storedClassification(copy) : readStoredClassification(copy));

/** Whether a copy says the paper's field: arXiv's categories or OpenAlex's topic. */
export function copyHoldsField(copy: Partial<Paper> | undefined) {
  if (!copy) return false;
  const field = fieldOf(copy);
  return Boolean(field.categories.length || field.primaryCategory || field.primaryTopic);
}

/**
 * `copy` with the field of `other`, a copy of the same paper, when `copy` has
 * none. A `savedPapers` document from before PAP-60 reads back with no field
 * (`readPaperFields`); laid over a like's or a read mark's copy that holds
 * one, it erased it.
 */
const withFieldOf = (copy: Partial<Paper>, other: Partial<Paper> | undefined): Partial<Paper> => (
  other && !copyHoldsField(copy) && copyHoldsField(other) ? { ...copy, ...fieldOf(other) } : copy
);

/** Fill absent row metadata without letting a thin answer erase the device copy. */
const filledFrom = (copy: Partial<Paper>, other: Partial<Paper> | undefined) => {
  const filled = withFieldOf(withAuthorsOf(copy, other), other);
  return {
    ...filled,
    ...(!filled.year && other?.year ? { year: other.year } : {}),
    ...(!filled.published && other?.published ? { published: other.published } : {}),
    ...(!filled.journal && other?.journal ? { journal: other.journal } : {}),
    ...(other && knownCitationCount(filled) === null && knownCitationCount(other) !== null
      ? { citationCount: other.citationCount, citationCountKnown: other.citationCountKnown } : {}),
  };
};

/**
 * A list's paper when the library holds two copies of it: the interaction's
 * (`libraryCopy`: a read mark, Read later, a note or tags) and another
 * (`otherCopy`: the `savedPapers` document read back, or the interaction's
 * copy as the library read it on load, which a write in this session can
 * have replaced since). The interaction's copy fills the links and the text,
 * the authors when it lists more, and the field when the other has none.
 *
 * The credit for the text (ENG-109) is the one the copy holding that text
 * gives it. The two copies can hold different texts, and taking the other
 * copy's credit named a source under a text it did not supply.
 */
export function listPaperFromCopies(libraryCopy: Partial<Paper>, otherCopy: Partial<Paper>): Partial<Paper> {
  const merged = {
    ...libraryCopy,
    ...filledFrom(otherCopy, libraryCopy),
    doi: libraryCopy.doi || otherCopy.doi,
    arxivId: libraryCopy.arxivId || otherCopy.arxivId,
    openUrl: libraryCopy.openUrl || otherCopy.openUrl,
    landingPageUrl: libraryCopy.landingPageUrl || otherCopy.landingPageUrl,
    pdfUrl: libraryCopy.pdfUrl || otherCopy.pdfUrl,
    abstract: libraryCopy.abstract || otherCopy.abstract,
    summary: libraryCopy.summary || otherCopy.summary,
    concepts: libraryCopy.concepts?.length ? libraryCopy.concepts : otherCopy.concepts,
    authors: withAuthorsOf(otherCopy, libraryCopy).authors,
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
 * A list's paper from the copies the lists screen can hold of it: the library
 * entry's (`entryCopy`), the screen's own fetch (`fetchedCopy`), and the
 * interaction's copy as the library loaded it (`loadedCopy`), the broadest and
 * least specific. A retraction any of them records stands (ENG-84): a mark
 * writes the entry from the card it was made on, and a like or save of this
 * session gives the loaded copy a retraction the fetch can predate.
 */
export function listPaper(
  entryCopy: Partial<Paper> | undefined,
  fetchedCopy: Partial<Paper> | undefined,
  loadedCopy: Partial<Paper> | undefined,
) {
  const otherCopy = fetchedCopy ? filledFrom(fetchedCopy, loadedCopy) : loadedCopy;
  if (!entryCopy) return otherCopy && withRetractionOf(otherCopy, loadedCopy);
  return otherCopy ? listPaperFromCopies(withRetractionOf(entryCopy, loadedCopy), otherCopy) : entryCopy;
}

/**
 * The lists screen's papers after one metadata answer. A `savedPapers`
 * document replaces an interaction copy already in hand, and an interaction
 * copy only fills a gap, but a retraction either copy records stands in
 * either arrival order: the `savedPapers` document keeps no status. So do
 * the longer list of authors and a field only one of them holds.
 */
export function mergeListPaperCopies(
  current: Record<string, Partial<Paper>>,
  loaded: Record<string, Partial<Paper>>,
  source: 'saved' | 'interaction',
) {
  const next = { ...current };
  Object.entries(loaded).forEach(([paperId, paper]) => {
    const known = next[paperId];
    next[paperId] = source === 'saved' || !known
      ? withRetractionOf(filledFrom(paper, known), known)
      : withRetractionOf(filledFrom(known, paper), paper);
  });
  return next;
}

/**
 * Whether a stored copy holds what a `savedPapers` document could add: a field
 * or a publication date. A record without a copy yields one with neither
 * (`copyOfRecordWithoutCopy`), and so does any copy written back from it by a
 * mark made on its row. Read from the content, so a copy as stored and as
 * `paperLegacyAdapter` reads it give the same answer.
 */
export function copyHoldsPaperMetadata(copy: Partial<Paper> | undefined) {
  return Boolean(copy && (
    copy.categories?.length || copy.primaryCategory || copy.primaryTopic || copy.published || copy.year
  ));
}

/**
 * Whether the lists screen must read a paper from both collections: none of
 * the `copies` it holds (the library entry's, its own reads', the library's
 * load) has a field or a date, and the `savedPapers` read has not answered
 * for it this session (`savedAnswered`: a document or its confirmed
 * absence). A paper with no copy at all is read until one arrives.
 */
export function listPaperNeedsRead(copies: (Partial<Paper> | undefined)[], savedAnswered: boolean) {
  if (copies.some(copyHoldsPaperMetadata)) return false;
  return !(savedAnswered && copies.some(Boolean));
}

/**
 * Whether the lists screen must read the `savedPapers` document of a paper it
 * already shows: its `copies` hold a date and no field, and that read has not
 * answered this session. The document may hold the field, its own or one a
 * provider gave (`storePaperField`); the row needs nothing else from it.
 */
export function listPaperNeedsFieldRead(copies: (Partial<Paper> | undefined)[], savedAnswered: boolean) {
  return !savedAnswered && !listPaperNeedsRead(copies, savedAnswered) && !copies.some(copyHoldsField);
}
