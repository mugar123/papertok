import type { Paper, PaperFollowMatch } from '../models/paper.ts';
import type { FollowInput } from './following.ts';

type FollowType = PaperFollowMatch['type'];

const LABELS: Record<FollowType, string> = {
  author: 'Followed author',
  topic: 'Followed topic',
  institution: 'Followed institution',
  project: 'Followed project',
  journal: 'Followed journal',
};

/**
 * What a card's author is asked about the reader's follows: every id the
 * author object carries, since ids in one namespace tell two authors apart and
 * a follow may be known by the OpenAlex id or by the ORCID iD alone.
 */
export function authorFollowProbe(author: Paper['authors'][number]): FollowInput {
  const name = typeof author === 'string' ? author : author?.name;
  const id = typeof author === 'string' ? undefined : author?.id;
  const orcid = typeof author === 'string' ? undefined : author?.orcid;
  return { type: 'author', id: id || name, name, ...(orcid ? { externalIds: { orcid } } : {}) };
}

/** Whether the reader follows any author of a card. */
export function followsAnyAuthor(authors: Paper['authors'] | undefined, isFollowing: (entity: FollowInput) => boolean) {
  return (authors || []).some(author => isFollowing(authorFollowProbe(author)));
}

/**
 * The reasons a card is among the reader's follows: one entry per follow type
 * that matched, in a fixed order. `authorFollowed` is the card's own check of
 * the paper's authors against the reader's follows, which also holds outside
 * the Following tab. Legacy string matches carry no type and are skipped. A
 * match counts only while `isFollowing` still holds it, so a card kept in a
 * feed or its cache stops saying so after an unfollow.
 */
export function followReasonLabels(
  matches: Paper['_followedEntityMatches'],
  authorFollowed: boolean,
  isFollowing: (match: PaperFollowMatch) => boolean,
): Array<{ type: FollowType; label: string }> {
  const matched = new Set<FollowType>(authorFollowed ? ['author'] : []);
  for (const match of matches || []) {
    if (match && typeof match === 'object' && match.type in LABELS && isFollowing(match)) matched.add(match.type);
  }
  return (Object.keys(LABELS) as FollowType[])
    .filter(type => matched.has(type))
    .map(type => ({ type, label: LABELS[type] }));
}
