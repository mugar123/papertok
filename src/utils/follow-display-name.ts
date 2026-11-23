import { getKnownCategoryLabel } from '../data/category-taxonomy.ts';
import type { FollowEntity } from './following.ts';
import { getLocalizedInstitutionName } from './institution-localization.ts';
import { findLocalTopic, isQueryTopicId, resolvePaperTopic } from './topic-navigation.ts';

export function getFollowDisplayName(follow: Partial<FollowEntity>, surface?: 'digest'): string {
  const displayName = typeof follow.displayName === 'string' ? follow.displayName : '';
  if (follow.type === 'institution') {
    return getLocalizedInstitutionName({ display_name: displayName, metadata: follow.metadata }) || displayName;
  }
  if (follow.type !== 'topic') return displayName;
  const labelEn = follow.metadata?.labelEn;
  const englishLabel = typeof labelEn === 'string' && labelEn.trim() ? labelEn : '';

  if (surface === 'digest') {
    return englishLabel || resolvePaperTopic(follow.canonicalId)?.label || resolvePaperTopic(displayName)?.label || displayName;
  }
  if (isQueryTopicId(follow.canonicalId)) return displayName;
  return getKnownCategoryLabel(follow.canonicalId ?? '') || englishLabel
    || findLocalTopic(follow.canonicalId)?.label || findLocalTopic(displayName)?.label || displayName;
}
