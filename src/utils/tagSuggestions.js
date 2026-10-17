/**
 * Tags to suggest for a paper in the save modal, from what the paper already
 * carries — no request of its own.
 *
 * In order: the reader's own tags that the paper's terms match (their
 * vocabulary beats ours), then the paper's strongest terms — OpenAlex
 * keywords, concepts and topics by score, then the topics the card's own chips
 * name (its categories in words, utils/paperTopicTags.js), the very generic
 * level-0 concepts ("Physics") last — then its area as a last resort. Most
 * feed papers carry categories and nothing else, so the chips' words are what
 * keeps the row from being only the area. Category codes arXiv
 * reports as keywords ("quant-ph") are not words anyone tags with, and a tag
 * the paper already has is never offered again.
 */

import { getCategoryLabel } from '../data/categories.js';
import { buildPaperTopicTags } from './paperTopicTags.js';

const MAX_TAG_LENGTH = 40;

const nameOf = (term) => (typeof term === 'string'
  ? term
  : term?.display_name || term?.name || term?.value || term?.label || '');

const key = (text) => String(text).trim().toLowerCase();

function paperTerms(paper) {
  const codes = new Set([...(paper?.categories || []), ...(paper?.allCategories || [])].map(key));
  const terms = [];
  const seen = new Set();
  const add = (term, rank) => {
    const name = nameOf(term).trim();
    const k = key(name);
    if (!name || name.length > MAX_TAG_LENGTH || codes.has(k) || seen.has(k)) return;
    seen.add(k);
    const score = Number.isFinite(term?.score) ? term.score : 0.5;
    // A level-0 concept is a whole discipline: keep it, but behind the rest.
    const generic = term?.level === 0 ? 1 : 0;
    terms.push({ name, k, score, generic, rank });
  };
  (paper?.keywords || []).forEach((term) => add(term, 0));
  (paper?.concepts || []).forEach((term) => add(term, 1));
  (paper?.openAlex?.concepts || []).forEach((term) => add(term, 1));
  (paper?.topics || []).forEach((term) => add(term, 2));
  const primary = paper?.primaryCategory || paper?.categories?.[0] || '';
  const primaryLabel = primary ? getCategoryLabel(primary) : '';
  if (primaryLabel && primaryLabel !== primary) add({ display_name: primaryLabel, score: 0.45 }, 3);
  buildPaperTopicTags(paper, 8).forEach((chip) => add({ display_name: chip.label, score: 0.4 }, 3));
  return terms
    .sort((a, b) => a.generic - b.generic || b.score - a.score || a.rank - b.rank)
    .map(({ name, k }) => ({ name, k }));
}

/**
 * @param {object} paper
 * @param {object} options
 * @param {string[]} options.current   tags already on this paper (pending)
 * @param {string[]} options.userTags  every tag the reader has used, most used first
 * @param {string|null} options.area   the paper's area label, a fallback
 * @param {number} options.limit
 * @returns {string[]}
 */
export function suggestTags(paper, { current = [], userTags = [], area = null, limit = 5 } = {}) {
  const taken = new Set(current.map(key));
  const out = [];
  const push = (tag) => {
    const k = key(tag);
    if (!k || taken.has(k) || out.length >= limit) return;
    taken.add(k);
    out.push(tag);
  };

  const terms = paperTerms(paper);
  // The reader's own tag, in their spelling, when it names one of the
  // paper's terms or a word of one ("decoding" for "Surface code decoding").
  for (const tag of userTags) {
    const k = key(tag);
    if (!k) continue;
    const matches = terms.some((term) => term.k === k
      || term.k.split(/\s+/).includes(k)
      || (k.includes(' ') && term.k.includes(k)));
    if (matches) push(tag);
  }
  for (const term of terms) push(term.k);
  if (area) push(key(area));
  return out;
}

/** Every tag in the reading library, most used first. */
export function libraryTags(personalLibrary) {
  const counts = new Map();
  for (const record of Object.values(personalLibrary || {})) {
    for (const tag of record?.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
}
