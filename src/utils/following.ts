import type { PaperFollowMatch } from '../models/paper.ts';
import { queryIsAuthoritative } from './cache-authority.ts';
import { getAllLeafCategories, getAreaLeaves } from '../data/category-taxonomy.ts';
export type FollowMetadata = { labelEn?: string; query?: string; categoryIds?: string[]; source?: string; funder?: string; arxivId?: string; localizedNames?: Record<string, string>; }
export type FollowEntity = Omit<PaperFollowMatch, 'metadata'> & { metadata?: FollowMetadata; categoryIds?: string[]; followKey?: string };
export type FollowInput = Omit<Partial<FollowEntity>, 'type'> & { type?: PaperFollowMatch['type'] | 'concept'; id?: string; display_name?: string; name?: string };

/**
 * What a reader can follow. A journal no longer can: its follows were
 * retired, and the ones stored are deleted when the follow list loads
 * (`isRetiredFollow`). A journal is still a custom feed's ingredient, which
 * reaches the Worker's lanes as a `journal` follow (`corpusRequestOf`).
 */
const SUPPORTED_FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project']);
/**
 * The follow types the weekly digest is built from: every type a reader can
 * follow. The Worker keeps no other, so a journal sent by an app from before
 * journal follows were retired takes no follow slot or preview.
 */
export const DIGEST_FOLLOW_TYPES: readonly string[] = [...SUPPORTED_FOLLOW_TYPES];
export const isDigestFollow = (follow: unknown) => DIGEST_FOLLOW_TYPES.includes(String((follow as { type?: unknown } | null | undefined)?.type));

/** A stored follow of a type no longer followed: a journal (ENG-123), deleted when the list loads. */
export const isRetiredFollow = (follow: { type?: unknown }) => follow.type === 'journal';

/**
 * A snapshot's follows split into those the app keeps and the document ids of
 * the retired ones to delete. `deleting` holds the ids whose delete is under
 * way, which a later snapshot leaves alone; it gains this snapshot's, and an
 * id taken out of it after a failed delete is deleted again on the next one.
 */
export function splitRetiredFollows<Follow extends { type?: unknown }>(docs: readonly { id: string; follow: Follow }[], deleting: Set<string>) {
  const kept: Follow[] = [];
  const toDelete: string[] = [];
  for (const { id, follow } of docs) {
    if (!isRetiredFollow(follow)) kept.push(follow);
    else if (!deleting.has(id)) {
      deleting.add(id);
      toDelete.push(id);
    }
  }
  return { kept, toDelete };
}

/**
 * The most journals a request's lanes serve (D3, Pablo 2026-10-25). Each one
 * is a lane the nightly harvest lists while a feed asks for it. A custom feed
 * holds no more, and the Worker serves no more per request (`servedFollows`)
 * whatever a client sent.
 */
export const MAX_FOLLOWED_JOURNALS = 10;

/**
 * The OpenAlex work types a journal's lane lists (ENG-123): its research
 * articles and its reviews, which OpenAlex types `review` (every paper of the
 * Annual Review and Nature Reviews journals). Not its editorials, letters,
 * errata or paratext. The Worker's lane and the paper store's filing read the
 * same list.
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

const CATEGORY_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));

/**
 * The provider ids `follow_change` may carry (ENG-192): an OpenAlex author or
 * ORCID iD, an OpenAlex institution or ROR id, an OpenAlex topic or concept or
 * one of the app's areas or categories. A project's id can be address-bar text, and a
 * legacy or nameless follow's id is the person's name, so neither is sent.
 */
const VERIFIED_FOLLOW_ID: Partial<Record<FollowEntity['type'], (id: string) => boolean>> = {
  author: id => /^A\d+$/.test(id) || /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(id),
  institution: id => /^I\d+$/.test(id) || /^0[a-hj-km-np-tv-z0-9]{6}\d{2}$/.test(id),
  topic: id => /^[TC]\d+$/.test(id) || CATEGORY_IDS.has(id) || getAreaLeaves(id) !== null,
};

/** Whether `id` is a provider id the type's follow is known by (not a name or address-bar text). */
export const isVerifiedFollowId = (type: FollowEntity['type'], id: string) => Boolean(VERIFIED_FOLLOW_ID[type]?.(id));

/**
 * The ids an institution is identified by, by namespace: its OpenAlex id and
 * the ROR id it carries beside it. A follow without one (a legacy follow
 * stored by name) has none.
 *
 * Only institutions: their ids are one to one with the institution, and two
 * with one name are two institutions. OpenAlex splits one author across
 * several ids, so authors keep matching by id, then by name.
 */
function followIdsByNamespace(entity: Pick<FollowEntity, 'type' | 'canonicalId' | 'externalIds'>) {
  const ids = new Map<'openalex' | 'external', string>();
  if (entity.type !== 'institution') return ids;
  for (const id of [entity.canonicalId, entity.externalIds?.ror].map(normalizeFollowId)) {
    if (isVerifiedFollowId('institution', id)) ids.set(/^I\d+$/.test(id) ? 'openalex' : 'external', id);
  }
  return ids;
}

/**
 * Whether ids settle that two institutions are one: true when
 * they share an id, false when they share a namespace and every id in it
 * differs (two institutions with one name), null when the ids say nothing
 * because the two carry ids of different namespaces only (an OpenAlex id
 * against a ROR id), or one carries none, or the entity is not an institution.
 */
function sameByIds(one: Parameters<typeof followIdsByNamespace>[0], other: Parameters<typeof followIdsByNamespace>[0]) {
  const otherIds = followIdsByNamespace(other);
  let shared = false;
  for (const [namespace, id] of followIdsByNamespace(one)) {
    const otherId = otherIds.get(namespace);
    if (otherId === undefined) continue;
    if (otherId === id) return true;
    shared = true;
  }
  return shared ? false : null;
}

export function followsEntity(followedEntities: FollowEntity[], entity: FollowInput) {
  const normalized = createFollowEntity(entity);
  if (!normalized) return false;
  const id = normalizeFollowId(normalized.canonicalId);
  const name = normalizeFollowText(normalized.displayName);

  return (followedEntities || []).some((follow) => {
    if (follow.type !== normalized.type) return false;
    if (normalizeFollowId(follow.canonicalId) === id) return true;
    // Ids in one namespace tell two institutions apart even when they share a name.
    // With no namespace in common, the name decides, as it does for a follow
    // stored by name: an OpenAlex id and a ROR id do not say they differ.
    const byIds = sameByIds(normalized, follow);
    if (byIds !== null) return byIds;
    if (!name) return false;
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
 */
export class FollowsUnavailableError extends Error {
  declare code: string;
  constructor() {
    super('The follow list has not arrived yet.');
    this.name = 'FollowsUnavailableError';
    this.code = 'FOLLOWS_UNAVAILABLE';
  }
}

/**
 * Where the follow list Firestore sends stands: `waiting` for its first
 * snapshot (the listener is attached and may still answer), `listed` once a
 * snapshot arrived, `failed` after a snapshot error ended the listener.
 */
export type FollowListState = 'waiting' | 'listed' | 'failed';

/**
 * What the follows listener does with a snapshot. Firestore answers a list it
 * has not reached the server for with an empty snapshot from its cache, and
 * the listener took that as the account following nothing: the Following page
 * said "You're not following anything yet" to an account that follows fifty.
 * Before the list is known an empty cached answer is `wait`: the grace timer
 * still runs, and the server's own answer (a metadata change when it holds the
 * same documents) comes next. Follows the cache does hold are a `list`. Once
 * listed, a snapshot that changed only metadata is a `confirm`: the documents
 * on screen are the same, and replacing them would hand every consumer a new
 * array for the same follows.
 */
export function followSnapshotAction(
  snapshot: { empty?: boolean; size?: number; metadata?: { fromCache?: boolean }; docChanges: () => unknown[] },
  list: FollowListState,
): 'wait' | 'list' | 'confirm' {
  if (list !== 'listed') return queryIsAuthoritative(snapshot) ? 'list' : 'wait';
  return snapshot.docChanges().length === 0 ? 'confirm' : 'list';
}

/**
 * What a press of Follow does to the follow list in hand: unfollows `entity`
 * when the list has it, and follows it otherwise.
 */
export function planFollowToggle(followedEntities: FollowEntity[], entity: FollowEntity) {
  const existing = followedEntities.find(follow => followsEntity([follow], entity));
  if (existing) return { existing, next: followedEntities.filter(follow => !followsEntity([follow], entity)) };
  return { existing, next: [...followedEntities, entity] };
}

/**
 * The `follow_change` event of a press that followed or unfollowed `entity`.
 * It carries the entity's id only when the id is a verified provider id.
 */
export function followChangeEvent(entity: FollowEntity, wasFollowing: boolean) {
  return {
    entity_type: entity.type,
    action: wasFollowing ? 'remove' : 'add',
    surface: 'other',
    entity_id: isVerifiedFollowId(entity.type, entity.canonicalId) ? entity.canonicalId : undefined,
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
