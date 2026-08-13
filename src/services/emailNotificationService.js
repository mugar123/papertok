import { auth } from './firebase.js';
import { authenticatedWorkerFetch, trustedWorkerUrl } from './workerApiClient.js';
import { getLocalizedInstitutionName } from '../utils/institutionLocalization.js';
import {
  isOpaqueQueryTopicText,
  MAX_QUERY_TOPIC_CATEGORY_IDS,
  MAX_QUERY_TOPIC_LENGTH,
  MAX_QUERY_TOPIC_SOURCE_LENGTH,
  resolvePaperTopic,
} from '../utils/topicNavigation.js';

export class EmailNotificationServiceError extends Error {
  constructor(code, status = 0) {
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

function localizedFollowName(follow, language) {
  if (follow.type === 'institution') {
    return getLocalizedInstitutionName({
      display_name: follow.displayName,
      metadata: follow.metadata,
    }, language) || follow.displayName;
  }

  if (follow.type === 'topic') {
    const localizedMetadataLabel = language === 'en'
      ? follow.metadata?.labelEn
      : follow.metadata?.labelEs;
    const localTopic = resolvePaperTopic(follow.canonicalId, language)
      || resolvePaperTopic(follow.displayName, language);
    return localizedMetadataLabel || localTopic?.label || follow.displayName;
  }

  return follow.displayName;
}

function cleanMetadataText(value, maxLength) {
  return String(value || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function notificationFollowMetadata(follow) {
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

export function serializeFollowForNotifications(follow = {}, language = 'es') {
  return {
    type: follow.type,
    canonicalId: follow.canonicalId,
    displayName: localizedFollowName(follow, language),
    externalIds: {
      ...(follow.externalIds?.ror ? { ror: follow.externalIds.ror } : {}),
      ...(follow.externalIds?.orcid ? { orcid: follow.externalIds.orcid } : {}),
    },
    metadata: notificationFollowMetadata(follow),
  };
}

export function serializeUpdateForNotifications(paper = {}, language = 'es') {
  return {
    id: paper.id,
    doi: paper.doi,
    title: paper.title,
    authors: (paper.authors || []).slice(0, 6).map(author => ({ name: author?.name || author?.display_name || author })),
    published: paper.published || paper.publishedDate,
    journal: paper.journal,
    citationCount: paper.citationCount,
    openAccess: paper.openAccess,
    landingPageUrl: paper.landingPageUrl,
    pdfUrl: paper.pdfUrl,
    matches: (paper._followedEntityMatches || [])
      .slice(0, 4)
      .map(follow => serializeFollowForNotifications(follow, language)),
  };
}

async function authenticatedRequest(path, options = {}) {
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new EmailNotificationServiceError(payload.code || 'EMAIL_UNAVAILABLE', response.status);
    return payload;
  } catch (error) {
    if (error instanceof EmailNotificationServiceError) throw error;
    throw new EmailNotificationServiceError(error?.name === 'AbortError' ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE');
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function getEmailNotificationPreferences() {
  const payload = await authenticatedRequest('/notifications/preferences');
  return payload.preferences;
}

export async function getEmailNotificationHealth() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = trustedWorkerUrl(`${apiBase()}/health/email`);
    if (!url) throw new EmailNotificationServiceError('EMAIL_NOT_CONFIGURED');
    const response = await fetch(url, { signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
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
      code: error?.name === 'AbortError' ? 'EMAIL_TIMEOUT' : 'EMAIL_UNAVAILABLE',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function saveEmailNotificationPreferences(preferences, follows = [], previewItems = []) {
  const language = preferences.language === 'en' ? 'en' : 'es';
  const payload = await authenticatedRequest('/notifications/preferences', {
    method: 'PUT',
    body: JSON.stringify({
      enabled: Boolean(preferences.enabled),
      frequency: preferences.frequency === 'weekly' ? 'weekly' : 'daily',
      maxPapers: [3, 5, 10].includes(Number(preferences.maxPapers)) ? Number(preferences.maxPapers) : 5,
      language,
      follows: follows.slice(0, 40).map(follow => serializeFollowForNotifications(follow, language)),
      previewItems: previewItems.slice(0, 20).map(paper => serializeUpdateForNotifications(paper, language)),
    }),
  });
  return payload.preferences;
}

export async function sendEmailNotificationTest() {
  return authenticatedRequest('/notifications/test', { method: 'POST' });
}
