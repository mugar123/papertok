import type { Paper, PaperFollowMatch, PaperRecommendationScore } from '../models/paper.ts';

import { getCategoryArea, getCategoryLabel } from '../data/category-taxonomy.ts';

export type FeedReason =
  | { kind: 'follow'; followType: PaperFollowMatch['type']; text: string }
  | { kind: 'classic' | 'similar' | 'area'; text: string };

// A cosine of 0.5 on the Worker's semantic scale, before the client's ranking weights.
const SIMILAR_MIN = (0.5 - 0.4) / 0.4;

// The least citations a notable card needs to be called highly cited. The
// Worker's notable lanes are each leaf's 100 most cited papers of a year, and
// in a thin leaf or a recent year the last of them can have one or two.
const HIGHLY_CITED_MIN = 100;

// The card's own signals, which similarity has to outweigh. `preference` and
// `affinity` score the card's area, the same for every card of it: they are
// what "In your area" says. Named rather than read off the score, whose lazy
// `explanation` an enumeration would build (recommendation-engine.ts).
const OWN_PARTS = [
  'recency', 'classicBoost', 'semantic', 'learnedAuthor', 'sessionInterest', 'citations',
  'graphBoost', 'personalBoost', 'followBoost', 'diversityBoost',
] as const;

function examplesText(kinds: NonNullable<PaperRecommendationScore['exampleKinds']>) {
  // A long read is a long dwell on a card, and a like the capped liked set
  // dropped counts as one: "read" would claim more than the app knows.
  if (kinds.includes('read')) return 'engaged with';
  return kinds.length > 1 ? 'liked or saved' : kinds[0];
}

/** A follow takes precedence on every surface. Only For You scores the other reasons. */
export function feedReason(
  paper: Pick<Paper, '_debugScore' | '_notable' | '_fetchedFor' | '_semanticScore' | '_semanticExampleKinds' | 'citationCount'>,
  followed: { type: PaperFollowMatch['type']; name: string } | null,
  surface: string,
): FeedReason | null {
  if (followed) {
    const causal = surface === 'feed' || surface === 'following' || surface === 'custom_feed';
    const subject = followed.name || `this ${followed.type}`;
    return { kind: 'follow', followType: followed.type, text: `${causal ? 'Because you follow' : 'You follow'} ${subject}` };
  }
  if (surface !== 'feed') return null;
  if (paper._notable) {
    if (!paper.citationCount || paper.citationCount < HIGHLY_CITED_MIN) return null;
    // On a notable card the Worker returns its notable lanes as taxonomy leaf IDs.
    const leaf = paper._fetchedFor?.find(id => getCategoryArea(id));
    if (leaf) return { kind: 'classic', text: `Highly cited in ${getCategoryLabel(leaf)}` };
  }
  const score = paper._debugScore;
  if (!score) return null;
  const similarity = score.corpusSimilarity ?? 0;
  // Older snapshots have score kinds taken from the profile but no request evidence.
  if (paper._semanticExampleKinds?.length && score.exampleKinds?.length && !score.graphBoost && (paper._semanticScore ?? 0) >= SIMILAR_MIN
    && OWN_PARTS.every(part => (score[part] ?? 0) < similarity)) {
    return { kind: 'similar', text: `Similar to papers you ${examplesText(score.exampleKinds)}` };
  }
  if ((score.preference ?? 0) > 0) return { kind: 'area', text: 'In your area' };
  return null;
}
