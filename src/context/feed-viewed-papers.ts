import type { InteractionProfile } from '../utils/interaction-profile.ts';

import { viewedIds } from '../utils/interaction-profile.ts';
import { readSeenPaperIds, removeLegacySeenPaperIds, saveSeenPaperIds } from '../utils/user-scoped-storage.ts';

type DeviceStorage = Parameters<typeof readSeenPaperIds>[1];

/**
 * A card reports that it was on screen. `viewerId` is the account the card
 * was shown to, `activeUserId` the account the feed now belongs to and
 * `signedInUid` the one Firebase names right now.
 *
 * A card that reports after the account changed was viewed by the account
 * that owned it, not by the new one. Signing out sweeps the account's storage
 * before React unmounts the card, whose cleanup then reports while
 * activeUserId is still that account's; Firebase already names nobody, so that
 * report does not write the list back. The list kept across loads is read back
 * before it is written, so a second tab's views are not overwritten.
 */
export function recordCardView(
  paperId: string,
  viewerId: string | null | undefined,
  { activeUserId, signedInUid, sessionSeen }: { activeUserId: string | null; signedInUid: string | undefined; sessionSeen: Set<string> },
  storage?: DeviceStorage,
) {
  if ((viewerId || null) !== activeUserId) return;
  sessionSeen.add(paperId);
  if (signedInUid !== activeUserId) return;
  const viewed = readSeenPaperIds(activeUserId, storage);
  viewed.delete(paperId);
  viewed.add(paperId);
  saveSeenPaperIds(activeUserId, viewed, storage);
}

/**
 * The seen set an account's feed starts from: its own viewed list, never the
 * previous account's set. On an account's first load it starts from the list
 * this browser kept before.
 */
export function seenPapersForAccount(userId: string | null, storage?: DeviceStorage) {
  removeLegacySeenPaperIds(storage, userId);
  return readSeenPaperIds(userId, storage);
}

/**
 * What an account viewed on any device, as its aggregate has it, is passed
 * over on load like what this browser viewed. The seen set lists papers oldest
 * first, because a feed request holds only the last 2,000 of them
 * (`feedSeenIds`). The aggregate lists its papers newest first, so they go in
 * reversed and ahead of the papers it does not list: this browser's latest
 * views, not stored yet, and the pages loaded since.
 */
export function addViewedPapers(sessionSeen: Set<string>, profile: InteractionProfile) {
  const viewed = viewedIds(profile).reverse();
  const listed = new Set(viewed);
  const others = [...sessionSeen].filter(paperId => !listed.has(paperId));
  sessionSeen.clear();
  [...viewed, ...others].forEach(paperId => sessionSeen.add(paperId));
}

/**
 * Whether the account whose papers are on hand is left behind: switching
 * accounts, or signing out. A profile that merely failed to load leaves them.
 */
export function leavesLoadedAccount(loadedUserId: string | null, userId: string | null) {
  return Boolean(loadedUserId) && loadedUserId !== userId;
}
