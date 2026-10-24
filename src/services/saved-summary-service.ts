import type { DocumentData, QueryDocumentSnapshot, QuerySnapshot } from 'firebase/firestore';
import type { Paper } from '../models/paper.ts';
import type { RewriteSection } from '../models/rewrite.ts';
import type { ReadingLevel } from '../utils/user-settings.ts';
type SummaryPaper = Partial<Pick<Paper, 'id' | 'doi' | 'arxivId' | 'pmid' | 'title'>> | null | undefined;
export type SummaryHistoryCursor = QueryDocumentSnapshot<DocumentData> | null;
type HistoryOperations = Partial<{
  database: typeof db;
  collectionRef: typeof collection;
  composeQuery: typeof query;
  order: typeof orderBy;
  after: typeof startAfter;
  cap: typeof limit;
  readDocuments: (target: ReturnType<typeof query>) => Promise<Pick<QuerySnapshot, 'docs'> & Partial<Pick<QuerySnapshot, 'empty' | 'size' | 'metadata'>>>;
}>;
/**
 * `promptVersion` is the worker's REWRITE_PROMPT_VERSION for the text. A saved
 * copy is reopened whatever prompt is current, so this is what would let a
 * later prompt tell the copies an older one wrote apart.
 */
export interface SavedSummary { sections: RewriteSection[]; model: string; sourceBasis: string; promptVersion: string }
export interface SummaryHistoryPage { rows: SummaryHistoryRow[]; cursor: SummaryHistoryCursor; hasMore: boolean }
export interface SummaryHistoryRow {
  id: string;
  paperKey: string;
  paperId: string;
  level: ReadingLevel;
  title: string;
  pdfUrl: string;
  updatedAt: Date | null;
}

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase.ts';
import { toRewriteSection } from '../models/rewrite.ts';
import { patientRead } from '../utils/bounded-read.ts';
import { documentIsAuthoritative, queryIsAuthoritative } from '../utils/cache-authority.ts';
import { getPaperKey, parsePaperKey } from '../utils/public-navigation.ts';
import { AI_EXPLANATION_LEVEL_IDS } from '../utils/user-settings.ts';

/**
 * The plain-words summaries a reader keeps in their own account.
 *
 * Two documents per paper and level, written in one batch: `summaries` holds
 * the text and is read one at a time when a paper opens, and `summaryHistory`
 * holds the row the history lists, so a page of history never downloads twenty
 * papers' worth of text. Both are keyed `<paperKey>.<level>`, the canonical key
 * from `getPaperKey`, so regenerating replaces the copy and no account reads
 * another's. Limits are repeated in firestore.rules.
 */

export const SUMMARY_HISTORY_PAGE_SIZE = 20;
const MAX_PAPER_KEY_LENGTH = 600;
const MAX_SECTIONS = 24;

function cleanText(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

/**
 * Null when the paper has no canonical identity (a Semantic Scholar hash, a
 * Scopus id without a DOI): such a paper keeps today's behaviour and is not
 * saved, rather than being stored under a key no other open would find.
 */
export function summaryId(paper: SummaryPaper, level: string) {
  const paperKey = getPaperKey(paper);
  if (!paperKey || paperKey.length > MAX_PAPER_KEY_LENGTH || !AI_EXPLANATION_LEVEL_IDS.has(level)) return null;
  return `${paperKey}.${level}`;
}

/** The two documents a finished rewrite becomes, or null when it cannot be kept whole. */
export function buildSummaryWrite(paper: SummaryPaper, level: string, summary: SavedSummary, pdfUrl: string) {
  const id = summaryId(paper, level);
  const title = cleanText(paper?.title, 1_000);
  const paperId = cleanText(paper?.id || paper?.doi || paper?.arxivId, 400);
  const url = cleanText(pdfUrl, 2_000);
  const sections = Array.isArray(summary?.sections) ? summary.sections.map(toRewriteSection) : [];
  if (!id || !title || !paperId || !url.startsWith('https://')
    || sections.length === 0 || sections.length > MAX_SECTIONS || sections.some(section => !section)) {
    return null;
  }
  return {
    id,
    summary: {
      sections: sections as RewriteSection[],
      model: cleanText(summary.model, 100),
      sourceBasis: cleanText(summary.sourceBasis, 40),
      promptVersion: cleanText(summary.promptVersion, 40),
    },
    history: { paperKey: id.slice(0, id.lastIndexOf('.')), paperId, level, title, pdfUrl: url },
  };
}

/**
 * The saved copy for this paper and level, or null when there is none. A copy
 * with a damaged section is treated as missing: showing part of a paper as if
 * it were the whole would be worse than writing it again.
 */
export async function getSavedSummary(uid: string | null | undefined, paper: SummaryPaper, level: string, { signal }: { signal?: AbortSignal } = {}): Promise<SavedSummary | null> {
  const id = uid ? summaryId(paper, level) : null;
  if (!uid || !id) return null;
  const snapshot = await patientRead(() => getDoc(doc(db, 'users', uid, 'summaries', id)), {
    attempts: 2,
    ms: 4_000,
    label: 'saved summary',
    isAnswer: documentIsAuthoritative,
    signal,
  });
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  const sections = Array.isArray(data.sections) ? data.sections.map(toRewriteSection) : [];
  if (sections.length === 0 || sections.some(section => !section)) return null;
  return {
    sections: sections as RewriteSection[],
    model: cleanText(data.model, 100),
    sourceBasis: cleanText(data.sourceBasis, 40),
    promptVersion: cleanText(data.promptVersion, 40),
  };
}

/**
 * Keeps a finished rewrite. Not awaited by the reader: Firestore resolves a
 * write only once the server has it, and the summary on screen does not depend
 * on that. A failure costs a future regeneration, not the summary being read.
 */
export async function saveSummary(uid: string | null | undefined, paper: SummaryPaper, level: string, summary: SavedSummary, pdfUrl: string) {
  const write = uid ? buildSummaryWrite(paper, level, summary, pdfUrl) : null;
  if (!uid || !write) return false;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'users', uid, 'summaries', write.id), write.summary);
    batch.set(doc(db, 'users', uid, 'summaryHistory', write.id), { ...write.history, updatedAt: serverTimestamp() });
    await batch.commit();
    return true;
  } catch (error) {
    console.warn('Could not save the plain-words summary', error);
    return false;
  }
}

function historyOperations(overrides: HistoryOperations = {}) {
  return {
    database: overrides.database || db,
    collectionRef: overrides.collectionRef || collection,
    composeQuery: overrides.composeQuery || query,
    order: overrides.order || orderBy,
    after: overrides.after || startAfter,
    cap: overrides.cap || limit,
    readDocuments: overrides.readDocuments || getDocs,
  };
}

/**
 * Newest first, one page plus one row: the extra row only says whether a next
 * page exists, so "Show more" is never offered for a page that comes back empty.
 */
export function buildSummaryHistoryQuery(uid: string, cursor: SummaryHistoryCursor = null, overrides?: HistoryOperations) {
  const api = historyOperations(overrides);
  return api.composeQuery(
    api.collectionRef(api.database, 'users', uid, 'summaryHistory'),
    api.order('updatedAt', 'desc'),
    ...(cursor ? [api.after(cursor)] : []),
    api.cap(SUMMARY_HISTORY_PAGE_SIZE + 1),
  );
}

export function toSummaryHistoryRow(id: string, data: DocumentData | null | undefined): SummaryHistoryRow | null {
  const paperKey = cleanText(data?.paperKey, MAX_PAPER_KEY_LENGTH);
  const level = data?.level;
  const title = cleanText(data?.title, 1_000);
  const paperId = cleanText(data?.paperId, 400);
  const pdfUrl = cleanText(data?.pdfUrl, 2_000);
  if (!parsePaperKey(paperKey) || !AI_EXPLANATION_LEVEL_IDS.has(level) || id !== `${paperKey}.${level}`
    || !title || !paperId || !pdfUrl.startsWith('https://')) return null;
  const updatedAt = typeof data?.updatedAt?.toDate === 'function' ? data.updatedAt.toDate() as Date : null;
  return { id, paperKey, paperId, level, title, pdfUrl, updatedAt };
}

/**
 * One page of the history. A read that outlasts its budget rejects with
 * `ReadTimedOutError` but keeps trying, and `onLateResult` receives the page
 * if it arrives later (patientRead in utils/bounded-read.ts).
 */
export async function listSummaryHistory(uid: string, { cursor = null, signal, onLateResult }: {
  cursor?: SummaryHistoryCursor;
  signal?: AbortSignal;
  onLateResult?: (page: SummaryHistoryPage) => void;
} = {}, overrides?: HistoryOperations) {
  const api = historyOperations(overrides);
  const toPage = (snapshot: Pick<QuerySnapshot, 'docs'>): SummaryHistoryPage => {
    const page = snapshot.docs.slice(0, SUMMARY_HISTORY_PAGE_SIZE);
    return {
      rows: page.flatMap((entry) => {
        const row = toSummaryHistoryRow(entry.id, entry.data({ serverTimestamps: 'estimate' }));
        return row ? [row] : [];
      }),
      cursor: page.at(-1) ?? cursor,
      hasMore: snapshot.docs.length > SUMMARY_HISTORY_PAGE_SIZE,
    };
  };
  const snapshot = await patientRead(() => api.readDocuments(buildSummaryHistoryQuery(uid, cursor, overrides)), {
    label: 'summary history',
    isAnswer: queryIsAuthoritative,
    signal,
    onLateResult: onLateResult && (late => onLateResult(toPage(late))),
  });
  return toPage(snapshot);
}

/**
 * The paper a history row reopens in the reader: the same id, so the reader's
 * notes on it come back, the identity the summary was keyed by, and the PDF it
 * was written from, for "View the original" and for regenerating.
 */
export function summaryHistoryPaper(row: SummaryHistoryRow): Partial<Paper> {
  const identity = parsePaperKey(row.paperKey);
  return {
    id: row.paperId,
    title: row.title,
    openAccessPdfUrl: row.pdfUrl,
    ...(identity?.type === 'doi' ? { doi: identity.value } : {}),
    ...(identity?.type === 'arxiv' ? { arxivId: identity.value } : {}),
    ...(identity?.type === 'pmid' ? { pmid: identity.value } : {}),
  };
}
