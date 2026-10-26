import type { PaperFollowMatch } from '../models/paper.ts';
export type FollowMetadata = { labelEn?: string; query?: string; categoryIds?: string[]; source?: string; funder?: string; arxivId?: string; localizedNames?: Record<string, string>; }
export type FollowEntity = Omit<PaperFollowMatch, 'metadata'> & { metadata?: FollowMetadata; categoryIds?: string[]; followKey?: string };
export type FollowInput = Omit<Partial<FollowEntity>, 'type'> & { type?: PaperFollowMatch['type'] | 'concept'; id?: string; display_name?: string; name?: string };

const SUPPORTED_FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project', 'journal']);
/**
 * The follow types the weekly digest is built from. A journal is left out
 * (ENG-123, D6): the client sends none and the Worker keeps none, so neither
 * can take a follow slot or a preview from the others.
 */
export const DIGEST_FOLLOW_TYPES: readonly string[] = ['author', 'topic', 'institution', 'project'];
export const isDigestFollow = (follow: unknown) => DIGEST_FOLLOW_TYPES.includes(String((follow as { type?: unknown } | null | undefined)?.type));

// A journal is followed by its OpenAlex source id. Its name is not unique in
// OpenAlex, and its ISSN-L only resolves to the id (ENG-123).
const JOURNAL_ID = /^S\d+$/;

/**
 * The most journals a reader follows (D3, Pablo 2026-10-25). Each one is a
 * lane the nightly harvest lists for everyone who follows it. A session writes
 * no more than its follow list allows (`planFollowToggle`), though two devices
 * following at once can store an eleventh, and the Worker serves no more than
 * these per request (`servedFollows`) whatever a client stored.
 */
export const MAX_FOLLOWED_JOURNALS = 10;

/**
 * The OpenAlex work types a followed journal's updates list (ENG-123): its
 * research articles and its reviews, which OpenAlex types `review` (every
 * paper of the Annual Review and Nature Reviews journals). Not its editorials,
 * letters, errata or paratext. The Worker's lane, the paper store's filing
 * and the Following page read the same list.
 */
export const FOLLOWED_JOURNAL_WORK_TYPES: readonly string[] = ['article', 'review'];
export const FOLLOWED_JOURNAL_TYPE_FILTER = `type:${FOLLOWED_JOURNAL_WORK_TYPES.join('|')}`;

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

/**
 * The follow list has not arrived, so what this account follows is unknown.
 *
 * FollowingContext sets it once it stops waiting for the first snapshot. That
 * is not a failure: the listener is still attached and Firestore reconnects on
 * its own. It lets consumers tell "we do not know what this account follows"
 * from "this account follows nobody" — a distinction that decides whether it
 * is safe to write notification preferences derived from the list.
 * `planFollowToggle` throws it for a new journal, which cannot be counted
 * against a list it does not have. After a snapshot error the listener has
 * ended and the list will not arrive in this session, so that error is not
 * `retryable`: only a reload attaches a new listener.
 */
export class FollowsUnavailableError extends Error {
  declare code: string;
  declare retryable: boolean;
  constructor({ retryable = true }: { retryable?: boolean } = {}) {
    super(retryable ? 'The follow list has not arrived yet.' : 'The follow list could not be loaded.');
    this.name = 'FollowsUnavailableError';
    this.code = 'FOLLOWS_UNAVAILABLE';
    this.retryable = retryable;
  }
}

/**
 * Where the follow list Firestore sends stands: `waiting` for its first
 * snapshot (the listener is attached and may still answer), `listed` once a
 * snapshot arrived, `failed` after a snapshot error ended the listener.
 */
export type FollowListState = 'waiting' | 'listed' | 'failed';

/** A journal follow refused by `planFollowToggle`; nothing was written. */
export class JournalFollowLimitError extends Error {
  constructor() {
    super(`A reader follows at most ${MAX_FOLLOWED_JOURNALS} journals.`);
    this.name = 'JournalFollowLimitError';
  }
}

/**
 * What a press of Follow does to the follow list in hand: unfollows `entity`
 * when the list has it, and follows it otherwise. A new journal is counted
 * against the journals in the list, since Firestore rules cannot count them,
 * so it is refused, with nothing written, past MAX_FOLLOWED_JOURNALS (D3) and
 * while the list is not the one Firestore sent (`list`): before the first
 * snapshot, or once a snapshot error put the legacy authors in its place.
 */
export function planFollowToggle(followedEntities: FollowEntity[], entity: FollowEntity, { list }: { list: FollowListState }) {
  const existing = followedEntities.find(follow => followsEntity([follow], entity));
  if (existing) return { existing, next: followedEntities.filter(follow => !followsEntity([follow], entity)) };
  if (entity.type === 'journal') {
    if (list !== 'listed') throw new FollowsUnavailableError({ retryable: list === 'waiting' });
    if (followedEntities.filter(follow => follow.type === 'journal').length >= MAX_FOLLOWED_JOURNALS) throw new JournalFollowLimitError();
  }
  return { existing, next: [...followedEntities, entity] };
}

/**
 * The `follow_change` event of a press that followed or unfollowed `entity`.
 * Which journals a reader follows stays out of analytics, detailed analytics
 * included: a journal goes by its type alone, never its id (ENG-123, Pablo
 * 2026-10-26).
 */
export function followChangeEvent(entity: FollowEntity, wasFollowing: boolean) {
  return {
    entity_type: entity.type,
    action: wasFollowing ? 'remove' : 'add',
    surface: 'other',
    entity_id: entity.type === 'journal' ? undefined : entity.canonicalId,
  };
}

export function migrateLegacyAuthors(authorNames: string[] = []) {
  return [...new Set(authorNames.filter(Boolean))].map((displayName) => createFollowEntity({
    type: 'author',
    canonicalId: `legacy:${normalizeFollowText(displayName)}`,
    displayName,
    source: 'legacy',
  })).filter(Boolean) as FollowEntity[];
}
