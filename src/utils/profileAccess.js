/**
 * Who is looking at a profile decides what the page may even attempt to show
 * or load. This is deliberately a pure function with a test, because the rule
 * it encodes is a privacy boundary, not a styling choice: saved papers, likes
 * and unpublished lists exist only behind `isOwner`.
 *
 * Firestore rules remain the real wall — a visitor who somehow reached the
 * owner tabs would still be refused every private read. This helper keeps the
 * UI from asking in the first place.
 */

export const OWNER_PROFILE_TABS = Object.freeze(['lists', 'saved', 'liked']);
export const VISITOR_PROFILE_TABS = Object.freeze(['lists']);

export function resolveProfileView({ viewerUid, profileUid, selfMode = false } = {}) {
  // selfMode is the /profile route, which only ever renders behind
  // ProtectedRoute: the viewer is the owner by construction, even before the
  // profile document (which may not exist yet) has an uid to compare against.
  const isOwner = selfMode === true || (
    typeof viewerUid === 'string' && viewerUid.length > 0
    && typeof profileUid === 'string' && profileUid.length > 0
    && viewerUid === profileUid
  );

  return {
    isOwner,
    tabs: isOwner ? OWNER_PROFILE_TABS : VISITOR_PROFILE_TABS,
  };
}
