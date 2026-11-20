import type { Paper } from '../models/paper.ts';

import { withPublicationEvidenceOf } from '../models/paper.ts';
import { readLaterStamp, restoreReadLater } from './read-later-rollback.ts';

export interface LibraryEntry {
  paperId: string; paper: Partial<Paper>; readLater?: boolean; readAt?: string | number | null;
  note?: string; tags?: string[]; updatedAt?: string | number | null;
}

/** Keep evidence from the existing entry and the loaded interaction. */
const keepingPublicationEvidence = (copy: Partial<Paper>, entry: LibraryEntry | undefined, loaded: Partial<Paper> | undefined) => (
  withPublicationEvidenceOf(withPublicationEvidenceOf(copy, entry?.paper), loaded)
);

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
  return { ...library, [paperId]: { ...entry, ...fields, paperId, paper: keepingPublicationEvidence(copy, entry, loaded) } };
}

/**
 * A Read later change to a paper's entry, made from `previous`, the entry as
 * the change was asked for. `show` sets the mark with the copy and edit time
 * readLaterStamp gives, and `undo` takes a refused change back through
 * restoreReadLater. The copy keeps a retraction, as withLibraryCopy keeps one
 * (ENG-84), and is made once, so `undo` can tell the copy `show` put on the
 * entry from one put there since.
 */
export function readLaterChange(
  paperId: string,
  previous: LibraryEntry | undefined,
  { copy, readLater, updatedAt, late, loaded }: {
    copy: Partial<Paper>; readLater: boolean; updatedAt: string;
    /** A removal shown only once its write is accepted, see readLaterStamp. */
    late: boolean;
    loaded?: Partial<Paper>;
  },
) {
  const stamped = { paper: keepingPublicationEvidence(copy, previous, loaded), updatedAt };
  return {
    show: (library: Record<string, LibraryEntry>) => {
      const stamp = readLaterStamp(library[paperId], previous, stamped, { late });
      return withLibraryCopy(library, paperId, stamp.paper, { readLater, updatedAt: stamp.updatedAt }, loaded);
    },
    undo: (library: Record<string, LibraryEntry>) => restoreReadLater(library, paperId, previous, stamped),
  };
}

/*
 * A like or a save writes `copy` as the paper's interaction copy and rewrites
 * no library entry. The helpers below keep the publication evidence that
 * the next load would read from the interaction. A later mark from a thinner
 * card keeps it through `withLibraryCopy`.
 */

/** Add evidence to an existing library entry. */
export function libraryWithPublicationEvidence(library: Record<string, LibraryEntry>, paperId: string, copy: Partial<Paper>) {
  const entry = library[paperId];
  if (!entry) return library;
  const paper = withPublicationEvidenceOf(entry.paper, copy);
  return paper === entry.paper ? library : { ...library, [paperId]: { ...entry, paper } };
}

/** Keep evidence from a new interaction alongside the copies loaded from storage. */
export function loadedWithPublicationEvidence(papers: Record<string, Partial<Paper>>, paperId: string, copy: Partial<Paper>) {
  const known = papers[paperId];
  if (!known) {
    return copy.publicationStatus === 'retracted' || copy.studyType || copy.trialRegistration
      ? { ...papers, [paperId]: copy }
      : papers;
  }
  const paper = withPublicationEvidenceOf(known, copy);
  return paper === known ? papers : { ...papers, [paperId]: paper };
}

/*
 * A load reads the interaction records: `papers` holds every copy with a real
 * title, records only liked or saved included, and `entries` the records with
 * a mark. What is already in memory wins, but a retraction a stored copy
 * records stands on it (ENG-84).
 */

/** The library entries after a load. */
export function libraryAfterLoad(
  current: Record<string, LibraryEntry>,
  entries: Record<string, LibraryEntry>,
  papers: Record<string, Partial<Paper>>,
) {
  return Object.entries(current).reduce(
    (next, [id, entry]) => withLibraryCopy(next, id, entry.paper, {}, papers[id] ?? entries[id]?.paper),
    { ...entries, ...current },
  );
}

/** The loaded interaction copies after a load. */
export function loadedAfterLoad(current: Record<string, Partial<Paper>>, papers: Record<string, Partial<Paper>>) {
  return Object.entries(papers).reduce(
    (next, [id, copy]) => loadedWithPublicationEvidence(next, id, copy),
    { ...papers, ...current },
  );
}

/**
 * The copy the library holds of a paper: the interaction's copy as loaded,
 * else the entry's. A mark rewrites only the entry, from the card it was made
 * on, so a retraction either copy records stands (ENG-84).
 */
export function libraryCopyOf(library: Record<string, LibraryEntry>, papers: Record<string, Partial<Paper>>, paperId: string) {
  const entryCopy = library[paperId]?.paper;
  const loaded = papers[paperId];
  return loaded ? withPublicationEvidenceOf(loaded, entryCopy) : entryCopy;
}
