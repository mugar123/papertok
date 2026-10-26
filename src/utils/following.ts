import type { PaperFollowMatch } from '../models/paper.ts';
export type FollowMetadata = { labelEn?: string; query?: string; categoryIds?: string[]; source?: string; funder?: string; arxivId?: string; localizedNames?: Record<string, string>; }
export type FollowEntity = Omit<PaperFollowMatch, 'metadata'> & { metadata?: FollowMetadata; categoryIds?: string[]; followKey?: string };
export type FollowInput = Omit<Partial<FollowEntity>, 'type'> & { type?: PaperFollowMatch['type'] | 'concept'; id?: string; display_name?: string; name?: string };

const SUPPORTED_FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project', 'journal']);
// A journal is followed by its OpenAlex source id. Its name is not unique in
// OpenAlex, and its ISSN-L only resolves to the id (ENG-123).
const JOURNAL_ID = /^S\d+$/;

/**
 * The most journals a reader follows (D3, Pablo 2026-10-25). Each one is a
 * lane the nightly harvest lists for everyone who follows it. The app writes
 * no more (`exceedsJournalFollowLimit`), and the Worker serves no more than
 * these per request (worker/paper-store.ts) whatever a client stored.
 */
export const MAX_FOLLOWED_JOURNALS = 10;

export function normalizeFollowText(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeFollowId(value: unknown) {
  return String(value || '')
    .trim()
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, '')
    .replace(/^https?:\/\/orcid\.org\//i, '')
    .replace(/^https?:\/\/ror\.org\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

export function createFollowKey(type: string, canonicalId: unknown) {
  const safeType = SUPPORTED_FOLLOW_TYPES.has(type) ? type : 'entity';
  const safeId = normalizeFollowId(canonicalId) || normalizeFollowText(canonicalId) || 'unknown';
  return `${safeType}_${safeId}`.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 240);
}

export function compactFollowData(value: unknown): unknown {
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

export function createFollowEntity(input: FollowInput = {}): FollowEntity | null {
  const type = input.type === 'concept' ? 'topic' : input.type;
  if (!SUPPORTED_FOLLOW_TYPES.has(type!)) return null;

  const displayName = String(input.displayName || input.display_name || input.name || '').trim();
  const canonicalId = normalizeFollowId(input.canonicalId || input.id || displayName);
  if (!canonicalId || !displayName) return null;
  if (type === 'journal' && !JOURNAL_ID.test(canonicalId)) return null;

  return compactFollowData({
    type,
    canonicalId,
    displayName,
    source: input.source || 'papertok',
    externalIds: input.externalIds || {},
    metadata: input.metadata || {},
  }) as FollowEntity;
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
function isSameProjectNameSpelling(oneName: string, otherName: string) {
  if (!oneName || !otherName) return false;
  const [head, full] = oneName.length < otherName.length ? [oneName, otherName] : [otherName, oneName];
  return full.startsWith(`${head}: `);
}

export function followsEntity(followedEntities: FollowEntity[], entity: FollowInput) {
  const normalized = createFollowEntity(entity);
  if (!normalized) return false;
  const id = normalizeFollowId(normalized.canonicalId);
  const name = normalizeFollowText(normalized.displayName);

  return (followedEntities || []).some((follow) => {
    if (follow.type !== normalized.type) return false;
    if (normalizeFollowId(follow.canonicalId) === id) return true;
    // No journal was ever stored by name, and two sources can share one.
    if (!name || normalized.type === 'journal') return false;
    const followName = normalizeFollowText(follow.displayName);
    if (followName === name) return true;
    return normalized.type === 'project' && isSameProjectNameSpelling(followName, name);
  });
}

/** Whether following `entity` would take the reader past MAX_FOLLOWED_JOURNALS. An unfollow never does. */
export function exceedsJournalFollowLimit(followedEntities: FollowEntity[], entity: FollowInput) {
  const normalized = createFollowEntity(entity);
  if (normalized?.type !== 'journal' || followsEntity(followedEntities, normalized)) return false;
  return followedEntities.filter(follow => follow.type === 'journal').length >= MAX_FOLLOWED_JOURNALS;
}

/** A journal follow refused by `exceedsJournalFollowLimit`; nothing was written. */
export class JournalFollowLimitError extends Error {
  constructor() {
    super(`A reader follows at most ${MAX_FOLLOWED_JOURNALS} journals.`);
    this.name = 'JournalFollowLimitError';
  }
}

export function migrateLegacyAuthors(authorNames: string[] = []) {
  return [...new Set(authorNames.filter(Boolean))].map((displayName) => createFollowEntity({
    type: 'author',
    canonicalId: `legacy:${normalizeFollowText(displayName)}`,
    displayName,
    source: 'legacy',
  })).filter(Boolean) as FollowEntity[];
}
