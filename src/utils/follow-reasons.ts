import type { Paper, PaperAuthor, PaperFollowMatch } from '../models/paper.ts';
import type { FollowEntity } from './following.ts';
import { getFollowDisplayName } from './follow-display-name.ts';

type FollowType = PaperFollowMatch['type'];

export function paperAuthorKey(author: PaperAuthor | string) {
  return typeof author === 'string' ? author : author.id || author.name;
}

export type CardFollow =
  | { type: FollowType; name: string; source: 'request' }
  | { type: 'author'; name: string; source: 'card'; authorKey: string };

// The order a card with several follows names one in.
const TYPES: FollowType[] = ['author', 'topic', 'institution', 'project', 'journal'];

/**
 * The follow a card names: the first type that matched, in a fixed order.
 * `followedAuthor` is an author of the paper the reader follows,
 * the card's own check, which also holds outside the Following tab. Legacy
 * string matches carry no type and are skipped. A match counts only while
 * `isFollowing` still holds it, so a card kept in a feed or its cache stops
 * saying so after an unfollow. The reader's stored name takes precedence.
 * When the corpus only echoed the id, the card can still name the type.
 */
export function followedOnCard(
  matches: Paper['_followedEntityMatches'],
  followedAuthor: PaperAuthor | string | null,
  isFollowing: (match: PaperFollowMatch) => boolean,
  storedFollow?: (match: PaperFollowMatch) => FollowEntity | undefined,
): CardFollow | null {
  const followed = (matches || []).filter((match): match is PaperFollowMatch => (
    Boolean(match) && typeof match === 'object' && TYPES.includes(match.type) && isFollowing(match)
  ));
  for (const type of TYPES) {
    const match = followed.find(candidate => candidate.type === type);
    if (match) {
      const stored = storedFollow?.(match);
      const namedMatch = match.displayName.trim() !== match.canonicalId ? match : null;
      const follow = stored ?? namedMatch;
      const name = follow ? getFollowDisplayName(follow).trim() : '';
      return { type, name: name === match.canonicalId ? '' : name, source: 'request' };
    }
    if (type === 'author' && followedAuthor) {
      const name = typeof followedAuthor === 'string' ? followedAuthor : followedAuthor.name;
      return { type, name, source: 'card', authorKey: paperAuthorKey(followedAuthor) };
    }
  }
  return null;
}
