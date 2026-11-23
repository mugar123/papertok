import type { Paper } from '../models/paper.ts';

import type { InteractionDocumentData } from '../utils/interaction-profile.ts';

import { readStoredClassification, withJournalOf, withPublicationEvidenceOf } from '../models/paper.ts';
import { readStoredStudyType } from '../models/paper-evidence.ts';
import { copyOfRecordWithoutCopy, serializeLibraryPaper } from '../utils/reading-library.ts';
import { readLaterStamp, restoreReadLater } from './read-later-rollback.ts';

// A like or save may settle after a read, note or Read later change has replaced the entry's paper.
const localPaperWrite = Symbol('localPaperWrite');

export interface LibraryEntry {
  [localPaperWrite]?: symbol;
  paperId: string; paper: Partial<Paper>; readLater?: boolean; readAt?: string | number | null;
  note?: string; tags?: string[]; updatedAt?: string | number | null;
}

type Library = Record<string, LibraryEntry>;
export type LibraryState = {
  personalLibrary: Library;
  libraryPapers: Record<string, Partial<Paper>>;
};

/**
 * Apply updates in call order, then give React the resulting snapshots.
 * A write answer needs the result before the next render, and React can
 * replay a state updater, so the caller handles effects after this returns.
 */
export function createLibraryUpdater(publish: (state: LibraryState) => void) {
  let current: LibraryState = { personalLibrary: {}, libraryPapers: {} };
  const setLibraryState = (update: LibraryState | ((state: LibraryState) => LibraryState)): boolean => {
    const next = typeof update === 'function' ? update(current) : update;
    if (next === current) return false;
    current = next;
    publish(next);
    return true;
  };
  return {
    getLibraryState: () => current,
    setLibraryState,
    setPersonalLibrary: (update: (entries: Library) => Library) => setLibraryState(state => {
      const personalLibrary = update(state.personalLibrary);
      return personalLibrary === state.personalLibrary ? state : { ...state, personalLibrary };
    }),
  };
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
  return { ...library, [paperId]: { ...entry, ...fields, paperId, [localPaperWrite]: Symbol(), paper: keepingPublicationEvidence(copy, entry, loaded) } };
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

/** A like or save updates the interaction copy without changing the entry's marks. */
export function libraryAfterInteraction(library: Record<string, LibraryEntry>, paperId: string, copy: Partial<Paper>, beforeWrite?: LibraryEntry) {
  const entry = library[paperId];
  if (!entry) return library;
  const kept = withPublicationEvidenceOf(entry.paper, copy);
  const laterMark = entry[localPaperWrite] !== beforeWrite?.[localPaperWrite];
  const paper = laterMark ? kept : withJournalOf(kept, copy);
  return paper === entry.paper ? library : { ...library, [paperId]: { ...entry, paper } };
}

export function loadedAfterInteraction(papers: Record<string, Partial<Paper>>, paperId: string, copy: Partial<Paper>) {
  const known = papers[paperId];
  const paper = known ? withJournalOf(withPublicationEvidenceOf(known, copy), copy) : copy;
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
  const next = { ...entries, ...current };
  for (const [id, entry] of Object.entries(current)) {
    const paper = withPublicationEvidenceOf(entry.paper, papers[id] ?? entries[id]?.paper);
    if (paper !== entry.paper) next[id] = { ...entry, paper };
  }
  return next;
}

/** The loaded interaction copies after a load. */
export function loadedAfterLoad(current: Record<string, Partial<Paper>>, papers: Record<string, Partial<Paper>>) {
  const next = { ...papers };
  for (const [id, copy] of Object.entries(current)) next[id] = withPublicationEvidenceOf(copy, papers[id]);
  return next;
}

/** A server answer refreshes journals unless a local interaction replaced its copy during the read. */
export function libraryAfterRead(
  current: LibraryState, beforeRead: LibraryState, entries: LibraryState['personalLibrary'],
  papers: LibraryState['libraryPapers'], fromCache: boolean,
): LibraryState {
  const personalLibrary = libraryAfterLoad(current.personalLibrary, entries, papers);
  const libraryPapers = loadedAfterLoad(current.libraryPapers, papers);
  const journalChanged = (copy: Partial<Paper>, before: Partial<Paper> | undefined) =>
    !before || copy.journal !== before.journal || copy.venueId !== before.venueId || copy.sourceName !== before.sourceName;
  for (const [id, stored] of Object.entries(papers)) {
    const entry = current.personalLibrary[id]?.paper;
    const loaded = current.libraryPapers[id];
    let journal = stored;
    if (loaded && (fromCache || journalChanged(loaded, beforeRead.libraryPapers[id]))) journal = loaded;
    if (entry && (fromCache || journalChanged(entry, beforeRead.personalLibrary[id]?.paper))) journal = entry;
    libraryPapers[id] = withJournalOf(libraryPapers[id], journal);
    if (personalLibrary[id]) {
      const paper = withJournalOf(personalLibrary[id].paper, journal);
      if (paper !== personalLibrary[id].paper) personalLibrary[id] = { ...personalLibrary[id], paper };
    }
  }
  return { personalLibrary, libraryPapers };
}

/**
 * The copy the library holds of a paper: the interaction's copy as loaded,
 * else the entry's. A mark rewrites only the entry, from the card it was made
 * on, so a retraction either copy records stands (ENG-84).
 */
export function libraryCopyOf(library: Record<string, LibraryEntry>, papers: Record<string, Partial<Paper>>, paperId: string) {
  const entryCopy = library[paperId]?.paper;
  const loaded = papers[paperId];
  return loaded && entryCopy ? withJournalOf(withPublicationEvidenceOf(loaded, entryCopy), entryCopy) : loaded ?? entryCopy;
}

export function serializeInteractionPaper(paper: Paper, state: LibraryState) {
  const { studyType, acceptedConference, corpusUpdatedAt } = keepingPublicationEvidence(paper, state.personalLibrary[paper.id], state.libraryPapers[paper.id]);
  // A direct provider has no conference decision to write. The remote copy
  // may already hold a newer decision than the one loaded on this device.
  return serializeLibraryPaper({ ...paper, studyType,
    ...(paper.corpusUpdatedAt !== undefined || paper.acceptedConference ? { acceptedConference, corpusUpdatedAt } : {}),
  });
}

export function readInteractionPaper(id: string, record: InteractionDocumentData) {
  const copy = record.paper;
  return copy
    ? { ...copy, studyType: readStoredStudyType(copy), ...readStoredClassification({ ...copy, id }) }
    : copyOfRecordWithoutCopy(id, record);
}
