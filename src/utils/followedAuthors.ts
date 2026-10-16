import { arrayRemove, arrayUnion } from 'firebase/firestore';

/**
 * One follow toggle: the next local list, and the write that expresses it.
 *
 * The write is a field transform, not the array. The local list is whatever
 * this session managed to read — empty after a profile read that failed or
 * timed out — and writing it whole would replace every author the account
 * follows with the one it just tapped.
 */
export function toggleFollowedAuthor(followed, authorName, { union = arrayUnion, remove = arrayRemove } = {}) {
  const following = followed.includes(authorName);
  return {
    next: following ? followed.filter(name => name !== authorName) : [...followed, authorName],
    patch: { followedAuthors: following ? remove(authorName) : union(authorName) },
  };
}
