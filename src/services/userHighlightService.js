import { collection, deleteDoc, doc, getDocs, serverTimestamp, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { HIGHLIGHT_MIN_QUOTE_LENGTH, normalizeHighlightQuote } from '../utils/textHighlights.js';

/**
 * Highlights a reader makes in a rewritten paper.
 *
 * Anchored by quote plus section and paragraph, never by character offset: the
 * rewrite is regenerated per level and per language, and offsets would not
 * survive that. A highlight whose quote no longer appears simply stops being
 * rendered rather than landing on the wrong words.
 */

const MAX_HIGHLIGHTS_PER_PAPER = 200;

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function highlightsCollection(uid) {
  return collection(db, 'users', uid, 'highlights');
}

/**
 * A deterministic id means the same selection cannot be stored twice, and it
 * makes removal possible without a lookup.
 */
export function buildHighlightId({ paperId, level, language, sectionId, paragraphIndex, quote }) {
  const fingerprint = [
    cleanText(paperId, 400),
    level,
    language,
    cleanText(sectionId, 40),
    paragraphIndex,
    normalizeHighlightQuote(quote),
  ].join('|');

  // FNV-1a: short, stable, and enough to separate selections within one paper.
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${hash.toString(16).padStart(8, '0')}${fingerprint.length.toString(36)}`;
}

export function normalizeUserHighlight(input) {
  const quote = normalizeHighlightQuote(input?.quote);
  if (quote.length < HIGHLIGHT_MIN_QUOTE_LENGTH) return null;
  const paragraphIndex = Number.parseInt(input?.paragraphIndex, 10);
  if (!Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex > 100) return null;
  const level = ['beginner', 'university', 'researcher'].includes(input?.level)
    ? input.level
    : 'university';
  const language = input?.language === 'en' ? 'en' : 'es';
  const sectionId = cleanText(input?.sectionId, 40);
  const paperId = cleanText(input?.paperId, 400);
  if (!sectionId || !paperId) return null;

  return {
    paperId,
    level,
    language,
    sectionId,
    paragraphIndex,
    quote: quote.slice(0, 400),
    kind: 'user',
    paperTitle: cleanText(input?.paperTitle, 1_000),
  };
}

export async function listUserHighlights(uid, paperId) {
  if (!uid) return [];
  const target = cleanText(paperId, 400);
  try {
    const snapshot = await getDocs(highlightsCollection(uid));
    return snapshot.docs
      .map(entry => ({ id: entry.id, ...entry.data() }))
      .filter(entry => !target || entry.paperId === target)
      .slice(0, MAX_HIGHLIGHTS_PER_PAPER);
  } catch (error) {
    console.warn('Could not load highlights', error);
    return [];
  }
}

export async function saveUserHighlight(uid, input) {
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

export async function removeUserHighlight(uid, highlightId) {
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
export function indexHighlightsByParagraph(highlights = [], { level, language } = {}) {
  const index = new Map();
  for (const highlight of highlights) {
    if (level && highlight.level !== level) continue;
    if (language && highlight.language !== language) continue;
    const key = `${highlight.sectionId}:${highlight.paragraphIndex}`;
    const bucket = index.get(key) || [];
    bucket.push({
      id: highlight.id,
      quote: highlight.quote,
      kind: 'user',
      source: 'user',
    });
    index.set(key, bucket);
  }
  return index;
}
