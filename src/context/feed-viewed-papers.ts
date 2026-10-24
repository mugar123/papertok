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
 * Whether the account whose papers are on hand is left behind: switching
 * accounts, or signing out. A profile that merely failed to load leaves them.
 */
export function leavesLoadedAccount(loadedUserId: string | null, userId: string | null) {
  return Boolean(loadedUserId) && loadedUserId !== userId;
}
