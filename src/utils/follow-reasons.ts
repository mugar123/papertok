import type { Paper, PaperFollowMatch } from '../models/paper.ts';

type FollowType = PaperFollowMatch['type'];

const LABELS: Record<FollowType, string> = {
  author: 'Followed author',
  topic: 'Followed topic',
  institution: 'Followed institution',
  project: 'Followed project',
  journal: 'Followed journal',
};

/**
 * The reasons a card is among the reader's follows: one entry per follow type
 * that matched, in a fixed order. `authorFollowed` is the card's own check of
 * the paper's authors against the reader's follows, which also holds outside
 * the Following tab. Legacy string matches carry no type and are skipped.
 */
export function followReasonLabels(
  matches: Paper['_followedEntityMatches'],
  authorFollowed = false,
): Array<{ type: FollowType; label: string }> {
  const matched = new Set<FollowType>(authorFollowed ? ['author'] : []);
  for (const match of matches || []) {
    if (match && typeof match === 'object' && match.type in LABELS) matched.add(match.type);
  }
  return (Object.keys(LABELS) as FollowType[])
    .filter(type => matched.has(type))
    .map(type => ({ type, label: LABELS[type] }));
}
