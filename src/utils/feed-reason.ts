import type { Paper, PaperFollowMatch } from '../models/paper.ts';
import type { CardFollow } from './follow-reasons.ts';

import { getCategoryArea, getCategoryLabel, getKnownCategoryLabel } from '../data/category-taxonomy.ts';

export type FeedReason =
  | { kind: 'follow'; followType: PaperFollowMatch['type']; text: string }
  | { kind: 'classic' | 'similar' | 'area'; text: string };

// On 2026-11-23, pairwise cosine among 75 stored CS papers reached 0.62 at the 99th percentile.
// With four examples, 28 of 64 cards cleared 0.5. The pairs inspected at 0.66–0.77 shared a topic.
const SIMILAR_MIN = (0.65 - 0.4) / 0.4;

// The least citations a notable card needs to be called highly cited. The
// Worker's notable lanes are each leaf's 100 most cited papers of a year, and
// in a thin leaf or a recent year the last of them can have one or two.
const HIGHLY_CITED_MIN = 100;

// Similarity competes with the card's own signals. Preference and affinity score
// its area. Listing the parts avoids evaluating the score's lazy explanation.
const OWN_PARTS = [
  'recency', 'classicBoost', 'semantic', 'learnedAuthor', 'sessionInterest', 'citations',
  'graphBoost', 'personalBoost', 'followBoost', 'diversityBoost',
] as const;

function examplesText(kinds: NonNullable<Paper['_semanticExampleKinds']>) {
  // A long read is a long dwell on a card, and a like the capped liked set
  // dropped counts as one: "read" would claim more than the app knows.
  if (kinds.includes('read')) return 'engaged with';
  return kinds.length > 1 ? 'liked or saved' : kinds[0];
}

export function feedReason(
  paper: Partial<Paper>,
  followed: CardFollow | null,
  surface: string,
  fieldLabel: string,
): FeedReason | null {
  const score = paper._debugScore;
  if (surface === 'feed' && paper._notable && (paper.citationCount ?? 0) >= HIGHLY_CITED_MIN) {
    const leaf = paper._fetchedFor?.find(id => getCategoryArea(id));
    if (leaf) return { kind: 'classic', text: `Highly cited in ${getCategoryLabel(leaf)}` };
  }
  if (followed) {
    const causal = !paper._notable && followed.source === 'request' && (surface === 'feed' || surface === 'following');
    const subject = followed.name || `this ${followed.type}`;
    return { kind: 'follow', followType: followed.type, text: `${causal ? 'Because you follow' : 'You follow'} ${subject}` };
  }
  if (surface !== 'feed' || paper._notable || !score) return null;
  const similarity = score.corpusSimilarity ?? 0;
  if (paper._semanticExampleKinds?.length && !score.graphBoost && (paper._semanticScore ?? 0) >= SIMILAR_MIN
    && OWN_PARTS.every(part => (score[part] ?? 0) < similarity)) {
    return { kind: 'similar', text: `Similar to papers you ${examplesText(paper._semanticExampleKinds)}` };
  }
  if ((score.preference ?? 0) > 0 && score.preferenceMatch) {
    const { categoryId, primary } = score.preferenceMatch;
    const label = getKnownCategoryLabel(categoryId);
    if (label) return { kind: 'area', text: primary || label === fieldLabel ? 'In your area' : `Also in ${label}` };
  }
  return null;
}
