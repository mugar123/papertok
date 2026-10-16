const FOLLOW_PATH_TYPES = new Set(['author', 'topic', 'institution', 'project']);

function getNavigationId(entity) {
  const canonicalId = String(entity?.canonicalId || '').trim();
  if (
    entity?.type === 'author'
    && (!canonicalId || canonicalId.startsWith('legacy:'))
  ) {
    return String(entity?.displayName || '').trim();
  }
  return canonicalId || String(entity?.displayName || '').trim();
}

export function getFollowedEntityPath(entity) {
  if (!FOLLOW_PATH_TYPES.has(entity?.type)) return '/settings/following';

  const navigationId = getNavigationId(entity);
  if (!navigationId) return '/settings/following';

  const query = new URLSearchParams();
  const displayName = String(entity.displayName || '').trim();
  const funder = String(entity.metadata?.funder || '').trim();
  const arxivId = String(entity.metadata?.arxivId || '').trim();

  if (displayName) query.set('name', displayName);
  if (entity.type === 'project' && funder) query.set('funder', funder);
  if (entity.type === 'author' && arxivId) query.set('arxivId', arxivId);

  const suffix = query.toString();
  return `/explorer/${entity.type}/${encodeURIComponent(navigationId)}${suffix ? `?${suffix}` : ''}`;
}
