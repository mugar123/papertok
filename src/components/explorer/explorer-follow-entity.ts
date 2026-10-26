import type { FollowInput } from '../../utils/following.ts';
import { authorIdentityVerified } from '../../utils/entity-explorer.ts';
import { isListedWorkingPaperSeries } from '../../utils/publication-status.ts';

interface FollowableEntity {
  id?: string; code?: string; verified?: boolean; funder?: string; categoryIds?: string[];
  orcid?: string | null; ror?: string | null; localized_names?: Record<string, string>;
  // An OpenAlex source's own type (`journal`, `repository`, `conference`…) and ISSN-L.
  type?: string; issn_l?: string | null;
  _queryTopic?: boolean; query?: string;
  metadata?: { query?: string; source?: string; categoryIds?: string[] };
}

/**
 * An author page reached by a name that neither an id nor the paper could
 * confirm (utils/entity-explorer.ts): its results may be several people's.
 */
export function explorerAuthorIdentityUnverified({ type, routeId, entity }: { type: string; routeId: string; entity: FollowableEntity | null }) {
  return Boolean(entity) && !authorIdentityVerified({ type, routeId, entity });
}

/**
 * A source page offers Follow only for a journal (ENG-123): a repository's
 * lane would be its whole firehose, and the working-paper series OpenAlex
 * types as journals already have a lane of their own (D5).
 */
function isFollowableSource(entity: FollowableEntity) {
  return entity.type === 'journal' && !isListedWorkingPaperSeries(entity.id);
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
  if (!entity || authorIdentityUnverified || !['author', 'institution', 'project', 'concept', 'topic', 'source'].includes(type)) return null;
  if (type === 'source' && !isFollowableSource(entity)) return null;
  // An entity we cannot name cannot be followed. A follow is compared by id
  // and then by name, so any word standing in for a missing name becomes a
  // key shared with every other entity the page could not name — and the
  // second one followed would resolve the click against the first. Nothing
  // stands in here: with no name there is no identity, and no heart.
  const displayName = type === 'institution' ? officialName : shownName;
  if (!displayName) return null;
  const followType = type === 'concept' ? 'topic' : type === 'source' ? 'journal' : type;
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
      issnl: (type === 'source' && entity.issn_l) || undefined,
    },
    metadata,
  };
}
