import type { Paper } from '../models/paper.ts';

import { withRetractionOf } from '../models/paper.ts';
import { readLaterStamp, restoreReadLater } from './read-later-rollback.ts';

export interface LibraryEntry {
  paperId: string; paper: Partial<Paper>; readLater?: boolean; readAt?: string | number | null;
  note?: string; tags?: string[]; updatedAt?: string | number | null;
}

/** `copy` with a retraction the entry's copy or `loaded` records; `copy` itself when neither adds one. */
const keepingRetraction = (copy: Partial<Paper>, entry: LibraryEntry | undefined, loaded: Partial<Paper> | undefined) => (
  withRetractionOf(withRetractionOf(copy, entry?.paper), loaded)
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
  return { ...library, [paperId]: { ...entry, ...fields, paperId, paper: keepingRetraction(copy, entry, loaded) } };
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
  const stamped = { paper: keepingRetraction(copy, previous, loaded), updatedAt };
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
    (next, [id, copy]) => loadedWithRetractionOf(next, id, copy),
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
  return loaded ? withRetractionOf(loaded, entryCopy) : entryCopy;
}
