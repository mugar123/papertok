export interface UserHighlight {
  id: string;
  paperId: string;
  level: string;
  language: string;
  sectionId: string;
  paragraphIndex: number;
  quote: string;
  endParagraphIndex?: number;
  endQuote?: string;
  kind: 'ai' | 'user';
  note?: string;
  paperTitle: string;
  createdAt?: unknown;
}
export type HighlightInput = { [K in keyof Omit<UserHighlight, 'id' | 'createdAt'>]?: unknown };
type HighlightOperations = Partial<{ database: typeof db; collectionRef: typeof collection; composeQuery: typeof query; matching: typeof where; cap: typeof limit; readDocuments: typeof getDocs }>;

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase.ts';
import { paintedQuote } from '../utils/latex.ts';
import { HIGHLIGHT_MIN_QUOTE_LENGTH, normalizeHighlightQuote } from '../utils/text-highlights.ts';

/**
 * Highlights a reader makes in a rewritten paper.
 *
 * Anchored by quote plus section and paragraph, never by character offset: the
 * rewrite is regenerated per level and per language, and offsets would not
 * survive that. A highlight whose quote no longer appears simply stops being
 * rendered rather than landing on the wrong words.
 */

export const MAX_HIGHLIGHTS_PER_PAPER = 200;

function cleanText(value: unknown, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength);
}

/**
 * The Firestore pieces travel as one injectable unit so the shape of the read
 * query can be asserted without a Firestore behind it, the same seam
 * `publicListService` uses for its own reads.
 */
function operations(overrides: HighlightOperations = {}) {
  return {
    database: overrides.database || db,
    collectionRef: overrides.collectionRef || collection,
    composeQuery: overrides.composeQuery || query,
    matching: overrides.matching || where,
    cap: overrides.cap || limit,
    readDocuments: overrides.readDocuments || getDocs,
  };
}

function highlightsCollection(uid: string, api = operations()) {
  return api.collectionRef(api.database, 'users', uid, 'highlights');
}

/**
 * Filter and cap belong in the query, not in JavaScript afterwards. A reader
 * with 400 highlights spread over 50 papers was paying 400 document reads every
 * time the reader opened, to keep the handful that belong to the paper on
 * screen.
 */
export function buildHighlightsQuery(uid: string, paperId: string, overrides?: HighlightOperations) {
  const api = operations(overrides);
  return api.composeQuery(
    highlightsCollection(uid, api),
    api.matching('paperId', '==', paperId),
    api.cap(MAX_HIGHLIGHTS_PER_PAPER),
  );
}

/**
 * A deterministic id means the same selection cannot be stored twice, and it
 * makes removal possible without a lookup.
 *
 * `kind` joins the fingerprint only when it is `ai`, and that asymmetry is
 * deliberate. One passage can carry both your note and the model's answer, so
 * the two must not collide — but folding `kind` in unconditionally would move
 * the id of every highlight already stored, and a moved id is a duplicate: the
 * save-time de-duplication would stop recognising the passage and the second
 * highlight of it would land as a second document. Leaving `user` out keeps
 * every existing id exactly where it is.
 */
export function buildHighlightId({ paperId, level, language, sectionId, paragraphIndex, quote, endParagraphIndex, endQuote, kind }: HighlightInput) {
  const fingerprint = [
    cleanText(paperId, 400),
    level,
    language,
    cleanText(sectionId, 40),
    paragraphIndex,
    normalizeHighlightQuote(quote),
  ]
    .concat(endParagraphIndex === undefined ? [] : [endParagraphIndex, normalizeHighlightQuote(endQuote)])
    .concat(kind === 'ai' ? ['ai'] : []).join('|');

  // FNV-1a: short, stable, and enough to separate selections within one paper.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${hash.toString(16).padStart(8, '0')}${fingerprint.length.toString(36)}`;
}

/**
 * How long a note may be before it stops being a note. The rules allow 2000; the
 * rail shows this in a 320px column beside the paper, and anything past a few
 * sentences belongs in the paper, not in its margin.
 */
export const MAX_NOTE_LENGTH = 1_200;

export function normalizeUserHighlight(input: HighlightInput | null | undefined): Omit<UserHighlight, 'id'> | null {
  const quote = normalizeHighlightQuote(input?.quote);
  if (quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH) return null;
  const paragraphIndex = Number.parseInt(input?.paragraphIndex as string, 10);
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex > 100) return null;
  const level = ['beginner', 'university', 'researcher'].includes(input?.level as string)
    ? input!.level as string
    : 'university';
  const language = 'en';
  const sectionId = cleanText(input?.sectionId, 40);
  const paperId = cleanText(input?.paperId, 400);
  if (!sectionId || !paperId) return null;
  // A passage that runs into later paragraphs of the same section keeps where
  // it ends: the last paragraph and the words of it that were selected.
  const endParagraphIndex = Number.parseInt(input?.endParagraphIndex as string, 10);
  const endQuote = normalizeHighlightQuote(input?.endQuote);
  const spans = Number.isInteger(endParagraphIndex)
    && endParagraphIndex > paragraphIndex
    && endParagraphIndex <= 100
    && endQuote.length > 0;

  // Three things live in this collection now, and `kind` is what tells them
  // apart: a bare highlight, a highlight with your note on it, and an answer the
  // model wrote about the passage. The first two are `user` — a note is a
  // highlight that acquired words — and only the third is `ai`.
  const kind = input?.kind === 'ai' ? 'ai' : 'user';
  const note = cleanText(input?.note, MAX_NOTE_LENGTH);
  // An AI annotation with no text is not an annotation: it is a mark claiming an
  // answer that does not exist, and it would render as an empty card.
  if (kind === 'ai' && !note) return null;

  return {
    paperId,
    level,
    language,
    sectionId,
    paragraphIndex,
    quote: quote.slice(0, 400),
    ...(spans ? { endParagraphIndex, endQuote: endQuote.slice(0, 400) } : {}),
    kind,
    ...(note ? { note } : {}),
    paperTitle: cleanText(input?.paperTitle, 1_000),
  };
}

export async function listUserHighlights(uid: string | null | undefined, paperId: unknown, overrides?: HighlightOperations): Promise<UserHighlight[]> {
  if (!uid) return [];
  const target = cleanText(paperId, 400);
  // No paper, no highlights. This used to mean "hand over the whole
  // collection", which is precisely the read amplification the query above
  // exists to remove, and `normalizeUserHighlight` refuses to store a highlight
  // without a `paperId`, so an empty target can never have a legitimate match.
  if (!target) return [];
  const api = operations(overrides);
  try {
    const snapshot = await api.readDocuments(buildHighlightsQuery(uid, target, overrides));
    return snapshot.docs.map(entry => ({ id: entry.id, ...entry.data() as Omit<UserHighlight, 'id'> }));
  } catch (error) {
    console.warn('Could not load highlights', error);
    return [];
  }
}

export async function saveUserHighlight(uid: string | null | undefined, input: HighlightInput) {
  if (!uid) return null;
  const highlight = normalizeUserHighlight(input);
  if (!highlight) return null;
  const id = buildHighlightId(highlight);
  try {
    await setDoc(doc(highlightsCollection(uid), id), {
      ...highlight,
      createdAt: serverTimestamp(),
    });
    return { id, ...highlight };
  } catch (error) {
    console.warn('Could not save highlight', error);
    return null;
  }
}

export async function removeUserHighlight(uid: string | null | undefined, highlightId: string) {
  if (!uid || !highlightId) return false;
  try {
    await deleteDoc(doc(highlightsCollection(uid), cleanText(highlightId, 200)));
    return true;
  } catch (error) {
    console.warn('Could not remove highlight', error);
    return false;
  }
}

/**
 * Groups stored highlights by section and paragraph so a paragraph can be
 * rendered with only the anchors that belong to it.
 */
export function indexHighlightsByParagraph(
  highlights: ReadonlyArray<Pick<UserHighlight, 'id' | 'quote' | 'level' | 'language' | 'sectionId' | 'paragraphIndex' | 'endParagraphIndex' | 'endQuote' | 'kind'>> = [],
  { level, language, paragraphText }: { level?: string; language?: string; paragraphText?: (sectionId: string, paragraphIndex: number) => string | null } = {},
) {
  const index = new Map<string, Array<Pick<UserHighlight, 'id' | 'quote'> & { kind: string; source: string; fresh?: boolean; pending?: boolean }>>();
  for (const highlight of highlights) {
    if (level && highlight.level !== level) continue;
    if (language && highlight.language !== language) continue;
    // The mark's colour and the annotation's origin are the same fact, read off
    // the same field: your pen is the saturated yellow, the model's is the ink
    // rule. `source` stays separate because the render plan uses it to tell a
    // stored mark from one the rewrite itself proposed.
    const kind = highlight.kind === 'ai' ? 'ai' : 'user';
    for (const segment of passageSegments(highlight, paragraphText)) {
      const key = `${highlight.sectionId}:${segment.paragraphIndex}`;
      index.set(key, [...(index.get(key) || []), { id: highlight.id, quote: segment.quote, kind, source: kind }]);
    }
  }
  return index;
}

/**
 * A passage as one line of text, in the words the paper paints: its start, and
 * where it ends when it spans paragraphs. Each end is read alone, because a
 * brace or command a selection cut belongs to the paragraph it was cut in.
 */
export function passageQuote({ quote, endQuote }: Pick<UserHighlight, 'quote' | 'endQuote'>) {
  return endQuote ? `${paintedQuote(quote)} … ${paintedQuote(endQuote)}` : paintedQuote(quote);
}

/**
 * The paragraphs a passage covers and the words of each: the selected end of
 * the first, every paragraph in between whole, and the selected start of the
 * last. A passage inside one paragraph is one segment.
 */
export function passageSegments(
  passage: Pick<UserHighlight, 'sectionId' | 'paragraphIndex' | 'quote' | 'endParagraphIndex' | 'endQuote'>,
  paragraphText?: (sectionId: string, paragraphIndex: number) => string | null,
) {
  const segments = [{ paragraphIndex: passage.paragraphIndex, quote: passage.quote }];
  const end = passage.endParagraphIndex;
  if (end === undefined || end <= passage.paragraphIndex || !passage.endQuote) return segments;
  for (let index = passage.paragraphIndex + 1; index < end; index += 1) {
    const text = paragraphText?.(passage.sectionId, index);
    if (text) segments.push({ paragraphIndex: index, quote: text });
  }
  segments.push({ paragraphIndex: end, quote: passage.endQuote });
  return segments;
}
