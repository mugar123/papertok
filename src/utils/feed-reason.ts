import type { Paper, PaperFollowMatch, PaperRecommendationScore } from '../models/paper.ts';

export type FeedReason = { kind: 'follow' | 'classic' | 'similar' | 'area'; text: string };

// The least similarity, in the client's points (0 to 100), that the card calls
// similar: 25 is a cosine of 0.5 to the closest example (`_semanticScore` is 0
// at a cosine of 0.4 and 1 at 0.8, worker/paper-store.ts `scorer`).
const SIMILAR_MIN = 25;

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

/**
 * Why the feed shows a card, from the parts of its score the app computed
 * (`_debugScore`, recommendation-engine.ts) and the follow the card found on
 * it (follow-reasons.ts), or null when none of the reasons holds, as on a
 * search result, which no feed scored. A follow comes first, as it did when
 * the card said "Followed author"; then a notable card, which the Worker adds
 * as one of its area's most cited; then similarity to the reader's examples,
 * when it is at least SIMILAR_MIN and outweighs the card's other signals;
 * then a card of an area the reader picked. A card the feed added after the
 * reader opened a paper (`graphBoost`) was ranked by that paper, which need
 * not be an example, so it is never called similar to them.
 */
export function feedReason(
  paper: Pick<Paper, '_debugScore' | '_notable' | 'citationCount'>,
  followed: { type: PaperFollowMatch['type']; name: string } | null,
  areaLabel: string | null | undefined,
): FeedReason | null {
  if (followed) {
    return { kind: 'follow', text: followed.name ? `Because you follow ${followed.name}` : `Because you follow this ${followed.type}` };
  }
  if (paper._notable === true && areaLabel && (paper.citationCount ?? 0) >= HIGHLY_CITED_MIN) return { kind: 'classic', text: `Highly cited in ${areaLabel}` };
  const score = paper._debugScore;
  if (!score) return null;
  const similarity = score.corpusSimilarity ?? 0;
  if (score.exampleKinds?.length && !score.graphBoost && similarity >= SIMILAR_MIN
    && OWN_PARTS.every(part => (score[part] ?? 0) < similarity)) {
    return { kind: 'similar', text: `Similar to papers you ${examplesText(score.exampleKinds)}` };
  }
  if ((score.preference ?? 0) > 0) return { kind: 'area', text: 'In your area' };
  return null;
}
