import type { Paper, PaperAuthor, PaperFollowMatch } from '../models/paper.ts';

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
 * saying so after an unfollow. The name is the reader's stored follow's
 * (`nameOf`), else the one the corpus echoed; a match the corpus could not
 * name carries its id as its name, which is no name to show: `name` is then
 * empty.
 */
export function followedOnCard(
  matches: Paper['_followedEntityMatches'],
  followedAuthor: PaperAuthor | string | null,
  isFollowing: (match: PaperFollowMatch) => boolean,
  nameOf: (match: PaperFollowMatch) => string | undefined = () => undefined,
): CardFollow | null {
  const followed = (matches || []).filter((match): match is PaperFollowMatch => (
    Boolean(match) && typeof match === 'object' && TYPES.includes(match.type) && isFollowing(match)
  ));
  for (const type of TYPES) {
    const match = followed.find(candidate => candidate.type === type);
    if (match) {
      const name = (nameOf(match) || match.displayName).trim();
      return { type, name: name === match.canonicalId ? '' : name, source: 'request' };
    }
    if (type === 'author' && followedAuthor) {
      const name = typeof followedAuthor === 'string' ? followedAuthor : followedAuthor.name;
      return { type, name, source: 'card', authorKey: paperAuthorKey(followedAuthor) };
    }
  }
  return null;
}
