const SUPPORTED_FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project']);

export function normalizeFollowText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeFollowId(value) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, '')
    .replace(/^https?:\/\/orcid\.org\//i, '')
    .replace(/^https?:\/\/ror\.org\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

export function createFollowKey(type, canonicalId) {
  const safeType = SUPPORTED_FOLLOW_TYPES.has(type) ? type : 'entity';
  const safeId = normalizeFollowId(canonicalId) || normalizeFollowText(canonicalId) || 'unknown';
  return `${safeType}_${safeId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 240);
}

export function compactFollowData(value) {
  if (Array.isArray(value)) {
    return value.map(compactFollowData).filter(item => item !== undefined);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, compactFollowData(item)]));
  }
  return value;
}

export function createFollowEntity(input = {}) {
  const type = input.type === 'concept' ? 'topic' : input.type;
  if (!SUPPORTED_FOLLOW_TYPES.has(type)) return null;

  const displayName = String(input.displayName || input.display_name || input.name || '').trim();
  const canonicalId = normalizeFollowId(input.canonicalId || input.id || displayName);
  if (!canonicalId || !displayName) return null;

  return compactFollowData({
    type,
    canonicalId,
    displayName,
    source: input.source || 'papertok',
    externalIds: input.externalIds || {},
    metadata: input.metadata || {},
  });
}

/**
 * The two spellings a project's name is stored under. A project's canonical id
 * moved from the bare grant code to the OpenAIRE id, so every follow written
 * before that move survives only through the displayName fallback below — and
 * the name it was stored under depends on which surface wrote it: the search
 * box wrote the acronym alone, the Explorer writes `${acronym}: ${title}`
 * (getProjectDisplayName). Recognising one and not the other orphans the other
 * population, and an orphaned follow duplicates itself on the next click.
 *
 * The acronym counts as the same name only when it is the WHOLE segment
 * heading the longer spelling, separator included. Two projects that share an
 * acronym but not a title keep different names, because neither spelling then
 * heads the other.
 */
function isSameProjectNameSpelling(oneName, otherName) {
  if (!oneName || !otherName) return false;
  const [head, full] = oneName.length < otherName.length ? [oneName, otherName] : [otherName, oneName];
  return full.startsWith(`${head}: `);
}

export function followsEntity(followedEntities, entity) {
  const normalized = createFollowEntity(entity);
  if (!normalized) return false;
  const id = normalizeFollowId(normalized.canonicalId);
  const name = normalizeFollowText(normalized.displayName);

  return (followedEntities || []).some((follow) => {
    if (follow.type !== normalized.type) return false;
    if (normalizeFollowId(follow.canonicalId) === id) return true;
    if (!name) return false;
    const followName = normalizeFollowText(follow.displayName);
    if (followName === name) return true;
    return normalized.type === 'project' && isSameProjectNameSpelling(followName, name);
  });
}

export function getFollowingStorageKey(userId) {
  return `papertok_following_${String(userId || 'anonymous').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

export function migrateLegacyAuthors(authorNames = []) {
  return [...new Set(authorNames.filter(Boolean))].map((displayName) => createFollowEntity({
    type: 'author',
    canonicalId: `legacy:${normalizeFollowText(displayName)}`,
    displayName,
    source: 'legacy',
  })).filter(Boolean);
}
