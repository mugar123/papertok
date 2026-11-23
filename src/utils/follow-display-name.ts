import type { FollowEntity } from './following.ts';
import { getLocalizedInstitutionName } from './institution-localization.ts';
import { findLocalTopic, isQueryTopicId, resolvePaperTopic } from './topic-navigation.ts';

export function getFollowDisplayName<T extends Partial<FollowEntity>>(follow: T, surface?: 'digest'): string | T['displayName'] {
  if (follow.type === 'institution') {
    return getLocalizedInstitutionName({ display_name: follow.displayName, metadata: follow.metadata }) || follow.displayName;
  }
  if (follow.type !== 'topic') return follow.displayName;
  if (follow.metadata?.labelEn) return follow.metadata.labelEn;

  // Keep the digest payload's free-text resolution. On screen, only a taxonomy
  // entry can rename a follow, and a reader's keyword keeps its spelling.
  if (surface !== 'digest' && isQueryTopicId(follow.canonicalId)) return follow.displayName;
  const lookup = surface === 'digest' ? resolvePaperTopic : findLocalTopic;
  return lookup(follow.canonicalId)?.label || lookup(follow.displayName)?.label || follow.displayName;
}
