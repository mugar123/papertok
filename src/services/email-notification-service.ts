import type { Paper, PaperAuthor } from '../models/paper.ts';
import { isDigestFollow, type FollowEntity } from '../utils/following.ts';
type NotificationPaper = Partial<Paper>;
export interface NotificationPreferences { enabled?: boolean; maxPapers?: number; frequency?: string; language?: string; email?: string; lastSentAt?: string | null; lastTestAt?: string | null }
interface EmailHealth { configured?: boolean; available?: boolean; provider?: string; senderMode?: string; permissionLimited?: boolean; code?: string }

import { auth } from './firebase.ts';
import { authenticatedWorkerFetch, trustedWorkerUrl } from './worker-api-client.ts';
import { areaKeyForPaper } from '../utils/area-accent.ts';
import { getLocalizedInstitutionName } from '../utils/institution-localization.ts';
import {
  isOpaqueQueryTopicText,
  MAX_QUERY_TOPIC_CATEGORY_IDS,
  MAX_QUERY_TOPIC_LENGTH,
  MAX_QUERY_TOPIC_SOURCE_LENGTH,
  resolvePaperTopic,
} from '../utils/topic-navigation.ts';

export class EmailNotificationServiceError extends Error {
  declare code: string | undefined;
  declare status: number;
  constructor(code: string|undefined, status = 0) {
    super(code);
    this.name = 'EmailNotificationServiceError';
    this.code = code;
    this.status = status;
  }
}

function apiBase() {
  const value = import.meta.env.VITE_PAPER_API_BASE_URL?.replace(/\/$/, '');
  if (!value) throw new EmailNotificationServiceError('EMAIL_NOT_CONFIGURED');
  return value;
}

function localizedFollowName(follow: Partial<FollowEntity>) {
  if (follow.type === 'institution') {
    return getLocalizedInstitutionName({
      display_name: follow.displayName,
      metadata: follow.metadata,
    }) || follow.displayName;
  }

  if (follow.type === 'topic') {
    const localizedMetadataLabel = follow.metadata?.labelEn;
    const localTopic = resolvePaperTopic(follow.canonicalId)
      || resolvePaperTopic(follow.displayName);
    return localizedMetadataLabel || localTopic?.label || follow.displayName;
  }

  return follow.displayName;
}

function cleanMetadataText(value: unknown, maxLength: number) {
  return String(value || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function notificationFollowMetadata(follow: Partial<FollowEntity>) {
  const rawQuery = cleanMetadataText(follow.metadata?.query, MAX_QUERY_TOPIC_LENGTH);
  const query = rawQuery && !isOpaqueQueryTopicText(rawQuery) ? rawQuery : '';
  const source = cleanMetadataText(follow.metadata?.source, MAX_QUERY_TOPIC_SOURCE_LENGTH);
  const categoryIds = [...new Set((Array.isArray(follow.metadata?.categoryIds)
    ? follow.metadata.categoryIds
    : [])
    .map(categoryId => cleanMetadataText(categoryId, 80))
    .filter(Boolean))].slice(0, MAX_QUERY_TOPIC_CATEGORY_IDS);
  return {
    ...(query ? { query } : {}),
    ...(source ? { source } : {}),
    categoryIds,
  };
}

export function serializeFollowForNotifications(follow: Partial<FollowEntity> = {}) {
  return {
    type: follow.type,
    canonicalId: follow.canonicalId,
    displayName: localizedFollowName(follow),
    externalIds: {
      ...(follow.externalIds?.ror ? { ror: follow.externalIds.ror } : {}),
      ...(follow.externalIds?.orcid ? { orcid: follow.externalIds.orcid } : {}),
    },
    metadata: notificationFollowMetadata(follow),
  };
}

export function serializeUpdateForNotifications(paper: NotificationPaper = {}) {
  // The card's own resolution, so the email inks a paper as the feed does.
  // The abstract stays behind: the Worker fetches its own.
  const area = areaKeyForPaper(paper);
  return {
    ...(area ? { area } : {}),
    id: paper.id,
    doi: paper.doi,
    title: paper.title,
    authors: (paper.authors || []).slice(0, 6).map(author => ({ name: (author as PaperAuthor)?.name || (author as PaperAuthor & { display_name?: string })?.display_name || author })),
    published: paper.published || paper.publishedDate,
    journal: paper.journal,
    citationCount: paper.citationCount,
    openAccess: paper.openAccess,
    landingPageUrl: paper.landingPageUrl,
    pdfUrl: paper.pdfUrl,
    matches: (paper._followedEntityMatches || [])
      .filter(isDigestFollow)
      .slice(0, 4)
      .map(follow => serializeFollowForNotifications(follow as Partial<FollowEntity>)),
  };
}

async function authenticatedRequest<T extends object>(path: string, options: RequestInit = {}) {
  if (!auth.currentUser) throw new EmailNotificationServiceError('EMAIL_AUTH_REQUIRED', 401);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await authenticatedWorkerFetch(`${apiBase()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const payload = await response.json().catch(() => ({})) as T & { code?: string };
    if (!response.ok) throw new EmailNotificationServiceError(payload.code || 'EMAIL_UNAVAILABLE', response.status);
    return payload;
  } catch (error) {
    if (error instanceof EmailNotificationServiceError) throw error;
    throw new EmailNotificationServiceError((error as { name?: string } | null)?.name === 'AbortError' ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getEmailNotificationPreferences() {
  const payload = await authenticatedRequest<{ preferences: Required<NotificationPreferences> }>('/notifications/preferences');
  return payload.preferences;
}

export async function getEmailNotificationHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = trustedWorkerUrl(`${apiBase()}/health/email`);
    if (!url) throw new EmailNotificationServiceError('EMAIL_NOT_CONFIGURED');
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({})) as EmailHealth;
    return {
      configured: Boolean(payload.configured),
      available: Boolean(payload.available),
      provider: payload.provider || null,
      senderMode: payload.senderMode || null,
      permissionLimited: Boolean(payload.permissionLimited),
      code: payload.code || (response.ok ? null : 'EMAIL_PROVIDER_UNAVAILABLE'),
    };
  } catch (error) {
    return {
      configured: false,
      available: false,
      provider: null,
      senderMode: null,
      permissionLimited: false,
      code: (error as { name?: string } | null)?.name === 'AbortError' ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Whether the reader follows anything the weekly digest is built from. A
 * journal is not (D6), so a reader who follows only journals has no digest,
 * and the Worker refuses to subscribe them (EMAIL_FOLLOWS_REQUIRED).
 */
export function hasDigestFollows(follows: readonly Partial<FollowEntity>[]) {
  return follows.some(isDigestFollow);
}

/**
 * The body of a preferences save. The digest is weekly for everyone; the
 * frequency is still sent, always as weekly, because this frontend can be live
 * before the Worker that ignores it, and that Worker's default is daily.
 *
 * `sync` marks the background refresh of follows and previews. The Worker
 * never lets it create or re-enable a subscription or change its settings.
 * The other fields are still sent because a Worker deployed before `sync`
 * ignores the flag and saves them.
 */
export function buildNotificationPreferencesPayload(preferences: NotificationPreferences, follows: Partial<FollowEntity>[] = [], previewItems: NotificationPaper[] = [], { sync = false }: { sync?: boolean } = {}) {
  return {
    ...(sync ? { sync: true } : {}),
    enabled: Boolean(preferences.enabled),
    frequency: 'weekly',
    maxPapers: [3, 5, 10].includes(Number(preferences.maxPapers)) ? Number(preferences.maxPapers) : 5,
    // English only: a preference saved as 'es' before the interface went
    // English-only must not keep the emails in Spanish.
    language: 'en',
    follows: follows.filter(isDigestFollow).slice(0, 40).map(follow => serializeFollowForNotifications(follow)),
    // A paper that matches journals only is not in the digest.
    previewItems: previewItems
      .filter(paper => !paper._followedEntityMatches?.length || paper._followedEntityMatches.some(isDigestFollow))
      .slice(0, 20)
      .map(paper => serializeUpdateForNotifications(paper)),
  };
}

export async function saveEmailNotificationPreferences(preferences: NotificationPreferences, follows: Partial<FollowEntity>[] = [], previewItems: NotificationPaper[] = [], options: { sync?: boolean } = {}) {
  const payload = await authenticatedRequest<{ preferences: Required<NotificationPreferences> }>('/notifications/preferences', {
    method: 'PUT',
    body: JSON.stringify(buildNotificationPreferencesPayload(preferences, follows, previewItems, options)),
  });
  return payload.preferences;
}

export async function sendEmailNotificationTest() {
  return authenticatedRequest<{ ok: boolean; providerId: string | null; paperCount: number; followCount: number; preferences: Required<NotificationPreferences> }>('/notifications/test', { method: 'POST' });
}
