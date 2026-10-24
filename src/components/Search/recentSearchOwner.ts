import type { SearchSection } from '../../services/entitySearchService.ts';

/**
 * The palette's recent queries, held with the account they were read for.
 * The palette stays mounted across sign-outs and account switches, so the
 * queries in memory can belong to the previous account until the palette
 * reads the new one's on its next open.
 */
export interface RecentOwner { uid?: string; queries: string[] }

/** The recents the palette may show: only those read for the signed-in account. */
export function recentsShownTo(owner: RecentOwner, uid: string | undefined): string[] {
  return owner.uid === uid ? owner.queries : [];
}

/**
 * Whether closing the palette saves its query to `uid`'s recents: a query the
 * reader typed, whose answer is on screen and found something in the open
 * section, by an account whose recents are the ones in memory. After an
 * account change the query in the field is the previous account's, so it is
 * never saved under the new UID.
 */
export function shouldRememberQuery({
  uid, ownerUid, typed, hasSearched, resultsTerm, query, totalResults, isPending, activeSection, results,
}: {
  uid: string | undefined;
  ownerUid: string | undefined;
  typed: boolean;
  hasSearched: boolean;
  resultsTerm: string;
  query: string;
  totalResults: number;
  isPending: boolean;
  activeSection: 'all' | SearchSection;
  results: Record<SearchSection, readonly unknown[]>;
}) {
  if (!uid || ownerUid !== uid || !typed || !hasSearched
    || resultsTerm !== query.trim() || totalResults === 0 || isPending
    || (activeSection !== 'all' && results[activeSection].length === 0)) return false;
  return true;
}
