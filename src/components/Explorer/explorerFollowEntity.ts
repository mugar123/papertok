import type { FollowInput } from '../../utils/following.ts';
import { authorIdentityVerified } from '../../utils/entityExplorer.ts';

interface FollowableEntity {
  id?: string; code?: string; verified?: boolean; funder?: string; categoryIds?: string[];
  orcid?: string | null; ror?: string | null; localized_names?: Record<string, string>;
  _queryTopic?: boolean; query?: string;
  metadata?: { query?: string; source?: string; categoryIds?: string[] };
}

/**
 * An author page reached by a name that neither an id nor the paper could
 * confirm (utils/entityExplorer.js): its results may be several people's.
 */
export function explorerAuthorIdentityUnverified({ type, routeId, entity }: { type: string; routeId: string; entity: FollowableEntity | null }) {
  return Boolean(entity) && !authorIdentityVerified({ type, routeId, entity });
}

/** What the Explorer's Follow follows, or null when the page offers no Follow. */
export function explorerFollowEntity({
  type, routeId, entity, authorIdentityUnverified, officialName, displayName: shownName,
}: {
  type: string;
  routeId: string;
  entity: FollowableEntity | null;
  authorIdentityUnverified: boolean;
  officialName: string;
  displayName: string;
}): FollowInput | null {
  // A name-only author may be several people; following "them" would follow
  // whichever one the search returned.
  if (!entity || authorIdentityUnverified || !['author', 'institution', 'project', 'concept', 'topic'].includes(type)) return null;
  // An entity we cannot name cannot be followed. A follow is compared by id
  // and then by name, so any word standing in for a missing name becomes a
  // key shared with every other entity the page could not name — and the
  // second one followed would resolve the click against the first. Nothing
  // stands in here: with no name there is no identity, and no heart.
  const displayName = type === 'institution' ? officialName : shownName;
  if (!displayName) return null;
  const followType = type === 'concept' ? 'topic' : type;
  const metadata = entity._queryTopic
    ? {
        query: entity.metadata?.query || entity.query,
        source: entity.metadata?.source || 'free-text',
        categoryIds: entity.metadata?.categoryIds || entity.categoryIds || [],
      }
    : {
        funder: entity.funder,
        categoryIds: entity.categoryIds,
        localizedNames: type === 'institution' ? entity.localized_names : undefined,
      };
  return {
    type: followType as FollowInput['type'],
    id: entity.id || entity.code || routeId,
    displayName,
    source: type === 'project' ? 'openaire' : type === 'concept' || type === 'topic' ? 'papertok' : 'openalex',
    externalIds: {
      orcid: entity.orcid,
      ror: entity.ror,
    },
    metadata,
  };
}
