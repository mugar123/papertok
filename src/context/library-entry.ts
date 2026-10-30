import type { Paper } from '../models/paper.ts';

import { withRetractionOf } from '../models/paper.ts';

export interface LibraryEntry {
  paperId: string; paper: Partial<Paper>; readLater?: boolean; readAt?: string | number | null;
  note?: string; tags?: string[]; updatedAt?: string | number | null;
}

/**
 * The library with a paper's entry given `copy` and `fields`: a read mark,
 * Read later, a note or tags, written with the copy of the card they were
 * made on. The copy replaces the one the entry held, but keeps a retraction
 * that one, or `loaded`, the interaction's copy as the library read it,
 * records (ENG-84). The card may come from a provider that does not report
 * the retraction, and the interaction's stored copy keeps it, as a merge
 * write keeps any field it leaves out.
 */
export function withLibraryCopy(
  library: Record<string, LibraryEntry>,
  paperId: string,
  copy: Partial<Paper>,
  fields: Omit<Partial<LibraryEntry>, 'paperId' | 'paper'>,
  loaded?: Partial<Paper>,
) {
  const entry = library[paperId];
  const paper = withRetractionOf(withRetractionOf(copy, entry?.paper), loaded);
  return { ...library, [paperId]: { ...entry, ...fields, paperId, paper } };
}

/*
 * A like or a save writes `copy` as the paper's interaction copy and rewrites
 * no library entry. A retraction `copy` records is now stored, so the two
 * helpers below add it to what the library holds in memory, as its next load
 * would hold it (ENG-84): a later mark from a card without the retraction
 * keeps it through `withLibraryCopy`, and the lists show it. Each returns its
 * input itself when `copy` adds nothing.
 */

/** The library with the retraction `copy` records on the paper's entry, if it has one. */
export function libraryWithRetractionOf(library: Record<string, LibraryEntry>, paperId: string, copy: Partial<Paper>) {
  const entry = library[paperId];
  return entry && copy.publicationStatus === 'retracted' && entry.paper.publicationStatus !== 'retracted'
    ? { ...library, [paperId]: { ...entry, paper: withRetractionOf(entry.paper, copy) } }
    : library;
}

/** The loaded interaction copies with `copy`'s retraction, or with `copy` when none was loaded. */
export function loadedWithRetractionOf(papers: Record<string, Partial<Paper>>, paperId: string, copy: Partial<Paper>) {
  const known = papers[paperId];
  if (copy.publicationStatus !== 'retracted' || known?.publicationStatus === 'retracted') return papers;
  return { ...papers, [paperId]: known ? withRetractionOf(known, copy) : copy };
}
