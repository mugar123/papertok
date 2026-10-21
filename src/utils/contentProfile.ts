import { hasUsableAIAbstract } from './aiExplanationAccess.ts';

/**
 * What a paper says, as terms, and how closely it reads like what a reader
 * keeps. The interaction profile stores the reader's side (a decayed weight per
 * term, like its concepts); the ranking scores a candidate against it. A term is
 * a word or a pair of adjacent words of the title and abstract, so the match
 * exists the moment a card arrives, before OpenAlex has classified it.
 */

// The interaction document keeps the first 500 characters of an abstract. A
// profile rebuilt from those documents has to see the same text the events saw.
export const CONTENT_TEXT_CHARS = 500;
// The terms one paper teaches or is scored on. Its most repeated come first.
export const MAX_TERMS_PER_PAPER = 30;
// Fewer positives than this say too little about what the reader wants.
export const MIN_CONTENT_POSITIVES = 3;
// A title is the paper's own summary of itself; its words count double.
const TITLE_WEIGHT = 2;

const STOP_WORDS = new Set((
  'a about above after again against all also although always am among an and another any are around as at be because been before being between both but by '
  + 'can could did do does doing done down during each either else ever every few for from further had has have having he her here hers him his how however i if in into is it its '
  + 'just may me might more most much must my no nor not now of off often on once one only onto or other our out over own per same she should since so some such than that the their '
  + 'them then there therefore these they this those through thus to too toward under until up upon us very via was we were what when where whether which while who whom whose why will '
  + 'with within without would yet you your '
  + 'abstract approach approaches based current demonstrate demonstrates demonstrated due existing finally first furthermore give given gives introduce introduces key '
  + 'large make makes many method methods new novel paper papers perform present presents propose proposed proposes provide provides recent recently report reports result results '
  + 'second several show shown shows significant simple specific study studies task tasks three two use used uses using various well work works'
).split(' '));

// Plural endings only: "networks" and "network" are one term, and nothing
// stronger, which would merge words that mean different things.
function stem(word: string) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function addTerms(counts: Map<string, number>, text: string, weight: number) {
  const words = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
  let previous = '';
  words.forEach((raw) => {
    const word = raw.length < 2 || /^\d+$/.test(raw) || STOP_WORDS.has(raw) ? '' : stem(raw);
    if (!word) {
      previous = '';
      return;
    }
    counts.set(word, (counts.get(word) || 0) + weight);
    if (previous && previous !== word) {
      const pair = `${previous} ${word}`;
      counts.set(pair, (counts.get(pair) || 0) + weight);
    }
    previous = word;
  });
}

/**
 * The terms of a title and an abstract, with how often each occurs (the title
 * counting double), the most repeated MAX_TERMS_PER_PAPER of them.
 */
export function termCountsOf(title: unknown, abstract: unknown) {
  const counts = new Map<string, number>();
  if (typeof title === 'string') addTerms(counts, title, TITLE_WEIGHT);
  if (typeof abstract === 'string' && hasUsableAIAbstract(abstract)) {
    addTerms(counts, abstract.slice(0, CONTENT_TEXT_CHARS), 1);
  }
  // Array.prototype.sort is stable: the terms met first keep their place on a tie.
  return new Map([...counts].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_PAPER));
}

interface TextCarrier { title?: unknown; abstract?: unknown; summary?: unknown }
const termCache = new WeakMap<object, { title: unknown; abstract: unknown; counts: Map<string, number> }>();

/** A card's terms. Computed once per card: a re-rank scores the same cards again. */
export function paperTermCounts(paper: TextCarrier) {
  // The feed's builder fills `summary` from the abstract; a stored copy has either.
  const abstract = [paper.abstract, paper.summary].find(text => typeof text === 'string' && hasUsableAIAbstract(text));
  const cached = termCache.get(paper);
  if (cached && cached.title === paper.title && cached.abstract === abstract) return cached.counts;
  const counts = termCountsOf(paper.title, abstract);
  termCache.set(paper, { title: paper.title, abstract, counts });
  return counts;
}

export interface PoolTermStats {
  idf(term: string): number;
  /** The length of the reader's weights, each scaled by the pool's idf. */
  profileNorm(affinities: Record<string, number>): number;
}

/**
 * How rare each term is among the cards being ranked together. A term all of
 * them carry ("learning", in a machine-learning feed) separates none from the
 * rest, so it counts for little; one a few carry decides.
 */
export function poolTermStats(papers: TextCarrier[]): PoolTermStats {
  const documentFrequency = new Map<string, number>();
  papers.forEach(paper => paperTermCounts(paper).forEach((_count, term) => {
    documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
  }));
  const idfs = new Map<string, number>();
  const norms = new WeakMap<object, number>();
  const idf = (term: string) => {
    let value = idfs.get(term);
    if (value === undefined) {
      value = Math.log((papers.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1;
      idfs.set(term, value);
    }
    return value;
  };
  return {
    idf,
    profileNorm(affinities) {
      let norm = norms.get(affinities);
      if (norm === undefined) {
        norm = Math.sqrt(Object.entries(affinities).reduce((sum, [term, weight]) => sum + (weight * idf(term)) ** 2, 0));
        norms.set(affinities, norm);
      }
      return norm;
    },
  };
}

/**
 * Cosine of a card's terms against the reader's weights, both scaled by the
 * pool's idf: 1 for a card made of what the reader likes, 0 for one that shares
 * nothing with it, below 0 for one made of what they refused.
 */
export function contentSimilarity(counts: Map<string, number>, affinities: Record<string, number>, stats: PoolTermStats) {
  let dot = 0;
  let paperSquares = 0;
  counts.forEach((count, term) => {
    const weight = (1 + Math.log(count)) * stats.idf(term);
    paperSquares += weight * weight;
    // Own keys only: "constructor" is also a word.
    if (Object.hasOwn(affinities, term)) dot += weight * affinities[term] * stats.idf(term);
  });
  const norm = Math.sqrt(paperSquares) * stats.profileNorm(affinities);
  return norm > 0 ? Math.max(-1, Math.min(1, dot / norm)) : 0;
}
