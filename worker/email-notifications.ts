import { captureEmailSendLimit, captureWorkerException } from './error-tracking.ts';
import { accountOwnsEmail } from './firebase-auth.ts';
import type { Paper, PaperFollowMatch, PaperSubject } from '../src/models/paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { Delivery, DeliveryInput, DeliveryDraft, DeliveryDraftInput, DeliveryLedgerPayload, DeliveryLedgerResult, DeliveryLedgerState } from './email-delivery-ledger.ts';

type FollowInput = Partial<Record<keyof PaperFollowMatch | 'id' | 'display_name' | 'name' | 'label', unknown>> & {
  externalIds?: { ror?: unknown; orcid?: unknown };
  metadata?: { query?: unknown; source?: unknown; categoryIds?: unknown[]; [key: string]: unknown };
};
export type Follow = Omit<PaperFollowMatch, 'metadata'> & { metadata?: { query?: string; source?: string; categoryIds?: string[] } };
type PaperInput = Partial<Record<keyof Paper | 'publishedDate' | 'area', unknown>> & {
  authors?: Array<string | { name?: unknown; display_name?: unknown }>;
  _followedEntityMatches?: FollowInput[];
  matches?: FollowInput[];
};
type SourceReportInput = Partial<Omit<SourceReport, 'bySource'>> & { bySource?: Record<string, Partial<SourceCounts>> };
export type DigestPaper = Partial<Omit<NonNullable<ReturnType<typeof sanitizePaper>>, 'matches'>> & { matches?: Partial<Follow>[] };
type IdentityPaper = Pick<PaperInput, 'title' | 'authors' | 'doi' | 'id'>;
type PreferencesInput = Partial<Record<'maxPapers' | 'enabled' | 'frequency' | 'language', unknown>>;
type PreferencesBody = PreferencesInput & { sync?: unknown; follows?: FollowInput[]; previewItems?: PaperInput[] };
type Preferences = ReturnType<typeof sanitizePreferences>;
interface SourceCounts { attempted: number; succeeded: number; failed: number; requestAttempts: number; retried: number }
export interface SourceReport extends SourceCounts {
  requiredFailed: number;
  bySource: Record<string, SourceCounts>;
  failureCodes: Record<string, number>;
}
interface DeliveryState {
  lastCheckedAt?: string; lastSentAt?: string; lastTestAt?: string; sentPaperKeys?: string[];
  lastDelivery?: Partial<ReturnType<typeof lastDeliveryStatus>>;
  lastTestDelivery?: Partial<ReturnType<typeof lastDeliveryStatus>>;
  heldDigest?: { papers: DigestPaper[]; sourceReport: SourceReportInput; selectedAt: string; selectionKey: string } | null;
  owedCurrentWeek?: boolean;
}
export interface Subscription extends Partial<Preferences>, DeliveryState {
  uid?: string; email?: string; displayName?: string; follows?: Follow[]; previewItems?: DigestPaper[];
  unsubscribeToken?: string; stateId?: string; createdAt?: string; updatedAt?: string;
}
interface EmailAccount {
  localId?: string; email?: string; displayName?: unknown; emailVerified?: boolean;
  providerUserInfo?: Array<{ providerId?: unknown; email?: unknown }>;
}
type EmailIdentity = Awaited<ReturnType<typeof verifyFirebaseIdentity>>;
interface ArxivEntry {
  id?: unknown; title?: unknown; summary?: unknown; doi?: unknown; published?: unknown; updated?: unknown; journal_ref?: unknown;
  category?: { '@_term'?: unknown } | Array<{ '@_term'?: unknown }>;
  primary_category?: { '@_term'?: unknown };
  author?: { name?: unknown } | Array<{ name?: unknown }>;
  link?: { '@_rel'?: string; '@_href'?: string } | Array<{ '@_rel'?: string; '@_href'?: string }>;
}
type DigestOpenAlexWork = OpenAlexWork & { keywords?: PaperSubject[]; categories?: string[] };
interface OpenAlexPayload { results: DigestOpenAlexWork[] }
export type OpenAlexRequests = Map<string, Promise<OpenAlexPayload>>;
type OpenAirePid = { '@classname'?: unknown; '$'?: unknown };
type OpenAireResult = { metadata?: { 'oaf:entity'?: { 'oaf:result'?: { pid?: OpenAirePid | OpenAirePid[] } } } };
interface OpenAirePayload { response?: { results?: { result?: OpenAireResult | OpenAireResult[] } } }
interface DeliveryOptions { test?: boolean; now?: number }
interface CollectOptions extends DeliveryOptions { openAlexRequests?: OpenAlexRequests | null }
// `editionAt` is when the papers were selected: a held edition keeps its own week.
interface SendOptions extends DeliveryOptions { key?: string; sourceReport?: SourceReport; editionAt?: number }
interface StatusOptions { kind?: string; paperCount?: number; partial?: boolean; code?: string; sourceReport?: SourceReportInput }
interface ProviderPayload { name?: string; code?: string; message?: string; id?: string; messageId?: string; messageIds?: string[] }
interface DeliveryOutcome {
  sent?: boolean; reconciled?: boolean; uncertain?: boolean; providerId?: string | null;
  pending?: boolean; cancelled?: boolean; invalid?: boolean; delivery?: Delivery;
}
interface ScheduledOutcome {
  sent?: boolean; empty?: boolean; invalid?: boolean; reconciled?: boolean; uncertain?: boolean;
  partial?: boolean; skipped?: boolean; failed?: boolean;
  sources?: ReturnType<typeof compactSourceReport>; failureCodes?: Record<string, number>;
}
interface ScheduleSummary {
  scheduledAt: string; completedAt: string; provider: string | null;
  scanned: number; processed: number; deferred: number; due: number;
  sent: number; empty: number; invalid: number; reconciled: number; uncertain: number;
  partial: number; skipped: number; failed: number; disabled?: boolean;
  sources: ReturnType<typeof compactSourceReport>; failureCodes: Record<string, number>;
}

import type { WorkerEnv } from './env.ts';

import { XMLParser } from 'fast-xml-parser';
import { CATEGORIES } from '../src/data/category-taxonomy.ts';
import { areaKeyForPaper } from '../src/utils/area-accent.ts';
import { usableOpenAlexAbstract } from '../src/utils/open-alex-abstract.ts';
import { filterRelevantQueryTopicPapers } from '../src/utils/query-topic-search.ts';
import { applyEmailDeliveryLedgerAction } from './email-delivery-ledger.ts';
import { readBoundedJson as readBoundedRequestJson } from './bounded-body.ts';

const SUBSCRIPTION_PREFIX = 'notification:subscription:';
const DELIVERY_STATE_PREFIX = 'notification:delivery-state:';
const UNSUBSCRIBE_PREFIX = 'notification:unsubscribe:';
const RESEND_API = 'https://api.resend.com';
const ARXIV_API = 'https://export.arxiv.org/api/query';
// Ruta real desde el 18-09-2026: la app dejo de vivir en el fragmento. Los
// correos ya enviados llevan `/#/following` y siguen llegando a su sitio --
// la puerta de index.html y utils/legacy-hash-route.ts los traducen -- pero
// este Worker se despliega por su cuenta, asi que lo que acuna a partir de
// ahora es la ruta, no el fragmento.
const PAPER_TOK_URL = 'https://papertok.app/following';
// Email updates are switched on and off from the Settings page.
const PAPER_TOK_SETTINGS_URL = 'https://papertok.app/settings/notifications';
const MAX_FOLLOWS = 40;
const MAX_QUERIED_FOLLOWS = 24;
const MAX_PREVIEW_ITEMS = 20;
const MAX_SENT_PAPER_KEYS = 400;
const MAX_PREFERENCES_REQUEST_BYTES = 96 * 1024;
const DEFAULT_DAILY_SEND_LIMIT = 100;
const SCHEDULE_STATUS_KEY = 'notification:schedule:last-run';
const SCHEDULE_HISTORY_PREFIX = 'notification:schedule:history:';
const SCHEDULE_CURSOR_KEY = 'notification:schedule:cursor';
const DELIVERY_LEDGER_PREFIX = 'notification:delivery-ledger:';
const TEST_IDEMPOTENCY_WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_FRESHNESS_DAYS = 10;
// What the lead story's excerpt can draw on; the excerpt itself is shorter.
const DIGEST_ABSTRACT_MAX_LENGTH = 600;

const SCHEDULE_HISTORY_TTL_SECONDS = 14 * 24 * 60 * 60;
const DELIVERY_LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;
const DELIVERY_STATE_TTL_SECONDS = 120 * 24 * 60 * 60;
const DELIVERY_PENDING_RETRY_MIN_AGE_MS = 5 * 60 * 1000;
const DELIVERY_PENDING_RETRY_WINDOW_MS = 25 * 60 * 1000;
const DIGEST_SOURCE_MAX_ATTEMPTS = 2;
const DIGEST_SOURCE_TIMEOUT_MS = 5_000;
const DIGEST_SOURCE_RETRY_MAX_DELAY_MS = 1_000;
const MAX_SHARED_OPENALEX_REQUESTS = 200;
const EMAIL_PROVIDER_TIMEOUT_MS = 12_000;
const EMAIL_IDENTITY_TIMEOUT_MS = 8_000;
const EMAIL_HEALTH_TIMEOUT_MS = 8_000;
const SCHEDULE_PROCESSING_BUDGET_MS = 12 * 60 * 1000;
const SCHEDULE_MIN_BATCH_REMAINING_MS = 3 * 60 * 1000;
const SCHEDULE_PAGE_SIZE = 3;
const EMPTY_RETRY_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FAILURE_RETRY_INTERVAL_MS = 40 * 60 * 1000;
const DIGEST_SOURCES_UNAVAILABLE = 'EMAIL_DIGEST_SOURCES_UNAVAILABLE';
const FUTURE_DATE_TOLERANCE_MS = DAY_MS;
const FOLLOWED_PAPER_MIN_SCORE = 55;
const EXPLORATION_PAPER_MIN_SCORE = 70;
const EXPLORATION_MIN_CITATIONS = 3;
const MAX_ARXIV_DIGEST_CATEGORIES = 24;
const MAX_ARXIV_DIGEST_RESULTS = 40;
const ARXIV_CATEGORY_PREFIXES = [
  'cs', 'math', 'physics', 'eess', 'q-bio', 'q-fin', 'stat', 'econ',
  'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph',
  'hep-th', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph', 'math-ph',
];
const ARXIV_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export class EmailNotificationError extends Error {
  declare code: string;
  declare status: number;
  declare transient?: boolean;
  declare deliveryRejected?: boolean;
  declare sourceReport?: SourceReport;
  constructor(code: string, status = 400, message = code) {
    super(message);
    this.name = 'EmailNotificationError';
    this.code = code;
    this.status = status;
  }
}

export class EmailDigestTransientError extends EmailNotificationError {
  constructor(sourceReport: SourceReport) {
    super(DIGEST_SOURCES_UNAVAILABLE, 503);
    this.name = 'EmailDigestTransientError';
    this.transient = true;
    this.sourceReport = sourceReport;
  }
}

class DigestSourceError extends Error {
  declare source: string | undefined;
  declare code: string;
  declare transient: boolean;
  constructor(source: string | undefined, code: string, message = code) {
    super(message);
    this.name = 'DigestSourceError';
    this.source = source;
    this.code = code;
    this.transient = true;
  }
}

function cleanText(value: unknown, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function readBoundedJson(request: Request, maximumBytes = MAX_PREFERENCES_REQUEST_BYTES) {
  return readBoundedRequestJson<PreferencesBody>(request, maximumBytes, {
    tooLarge: () => new EmailNotificationError('EMAIL_REQUEST_TOO_LARGE', 413),
    invalid: () => new EmailNotificationError('EMAIL_INVALID_REQUEST', 400),
  });
}

// Escapes without trimming. A fragment between two formulas begins or ends
// with the space that separates them, and trimming it glued "Density of" to
// the Ω that followed.
function escapeHtmlCharacters(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeHtml(value: unknown) {
  return escapeHtmlCharacters(cleanText(value, 5_000));
}

const EMAIL_LATEX_DELIMITERS = [
  { left: '$$', right: '$$' },
  { left: '\\[', right: '\\]' },
  { left: '\\(', right: '\\)' },
  { left: '$', right: '$' },
];

const EMAIL_LATEX_SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  pm: '±',
  mp: '∓',
  times: '×',
  cdot: '·',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  approx: '≈',
  sim: '∼',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  sum: '∑',
  prod: '∏',
  int: '∫',
  odot: '⊙',
  ell: 'ℓ',
};

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findEmailLatexDelimiter(text: string, startIndex: number): { index: number; delimiter: typeof EMAIL_LATEX_DELIMITERS[number] } | null {
  let next: { index: number; delimiter: typeof EMAIL_LATEX_DELIMITERS[number] } | null = null;
  EMAIL_LATEX_DELIMITERS.forEach((delimiter) => {
    let index = text.indexOf(delimiter.left, startIndex);
    while (index !== -1 && isEscaped(text, index)) {
      index = text.indexOf(delimiter.left, index + delimiter.left.length);
    }
    if (index !== -1 && (!next || index < next.index || (
      index === next.index && delimiter.left.length > next.delimiter.left.length
    ))) {
      next = { index, delimiter };
    }
  });
  return next;
}

function splitEmailScientificText(value: unknown) {
  const text = cleanText(value, 5_000);
  const chunks = [];
  let cursor = 0;
  while (cursor < text.length) {
    const match = findEmailLatexDelimiter(text, cursor);
    if (!match) {
      chunks.push({ type: 'text', value: text.slice(cursor) });
      break;
    }
    if (match.index > cursor) chunks.push({ type: 'text', value: text.slice(cursor, match.index) });
    const contentStart = match.index + match.delimiter.left.length;
    let contentEnd = text.indexOf(match.delimiter.right, contentStart);
    while (contentEnd !== -1 && isEscaped(text, contentEnd)) {
      contentEnd = text.indexOf(match.delimiter.right, contentEnd + match.delimiter.right.length);
    }
    if (contentEnd === -1) {
      chunks.push({ type: 'text', value: text.slice(match.index) });
      break;
    }
    chunks.push({ type: 'math', value: text.slice(contentStart, contentEnd) });
    cursor = contentEnd + match.delimiter.right.length;
  }
  return chunks;
}

function simplifyEmailLatex(value: unknown) {
  let expression = String(value || '');
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = expression;
    expression = expression
      .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1');
    if (expression === previous) break;
  }
  return expression
    .replace(/\\(?:left|right)\b/g, '')
    .replace(/\\([A-Za-z]+)/g, (match, command) => EMAIL_LATEX_SYMBOLS[command] || command)
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\([{}_%&#])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderEmailMath(value: unknown) {
  const expression = simplifyEmailLatex(value);
  let html = '';
  let plain = '';
  let cursor = 0;

  const appendText = (text: string) => {
    html += escapeHtmlCharacters(text);
    plain += text;
  };

  while (cursor < expression.length) {
    const character = expression[cursor];
    if (character !== '^' && character !== '_') {
      if (character !== '{' && character !== '}') appendText(character);
      cursor += 1;
      continue;
    }

    const tag = character === '^' ? 'sup' : 'sub';
    const marker = character;
    cursor += 1;
    let token;
    if (expression[cursor] === '{') {
      const end = expression.indexOf('}', cursor + 1);
      if (end === -1) {
        appendText(marker);
        continue;
      }
      token = expression.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      const match = expression.slice(cursor).match(/^[^\s+\-*/=(),]+/);
      token = match?.[0] || expression[cursor] || '';
      cursor += token.length || 1;
    }
    html += `<${tag}>${escapeHtmlCharacters(token)}</${tag}>`;
    plain += `${marker}${token}`;
  }

  return { html, plain };
}

function mathSpan(html: string) {
  return `<span style="font-family:Arial,sans-serif;white-space:nowrap">${html}</span>`;
}

// splitEmailScientificText has already collapsed the whitespace, so each
// fragment keeps exactly the spaces that separate it from its formulas.
function renderScientificHtml(value: unknown) {
  return splitEmailScientificText(value).map((chunk) => {
    if (chunk.type === 'text') return escapeHtmlCharacters(chunk.value);
    return mathSpan(renderEmailMath(chunk.value).html);
  }).join('');
}

function renderScientificText(value: unknown) {
  return splitEmailScientificText(value).map(chunk => (
    chunk.type === 'text' ? chunk.value : renderEmailMath(chunk.value).plain
  )).join('');
}

function safeUrl(value: unknown) {
  try {
    const url = new URL(value as string);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeId(value: unknown) {
  return cleanText(value, 300)
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, '')
    .replace(/^https?:\/\/ror\.org\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

function isOpaqueQueryText(value: unknown) {
  return /^query(?:-|$)/i.test(cleanText(value, 300));
}

function isQueryTopicId(value: unknown) {
  return /^query-[a-f0-9]{8}$/i.test(normalizeId(value));
}

function topicSearchQuery(follow: FollowInput = {}) {
  const storedQuery = cleanText(follow.metadata?.query, 180);
  if (storedQuery && !isOpaqueQueryText(storedQuery)) return storedQuery;
  const displayName = cleanText(follow.displayName, 200);
  return displayName && !isOpaqueQueryText(displayName) ? displayName : '';
}

function normalizePaperTitle(value: unknown) {
  return cleanText(value, 500)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePaperAuthor(value: unknown) {
  return cleanText(value, 160)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sanitizeFollow(input: FollowInput = {}) {
  const type = input.type === 'concept' ? 'topic' : cleanText(input.type, 20);
  if (!['author', 'topic', 'institution', 'project'].includes(type)) return null;
  const canonicalId = normalizeId(input.canonicalId || input.id);
  if (isOpaqueQueryText(canonicalId) && !isQueryTopicId(canonicalId)) return null;
  const metadataQuery = cleanText(input.metadata?.query, 180);
  const query = metadataQuery && !isOpaqueQueryText(metadataQuery) ? metadataQuery : '';
  const metadataSource = cleanText(input.metadata?.source, 48);
  let displayName = cleanText(
    input.displayName || input.display_name || input.name || input.label,
    200,
  );
  if (isOpaqueQueryText(displayName)) displayName = query;
  if (!canonicalId || !displayName) return null;
  return {
    type: type as PaperFollowMatch['type'],
    canonicalId,
    displayName,
    externalIds: {
      ...(input.externalIds?.ror ? { ror: normalizeId(input.externalIds.ror) } : {}),
      ...(input.externalIds?.orcid ? { orcid: cleanText(input.externalIds.orcid, 50) } : {}),
    },
    metadata: {
      ...(query ? { query } : {}),
      ...(metadataSource ? { source: metadataSource } : {}),
      categoryIds: Array.isArray(input.metadata?.categoryIds)
        ? [...new Set(input.metadata.categoryIds
          .map(categoryId => cleanText(normalizeId(categoryId), 80))
          .filter(Boolean))].slice(0, 12)
        : [],
    },
  };
}

function normalizePaperDoi(value: unknown) {
  return cleanText(value, 300).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}

function paperWorkKey(paper: IdentityPaper = {}) {
  const title = normalizePaperTitle(paper.title);
  const firstAuthor = normalizePaperAuthor((paper.authors?.[0] as { name?: unknown } | undefined)?.name || paper.authors?.[0]);
  return title && firstAuthor ? `work:${title}|${firstAuthor}` : '';
}

function paperIdentityKeys(paper: IdentityPaper = {}) {
  const doi = normalizePaperDoi(paper.doi);
  const id = cleanText(paper.id, 300).toLowerCase();
  return [...new Set([
    doi ? `doi:${doi}` : '',
    paperWorkKey(paper),
    id ? `id:${id}` : '',
  ].filter(Boolean))];
}

function paperKey(paper: IdentityPaper = {}) {
  const identities = paperIdentityKeys(paper);
  return identities[0] || `title:${normalizePaperTitle(paper.title)}`;
}

function sanitizePaper(input: PaperInput = {}) {
  const title = cleanText(input.title, 500);
  if (!title) return null;
  const authors = Array.isArray(input.authors)
    ? input.authors.map(author => cleanText((author as { name?: unknown })?.name || (author as { display_name?: unknown })?.display_name || author, 120)).filter(Boolean).slice(0, 6)
    : [];
  const matches = Array.isArray(input._followedEntityMatches || input.matches)
    ? ((input._followedEntityMatches || input.matches)!.map(sanitizeFollow).filter(Boolean) as Follow[]).slice(0, 4)
    : [];
  const area = cleanText(input.area, 20);
  const abstract = cleanText(input.abstract, DIGEST_ABSTRACT_MAX_LENGTH);
  return {
    id: cleanText(input.id, 300),
    doi: cleanText(input.doi, 300),
    title,
    authors,
    published: cleanText(input.published || input.publishedDate || (input.year ? `${input.year}-01-01` : ''), 40),
    journal: cleanText(input.journal, 200),
    citationCount: Math.max(0, Number(input.citationCount) || 0),
    openAccess: Boolean(input.openAccess),
    url: safeUrl(input.landingPageUrl || input.pdfUrl || (input.doi ? `https://doi.org/${input.doi}` : '')),
    matches,
    // A field or abstract with no evidence stays absent.
    ...(Object.hasOwn(CATEGORIES, area) ? { area } : {}),
    ...(abstract ? { abstract } : {}),
  };
}

/**
 * The digest is weekly for everyone. Daily was a choice until 2026-10; the
 * field stays, always `weekly`, so a client deployed before the choice was
 * retired still reads a value it knows, and whatever it asks for is stored as
 * weekly.
 */
const DIGEST_FREQUENCY = 'weekly';

function sanitizePreferences(input: PreferencesInput = {}) {
  const requestedMax = Number(input.maxPapers);
  const maxPapers = [3, 5, 10].includes(requestedMax) ? requestedMax : 5;
  return {
    enabled: Boolean(input.enabled),
    frequency: DIGEST_FREQUENCY,
    maxPapers,
    // English-only product: any incoming language (including a legacy 'es') is stored as 'en'.
    language: 'en',
  };
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function createSourceReport(): SourceReport {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    requestAttempts: 0,
    retried: 0,
    requiredFailed: 0,
    bySource: {},
    failureCodes: {},
  };
}

function sourceCodeName(source: string | undefined) {
  return cleanText(source, 40).toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'UNKNOWN';
}

function sourceBucket(report: SourceReport | null | undefined, source: string) {
  if (!report) return null;
  // `attempted`, `succeeded` and `failed` count the questions a digest asked;
  // `requestAttempts` and `retried` count the HTTP calls actually made, which
  // is fewer when a schedule run shares an answer between readers.
  report.bySource[source] ||= { attempted: 0, succeeded: 0, failed: 0, requestAttempts: 0, retried: 0 };
  return report.bySource[source];
}

function recordSourceFailure(report: SourceReport | null | undefined, source: string, code: string) {
  if (!report) return;
  report.failed += 1;
  sourceBucket(report, source)!.failed += 1;
  report.failureCodes[code] = (report.failureCodes[code] || 0) + 1;
}

function digestSourceError(source: string, error: unknown) {
  if (error instanceof DigestSourceError) return error;
  return new DigestSourceError(
    source,
    `EMAIL_SOURCE_${sourceCodeName(source)}_INVALID_RESPONSE`,
    (error as EmailNotificationError)?.message,
  );
}

function retryDelayMs(response: Response | undefined, attempt: number) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const requestedDelay = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requestedDelay) && requestedDelay > 0) {
      return Math.min(requestedDelay, DIGEST_SOURCE_RETRY_MAX_DELAY_MS);
    }
  }
  return Math.min(150 * (2 ** attempt), DIGEST_SOURCE_RETRY_MAX_DELAY_MS);
}

function wait(delayMs: number) {
  return new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

async function fetchDigestSource(input: RequestInfo | URL, init: RequestInit | undefined, {
  source,
  report,
  timeoutMs = DIGEST_SOURCE_TIMEOUT_MS,
}: { source?: string; report?: SourceReport | null; timeoutMs?: number } = {}) {
  let lastError;
  for (let attempt = 0; attempt < DIGEST_SOURCE_MAX_ATTEMPTS; attempt += 1) {
    if (report) {
      const bucket = sourceBucket(report, source!)!;
      report.requestAttempts += 1;
      bucket.requestAttempts += 1;
      if (attempt > 0) {
        report.retried += 1;
        bucket.retried += 1;
      }
    }
    let response;
    try {
      // A fresh deadline per attempt, and one that outlives this `await`: the
      // response is handed back unread, so the body -- which is the part that
      // actually stalls -- is only covered because `AbortSignal.timeout` has no
      // timer for a `finally` to clear.
      response = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      // `AbortSignal.timeout` raises `TimeoutError`, not `AbortError`. Reading
      // only the latter would recode every real deadline as `_UNAVAILABLE` and
      // lose the distinction the digest report publishes; `AbortError` stays
      // because a runtime that cuts the request is a deadline all the same.
      const timedOut = (error as EmailNotificationError)?.name === 'TimeoutError' || (error as EmailNotificationError)?.name === 'AbortError';
      lastError = new DigestSourceError(
        source,
        `EMAIL_SOURCE_${sourceCodeName(source)}_${timedOut ? 'TIMEOUT' : 'UNAVAILABLE'}`,
        (error as EmailNotificationError)?.message,
      );
    }

    if (response?.ok) return response;
    if (response) {
      const suffix = response.status === 429
        ? 'RATE_LIMITED'
        : response.status >= 500
          ? 'UNAVAILABLE'
          : 'REJECTED';
      lastError = new DigestSourceError(
        source,
        `EMAIL_SOURCE_${sourceCodeName(source)}_${suffix}`,
        `${source} digest error: ${response.status}`,
      );
      if (response.status !== 429 && response.status < 500) throw lastError;
    }
    if (attempt + 1 < DIGEST_SOURCE_MAX_ATTEMPTS) {
      await wait(retryDelayMs(response, attempt));
    }
  }
  throw lastError || new DigestSourceError(
    source,
    `EMAIL_SOURCE_${sourceCodeName(source)}_UNAVAILABLE`,
  );
}

async function trackDigestSource<T>(report: SourceReport | null | undefined, source: string, operation: () => Promise<T>) {
  if (report) {
    report.attempted += 1;
    sourceBucket(report, source)!.attempted += 1;
  }
  try {
    const result = await operation();
    if (report) {
      report.succeeded += 1;
      sourceBucket(report, source)!.succeeded += 1;
    }
    return result;
  } catch (error) {
    const sourceError = digestSourceError(source, error);
    recordSourceFailure(report, source, sourceError.code);
    throw sourceError;
  }
}

function isArxivCategory(value: unknown) {
  const category = cleanText(value, 80);
  if (!/^[a-z-]+(?:\.[A-Za-z-]+)?$/.test(category)) return false;
  return ARXIV_CATEGORY_PREFIXES.some(prefix => (
    category === prefix || category.startsWith(`${prefix}.`)
  ));
}

// A followed area reads its leaves from the taxonomy, not from the ids the
// follow stored when the area held other leaves.
function arxivCategoriesForFollow(follow: FollowInput = {}) {
  const area = typeof follow.canonicalId === 'string' && Object.hasOwn(CATEGORIES, follow.canonicalId)
    ? CATEGORIES[follow.canonicalId]
    : null;
  const metadataCategories = Array.isArray(follow.metadata?.categoryIds)
    ? follow.metadata.categoryIds
    : [];
  const candidates = area ? Object.keys(area.subcategories) : metadataCategories.length ? metadataCategories : [follow.canonicalId];
  return [...new Set(candidates.map(category => cleanText(category, 80)).filter(isArxivCategory))];
}

function parseArxivDigestFeed(xml: unknown, follows: Follow[] = []) {
  const parsed: { feed?: { entry?: ArxivEntry | ArxivEntry[] } } = ARXIV_XML_PARSER.parse(String(xml || ''));
  const entries = asArray(parsed?.feed?.entry);
  const followsByCategory = new Map<string, Follow[]>();

  follows.forEach((follow) => {
    arxivCategoriesForFollow(follow).forEach((category) => {
      const matches = followsByCategory.get(category) || [];
      matches.push(follow);
      followsByCategory.set(category, matches);
    });
  });

  return entries.map((entry) => {
    const arxivId = cleanText(entry?.id, 300)
      .replace(/^https?:\/\/arxiv\.org\/abs\//i, '')
      .replace(/v\d+$/i, '');
    if (!arxivId) return null;

    const categories = asArray(entry?.category)
      .map(category => cleanText(category?.['@_term'], 80))
      .filter(Boolean);
    const matches = [...new Set(categories.flatMap(category => followsByCategory.get(category) || []))];
    if (!matches.length) return null;

    const authors = asArray(entry?.author)
      .map(author => cleanText(author?.name, 120))
      .filter(Boolean);
    const links = asArray(entry?.link);
    const landingPageUrl = safeUrl(
      links.find(link => link?.['@_rel'] === 'alternate')?.['@_href']
      || `https://arxiv.org/abs/${arxivId}`,
    );

    return sanitizePaper({
      id: arxivId,
      doi: cleanText(entry?.doi, 300),
      title: cleanText(entry?.title, 500),
      authors,
      published: cleanText(entry?.published || entry?.updated, 40),
      journal: cleanText(entry?.journal_ref, 200) || 'arXiv',
      citationCount: 0,
      openAccess: true,
      landingPageUrl,
      matches,
      // The primary category, ahead of whichever cross-list is listed first.
      area: areaKeyForPaper({
        primaryCategory: cleanText(entry?.primary_category?.['@_term'], 80),
        categories,
      }),
      abstract: cleanText(entry?.summary, DIGEST_ABSTRACT_MAX_LENGTH),
    });
  }).filter(Boolean);
}

async function fetchArxivTopicUpdates(follows: Follow[], sourceReport?: SourceReport | null) {
  const categories = [...new Set(
    follows.flatMap(arxivCategoriesForFollow),
  )].slice(0, MAX_ARXIV_DIGEST_CATEGORIES);
  if (!categories.length) return [];

  const url = new URL(ARXIV_API);
  url.searchParams.set('search_query', categories.map(category => `cat:${category}`).join(' OR '));
  url.searchParams.set('start', '0');
  url.searchParams.set('max_results', String(MAX_ARXIV_DIGEST_RESULTS));
  url.searchParams.set('sortBy', 'submittedDate');
  url.searchParams.set('sortOrder', 'descending');

  return trackDigestSource(sourceReport, 'arxiv', async () => {
    const response = await fetchDigestSource(url, {
      headers: {
        accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
        'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      },
    }, {
      source: 'arxiv',
      report: sourceReport,
      timeoutMs: 8_000,
    });
    return parseArxivDigestFeed(await response.text(), follows);
  });
}

async function verifyFirebaseIdentity(request: Request, env: WorkerEnv) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new EmailNotificationError('EMAIL_AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);

  const response = await fetchWithDeadline(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  }, EMAIL_IDENTITY_TIMEOUT_MS);
  const payload = await response.json<{ users?: EmailAccount[] }>().catch((): { users?: EmailAccount[] } => ({}));
  const account = payload?.users?.[0];
  if (!response.ok || !account?.localId || !account?.email) {
    throw new EmailNotificationError('EMAIL_AUTH_REQUIRED', 401);
  }
  if (!accountOwnsEmail(account)) {
    throw new EmailNotificationError('EMAIL_ADDRESS_NOT_VERIFIED', 403);
  }
  return {
    uid: account.localId,
    email: cleanText(account.email, 320),
    displayName: cleanText(account.displayName, 160),
  };
}

function publicSubscription(subscription: Subscription | null, email: string) {
  return {
    enabled: Boolean(subscription?.enabled),
    frequency: DIGEST_FREQUENCY,
    maxPapers: subscription?.maxPapers || 5,
    language: subscriptionLanguage(subscription),
    email,
    lastSentAt: subscription?.lastSentAt || null,
    lastTestAt: subscription?.lastTestAt || null,
  };
}

const DELIVERY_STATE_FIELDS: Array<keyof DeliveryState> = [
  'lastCheckedAt',
  'lastSentAt',
  'lastTestAt',
  'sentPaperKeys',
  'lastDelivery',
  'lastTestDelivery',
  'heldDigest',
  'owedCurrentWeek',
];

function deliveryStateKey(subscriptionKey: string, subscription: Subscription | null) {
  const uid = String(subscriptionKey || '').startsWith(SUBSCRIPTION_PREFIX)
    ? String(subscriptionKey).slice(SUBSCRIPTION_PREFIX.length)
    : String(subscriptionKey || '');
  const stateId = cleanText(subscription?.stateId, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  return stateId
    ? `${DELIVERY_STATE_PREFIX}${uid}:${stateId}`
    : `${DELIVERY_STATE_PREFIX}${uid}`;
}

function deliveryStateFromSubscription(subscription: Subscription = {}): DeliveryState {
  return Object.fromEntries(DELIVERY_STATE_FIELDS
    .filter(field => subscription?.[field] !== undefined)
    .map(field => [field, subscription[field]]));
}

function stripDeliveryState(subscription: Subscription = {}) {
  const clean = { ...subscription };
  DELIVERY_STATE_FIELDS.forEach(field => { delete clean[field]; });
  return clean;
}

function subscriptionGeneration(subscription: Subscription = {}) {
  const stateId = cleanText(subscription.stateId, 80);
  if (stateId) return `state:${stateId}`;
  return `legacy:${cleanText(
    subscription.unsubscribeToken || subscription.createdAt || subscription.uid,
    200,
  )}`;
}

function heldDigestSelectionKey(subscription: Subscription = {}) {
  const follows = (subscription.follows || []).map(follow => JSON.stringify([
    follow.type,
    follow.canonicalId,
    follow.externalIds?.ror || '',
    follow.metadata?.query || '',
    [...new Set(follow.metadata?.categoryIds || [])].sort(),
  ])).sort();
  return JSON.stringify([subscription.email || '', subscription.maxPapers || 5, follows]);
}

async function loadSubscriptionRecord(env: WorkerEnv, key: string) {
  const subscription = await env.NOTIFICATION_STORE!.get<Subscription>(key, 'json');
  if (!subscription) return null;
  const stateKey = deliveryStateKey(key, subscription);
  const state = await env.NOTIFICATION_STORE!.get<DeliveryState>(stateKey, 'json');
  return { subscription, state, stateKey };
}

async function loadSubscriptionWithState(env: WorkerEnv, key: string) {
  const record = await loadSubscriptionRecord(env, key);
  if (!record) return null;
  return {
    ...record.subscription,
    ...deliveryStateFromSubscription(record.subscription),
    ...(record.state || {}),
  };
}

async function updateDeliveryState(env: WorkerEnv, key: string, expectedSubscription: Subscription | null, buildPatch: (state: DeliveryState, subscription: Subscription) => DeliveryState) {
  const subscription = await env.NOTIFICATION_STORE!.get<Subscription>(key, 'json');
  if (!subscription) return null;
  if (
    expectedSubscription
    && subscriptionGeneration(subscription) !== subscriptionGeneration(expectedSubscription)
  ) {
    return null;
  }
  const stateKey = deliveryStateKey(key, subscription);
  const storedState = await env.NOTIFICATION_STORE!.get<DeliveryState>(stateKey, 'json');
  const currentState = {
    ...deliveryStateFromSubscription(subscription),
    ...(storedState || {}),
  };
  const mergedState = { ...currentState, ...buildPatch(currentState, subscription) };
  await env.NOTIFICATION_STORE!.put(stateKey, JSON.stringify(mergedState), {
    expirationTtl: DELIVERY_STATE_TTL_SECONDS,
  });
  return { ...subscription, ...mergedState };
}

async function deleteSubscription(env: WorkerEnv, uid: string, subscription: Subscription | null) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  await Promise.all([
    env.NOTIFICATION_STORE.delete(`${SUBSCRIPTION_PREFIX}${uid}`),
    env.NOTIFICATION_STORE.delete(deliveryStateKey(uid, subscription)),
    subscription?.unsubscribeToken
      ? env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${subscription.unsubscribeToken}`)
      : Promise.resolve(),
  ]);
}

/**
 * Account deletion: drop the newsletter records even when the account never
 * subscribed. Missing KV is not a failure here — there is nothing to erase.
 */
export async function purgeEmailSubscription(env: WorkerEnv, uid: string) {
  if (!env?.NOTIFICATION_STORE || !uid) return { purged: false };
  const key = `${SUBSCRIPTION_PREFIX}${uid}`;
  const subscription = await env.NOTIFICATION_STORE.get<Subscription>(key, 'json');
  await Promise.all([
    env.NOTIFICATION_STORE.delete(key),
    env.NOTIFICATION_STORE.delete(deliveryStateKey(uid, subscription || { uid })),
    subscription?.unsubscribeToken
      ? env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${subscription.unsubscribeToken}`)
      : Promise.resolve(),
  ]);
  return { purged: true };
}

async function saveSubscription(request: Request, env: WorkerEnv, identity: EmailIdentity) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const body = await readBoundedJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new EmailNotificationError('EMAIL_INVALID_REQUEST', 400);
  }
  const preferences = sanitizePreferences(body);
  // `sync` marks the app's background refresh of follows and previews. The tab
  // that sends it may have loaded before the reader unsubscribed or changed the
  // digest elsewhere, so a sync never creates or re-enables a subscription and
  // keeps the stored settings.
  const sync = body.sync === true;
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const existingRecord = await loadSubscriptionRecord(env, key);
  const existingRaw = existingRecord?.subscription || null;
  const existing = existingRaw ? {
    ...existingRaw,
    ...deliveryStateFromSubscription(existingRaw),
    ...(existingRecord!.state || {}),
  } : null;

  if (sync) {
    if (!existing?.enabled) return publicSubscription(existing, identity.email);
  } else if (!preferences.enabled) {
    await deleteSubscription(env, identity.uid, existing);
    return publicSubscription(null, identity.email);
  }

  const follows = Array.isArray(body.follows)
    ? (body.follows.map(sanitizeFollow).filter(Boolean) as Follow[]).slice(0, MAX_FOLLOWS)
    : [];
  const previewItems = Array.isArray(body.previewItems)
    ? (body.previewItems.map(sanitizePaper).filter(Boolean) as DigestPaper[]).slice(0, MAX_PREVIEW_ITEMS)
    : [];
  if (!follows.length) {
    throw new EmailNotificationError('EMAIL_FOLLOWS_REQUIRED', 409);
  }
  const unsubscribeToken = existing?.unsubscribeToken || crypto.randomUUID().replace(/-/g, '');
  const unsubscribeKey = `${UNSUBSCRIBE_PREFIX}${unsubscribeToken}`;
  const selectionChanged = Boolean(existing?.heldDigest) && heldDigestSelectionKey(existing!) !== heldDigestSelectionKey({
    ...existingRaw,
    ...(sync ? {} : preferences),
    email: identity.email,
    follows,
  });
  // A subscriber's app syncs on every open, usually with nothing new, and each
  // write costs two KV puts. The token index is still checked: a save whose
  // index put failed leaves an enabled subscription whose unsubscribe link
  // answers 400, and this sync may be the only retry that save gets.
  if (
    sync
    && existingRaw?.unsubscribeToken
    && existingRaw.email === identity.email
    && existingRaw.displayName === identity.displayName
    && JSON.stringify(existingRaw.follows) === JSON.stringify(follows)
    && JSON.stringify(existingRaw.previewItems) === JSON.stringify(previewItems)
    && !selectionChanged
  ) {
    if (await env.NOTIFICATION_STORE.get(unsubscribeKey) !== identity.uid) {
      await env.NOTIFICATION_STORE.put(unsubscribeKey, identity.uid);
    }
    return publicSubscription(existing, identity.email);
  }
  const now = new Date().toISOString();
  const persistedBase = existingRecord?.state
    ? stripDeliveryState(existingRaw!)
    : (existingRaw || {});
  const subscription = {
    ...persistedBase,
    ...(sync ? {} : preferences),
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName,
    follows,
    previewItems,
    unsubscribeToken,
    ...(!existingRaw ? { stateId: crypto.randomUUID().replace(/-/g, '') } : {}),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await Promise.all([
    env.NOTIFICATION_STORE.put(key, JSON.stringify(subscription)),
    env.NOTIFICATION_STORE.put(unsubscribeKey, identity.uid),
  ]);
  if (selectionChanged) {
    await updateDeliveryState(env, key, subscription, () => ({ heldDigest: null }));
  }
  return publicSubscription({ ...subscription, ...(existingRecord?.state || {}) }, identity.email);
}

function addOpenAlexCredentials(url: URL, env: WorkerEnv) {
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url;
}

function mapOpenAlexPaper(work: DigestOpenAlexWork, follow: Follow | null) {
  const doi = cleanText(work?.doi, 300).replace(/^https?:\/\/doi\.org\//i, '');
  return sanitizePaper({
    id: normalizeId(work?.id) || doi,
    doi,
    title: work?.display_name || work?.title,
    authors: (work?.authorships || []).map(authorship => authorship?.author?.display_name).filter(Boolean) as string[],
    published: work?.publication_date,
    journal: work?.primary_location?.source?.display_name,
    citationCount: work?.cited_by_count,
    openAccess: work?.open_access?.is_oa,
    landingPageUrl: work?.best_oa_location?.landing_page_url || work?.primary_location?.landing_page_url,
    // The card's own resolution: the subfield or field OpenAlex filed it under.
    area: areaKeyForPaper({ primaryTopic: work?.primary_topic }),
    abstract: usableOpenAlexAbstract(work),
    _followedEntityMatches: follow ? [follow] : [],
  });
}

function reconstructOpenAlexAbstract(index: Record<string, number[]> | null = {}) {
  const words: string[] = [];
  Object.entries(index || {}).forEach(([word, positions]) => {
    (positions || []).forEach(position => { words[position] = word; });
  });
  return words.filter(Boolean).join(' ');
}

function openAlexWorkForTopicRelevance(work: DigestOpenAlexWork = {}) {
  return {
    title: work.display_name || work.title,
    abstract: reconstructOpenAlexAbstract(work.abstract_inverted_index),
    concepts: work.concepts || [],
    topics: work.topics || [],
    primaryTopic: work.primary_topic || null,
    keywords: work.keywords || [],
    categories: work.categories || [],
  };
}

function openAlexRequestKey(url: string | URL) {
  const key = new URL(url);
  key.searchParams.delete('api_key');
  return key.toString();
}

// A digest's OpenAlex request is a public question -- a followed entity or a
// search string, plus the run date -- so readers who follow the same thing in
// one schedule run can share one answer. What is shared is the parsed response,
// before any reader-specific filter or mapping, so no digest changes. A failed
// request is dropped from the map: a later reader asks again, with the same
// retries it would have had on its own. Without a map (the test email), every
// call goes upstream as before. Answers stay whole and in memory for the rest
// of the run, so the map is capped; once full, a new question is asked unshared
// rather than pushing out an answer a later reader may still need.
function fetchOpenAlexDigestPayload(
  url: URL,
  sourceReport: SourceReport | null | undefined,
  openAlexRequests: OpenAlexRequests | null,
  limit = MAX_SHARED_OPENALEX_REQUESTS,
) {
  const request = async () => {
    const response = await fetchDigestSource(url, { headers: { accept: 'application/json' } }, {
      source: 'openalex',
      report: sourceReport,
    });
    const payload = await response.json<OpenAlexPayload>();
    if (!Array.isArray(payload?.results)) {
      throw new DigestSourceError('openalex', 'EMAIL_SOURCE_OPENALEX_INVALID_RESPONSE');
    }
    return payload;
  };
  if (!openAlexRequests) return request();
  const key = openAlexRequestKey(url);
  const pending = openAlexRequests.get(key);
  if (pending) return pending;
  if (openAlexRequests.size >= limit) return request();
  const shared = request();
  openAlexRequests.set(key, shared);
  shared.catch(() => {
    if (openAlexRequests.get(key) === shared) openAlexRequests.delete(key);
  });
  return shared;
}

async function fetchOpenAlexUpdates(follow: Follow, env: WorkerEnv, now = Date.now(), sourceReport?: SourceReport | null, openAlexRequests: OpenAlexRequests | null = null) {
  const id = normalizeId(follow.canonicalId);
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  const cutoff = new Date(now - DIGEST_FRESHNESS_DAYS * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  let filter = `from_publication_date:${cutoff},to_publication_date:${today}`;

  if (follow.type === 'author' && /^A\d+$/i.test(id)) filter += `,author.id:${id}`;
  else if (follow.type === 'institution') {
    const institutionId = normalizeId(follow.externalIds?.ror || id);
    filter += /^I\d+$/i.test(institutionId)
      ? `,institutions.id:${institutionId}`
      : `,institutions.ror:https://ror.org/${institutionId}`;
  } else if (follow.type === 'topic' && /^T\d+$/i.test(id)) filter += `,topics.id:${id}`;
  else if (follow.type === 'topic' && /^C\d+$/i.test(id)) filter += `,concepts.id:${id}`;
  else {
    const searchQuery = follow.type === 'topic' ? topicSearchQuery(follow) : cleanText(follow.displayName, 200);
    if (!searchQuery) return [];
    url.searchParams.set('search', searchQuery);
  }

  url.searchParams.set('filter', filter);
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('per-page', '6');
  return trackDigestSource(sourceReport, 'openalex', async () => {
    const payload = await fetchOpenAlexDigestPayload(url, sourceReport, openAlexRequests);
    let works = payload?.results || [];
    if (follow.type === 'topic' && isQueryTopicId(id)) {
      const query = topicSearchQuery(follow);
      works = works.filter(work => filterRelevantQueryTopicPapers(
        [openAlexWorkForTopicRelevance(work)],
        { query, categoryIds: follow.metadata?.categoryIds || [] },
      ).length > 0);
    }
    return works.map(work => mapOpenAlexPaper(work, follow)).filter(Boolean);
  });
}

async function fetchExplorationUpdates(env: WorkerEnv, now = Date.now(), sourceReport?: SourceReport | null, openAlexRequests: OpenAlexRequests | null = null) {
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  const cutoff = new Date(now - 4 * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  url.searchParams.set(
    'filter',
    `from_publication_date:${cutoff},to_publication_date:${today},is_retracted:false`,
  );
  url.searchParams.set('sort', 'cited_by_count:desc');
  url.searchParams.set('per-page', '8');
  return trackDigestSource(sourceReport, 'openalex', async () => {
    const payload = await fetchOpenAlexDigestPayload(url, sourceReport, openAlexRequests);
    return (payload?.results || []).map(work => mapOpenAlexPaper(work, null)).filter(Boolean);
  });
}

async function fetchProjectUpdates(follow: Follow, env: WorkerEnv, sourceReport?: SourceReport | null, openAlexRequests: OpenAlexRequests | null = null) {
  const requestUrl = new URL('https://api.openaire.eu/search/publications');
  requestUrl.searchParams.set('format', 'json');
  requestUrl.searchParams.set('size', '10');
  requestUrl.searchParams.set('page', '1');
  requestUrl.searchParams.set(follow.canonicalId.includes('::') ? 'openaireProjectID' : 'projectID', follow.canonicalId);
  const payload = await trackDigestSource(sourceReport, 'openaire', async () => {
    const response = await fetchDigestSource(requestUrl, { headers: { accept: 'application/json' } }, {
      source: 'openaire',
      report: sourceReport,
    });
    return response.json<OpenAirePayload>();
  });
  let rows = payload?.response?.results?.result || [];
  if (!Array.isArray(rows)) rows = [rows];
  const dois = rows.flatMap((row) => {
    let pids = row?.metadata?.['oaf:entity']?.['oaf:result']?.pid || [];
    if (!Array.isArray(pids)) pids = [pids];
    return pids
      .filter(pid => ['doi', 'digital object identifier'].includes(cleanText(pid?.['@classname'], 60).toLowerCase()))
      .map(pid => cleanText(pid?.['$'], 300))
      .filter(Boolean);
  }).slice(0, 10);
  if (!dois.length) return [];

  const openAlexUrl = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  openAlexUrl.searchParams.set('filter', `doi:${dois.map(doi => doi.replace(/^https?:\/\/doi\.org\//i, '')).join('|')}`);
  openAlexUrl.searchParams.set('per-page', '10');
  return trackDigestSource(sourceReport, 'openalex', async () => {
    const openAlexPayload = await fetchOpenAlexDigestPayload(openAlexUrl, sourceReport, openAlexRequests);
    return (openAlexPayload?.results || []).map(work => mapOpenAlexPaper(work, follow)).filter(Boolean);
  });
}

async function mapWithConcurrency<T, Result>(items: T[], concurrency: number, mapper: (item: T) => Promise<Result>) {
  const output = new Array<PromiseSettledResult<Result>>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        output[index] = { status: 'fulfilled', value: await mapper(items[index]) };
      } catch (error) {
        output[index] = { status: 'rejected', reason: error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function publicationTime(paper: DigestPaper) {
  const value = Date.parse(paper.published || '');
  return Number.isFinite(value) ? value : 0;
}

function mergePaperRecords(current: DigestPaper, paper: DigestPaper) {
  const matches = [...(current.matches || []), ...(paper.matches || [])];
  const area = current.area || paper.area;
  const abstract = (current.abstract?.length || 0) >= (paper.abstract?.length || 0)
    ? current.abstract
    : paper.abstract;
  return {
    ...current,
    ...paper,
    id: current.id || paper.id,
    doi: current.doi || paper.doi,
    title: (current.title?.length as number) >= (paper.title?.length || 0) ? current.title : paper.title,
    authors: (current.authors?.length as number) >= (paper.authors?.length || 0) ? current.authors : paper.authors,
    published: current.published || paper.published,
    journal: current.journal || paper.journal,
    url: current.url || paper.url,
    openAccess: Boolean(current.openAccess || paper.openAccess),
    citationCount: Math.max(current.citationCount || 0, paper.citationCount || 0),
    matches: matches.filter((match, index) => matches.findIndex(candidate => (
      candidate.type === match.type && candidate.canonicalId === match.canonicalId
    )) === index),
    ...(area ? { area } : {}),
    ...(abstract ? { abstract } : {}),
  };
}

function mergePapers(papers: Array<DigestPaper | null>) {
  const mergedByIdentity = new Map<string, DigestPaper>();
  (papers.filter(Boolean) as DigestPaper[]).forEach((paper) => {
    const identityKeys = paperIdentityKeys(paper);
    const existingRecords = [...new Set(identityKeys
      .map(key => mergedByIdentity.get(key))
      .filter(Boolean) as DigestPaper[])];
    if (!existingRecords.length) {
      identityKeys.forEach(key => mergedByIdentity.set(key, paper));
      return;
    }

    const next = existingRecords.reduce(
      (mergedPaper, current) => mergePaperRecords(current, mergedPaper),
      paper,
    );
    const existingSet = new Set(existingRecords);
    mergedByIdentity.forEach((value, key) => {
      if (existingSet.has(value)) mergedByIdentity.set(key, next);
    });
    identityKeys.forEach(key => mergedByIdentity.set(key, next));
  });
  return [...new Set(mergedByIdentity.values())]
    .sort((a, b) => publicationTime(b) - publicationTime(a));
}

function digestPaperScore(paper: DigestPaper, now = Date.now()) {
  const publishedAt = publicationTime(paper);
  if (
    !publishedAt
    || publishedAt > now + FUTURE_DATE_TOLERANCE_MS
    || !paper.authors?.length
    || !paper.url
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  const ageDays = Math.max(0, (now - publishedAt) / DAY_MS);
  const recencyScore = 48 * Math.exp(-ageDays / 10);
  const citationScore = Math.min(22, Math.log1p(Math.max(0, paper.citationCount || 0)) * 6);
  const matchCount = new Set((paper.matches || []).map(match => (
    `${match.type}:${match.canonicalId}`
  ))).size;
  const followingScore = matchCount ? Math.min(48, 32 + (matchCount - 1) * 8) : 0;
  const metadataScore = (paper.journal ? 4 : 0) + (paper.openAccess ? 2 : 0) + 6;
  return recencyScore + citationScore + followingScore + metadataScore;
}

function getPaperFollowKeys(paper: Partial<DigestPaper> = {}) {
  return [...new Set((paper.matches || []).map(match => (
    `${match.type}:${match.canonicalId}`
  )))];
}

function sharesFollow(left: DigestPaper, right?: DigestPaper) {
  const rightKeys = new Set(getPaperFollowKeys(right));
  return getPaperFollowKeys(left).some(key => rightKeys.has(key));
}

function blockedFollowKeys(selected: DigestPaper[]) {
  if (selected.length < 2) return new Set();
  const previous = new Set(getPaperFollowKeys(selected.at(-1)));
  const beforePrevious = new Set(getPaperFollowKeys(selected.at(-2)));
  return new Set([...previous].filter(key => beforePrevious.has(key)));
}

function selectDigestPapers(papers: Array<DigestPaper | null>, {
  limit = 5,
  now = Date.now(),
  exploration = false,
  excludedKeys = [],
}: { limit?: number; now?: number; exploration?: boolean; excludedKeys?: string[] | Set<string> } = {}) {
  const excluded = excludedKeys instanceof Set ? excludedKeys : new Set(excludedKeys);
  const minimumScore = exploration ? EXPLORATION_PAPER_MIN_SCORE : FOLLOWED_PAPER_MIN_SCORE;
  const ranked = mergePapers(papers)
    .filter(paper => !paperIdentityKeys(paper).some(key => excluded.has(key)))
    .filter(paper => exploration ? !(paper.matches || []).length : (paper.matches || []).length > 0)
    .map(paper => ({ paper, score: digestPaperScore(paper, now) }))
    .filter(candidate => (
      Number.isFinite(candidate.score)
      && candidate.score >= minimumScore
      && (!exploration || (candidate.paper.citationCount as number) >= EXPLORATION_MIN_CITATIONS)
    ))
    .sort((left, right) => (
      right.score - left.score
      || publicationTime(right.paper) - publicationTime(left.paper)
      || paperKey(left.paper).localeCompare(paperKey(right.paper))
    ));

  if (exploration) return ranked.slice(0, Math.max(0, limit)).map(candidate => candidate.paper);

  const selected: DigestPaper[] = [];
  while (ranked.length && selected.length < limit) {
    const blocked = blockedFollowKeys(selected);
    const hasAlternative = blocked.size > 0 && ranked.some(candidate => (
      !getPaperFollowKeys(candidate.paper).some(key => blocked.has(key))
    ));
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    ranked.forEach((candidate, index) => {
      if (hasAlternative && getPaperFollowKeys(candidate.paper).some(key => blocked.has(key))) return;
      const adjustedScore = candidate.score - (sharesFollow(candidate.paper, selected.at(-1)) ? 8 : 0);
      if (adjustedScore > bestScore) {
        bestIndex = index;
        bestScore = adjustedScore;
      }
    });
    const [next] = ranked.splice(bestIndex >= 0 ? bestIndex : 0, 1);
    selected.push(next.paper);
  }
  return selected;
}

function digestFollowsForWindow(follows: Follow[] | undefined, now = Date.now()) {
  const allFollows = Array.isArray(follows) ? follows : [];
  if (allFollows.length <= MAX_QUERIED_FOLLOWS) return allFollows;
  const dayIndex = Math.floor(now / DAY_MS);
  const offset = dayIndex % allFollows.length;
  return allFollows.slice(offset).concat(allFollows.slice(0, offset)).slice(0, MAX_QUERIED_FOLLOWS);
}

async function collectDigestPapers(subscription: Subscription, env: WorkerEnv, {
  test = false,
  now = Date.now(),
  openAlexRequests = null,
}: CollectOptions = {}) {
  const follows = digestFollowsForWindow(subscription.follows, now);
  const sourceReport = createSourceReport();
  if (!follows.length) return { papers: [], sourceReport };
  const arxivFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length > 0);
  const indexedFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length === 0);
  const indexedFreshPromise = mapWithConcurrency(indexedFollows, 4, follow => (
    follow.type === 'project'
      ? fetchProjectUpdates(follow, env, sourceReport, openAlexRequests)
      : fetchOpenAlexUpdates(follow, env, now, sourceReport, openAlexRequests)
  ));
  const arxivFreshPromise = (async () => {
    if (!arxivFollows.length) return { papers: [], requiredFailed: 0 };
    try {
      return {
        papers: await fetchArxivTopicUpdates(arxivFollows, sourceReport),
        requiredFailed: 0,
      };
    } catch (error) {
      console.warn('arXiv digest unavailable, using OpenAlex fallback', (error as EmailNotificationError)?.code || 'EMAIL_SOURCE_ARXIV_UNAVAILABLE');
      const fallbackResults = await mapWithConcurrency(
        arxivFollows,
        2,
        follow => fetchOpenAlexUpdates(follow, env, now, sourceReport, openAlexRequests),
      );
      return {
        papers: fallbackResults
          .filter(result => result.status === 'fulfilled')
          .flatMap(result => result.value),
        requiredFailed: fallbackResults.filter(result => result.status === 'rejected').length,
      };
    }
  })();
  const [indexedResults, arxivResult] = await Promise.all([indexedFreshPromise, arxivFreshPromise]);
  const indexedFresh = indexedResults
    .filter(result => result.status === 'fulfilled')
    .flatMap(result => result.value);
  sourceReport.requiredFailed = (
    indexedResults.filter(result => result.status === 'rejected').length
    + arxivResult.requiredFailed
  );
  const combined = mergePapers([
    ...indexedFresh,
    ...arxivResult.papers,
    ...(subscription.previewItems || []),
  ]);
  const cutoff = now - DIGEST_FRESHNESS_DAYS * DAY_MS;
  const maximum = subscription.maxPapers || 5;
  const sentKeys = test ? new Set<string>() : new Set(subscription.sentPaperKeys || []);
  const followedSelection = selectDigestPapers(
    combined.filter(paper => publicationTime(paper) >= cutoff),
    { limit: maximum, now, excludedKeys: sentKeys },
  );
  let discovery: DigestPaper[] = [];
  if (
    !test
    && followedSelection.length < maximum
    && (followedSelection.length > 0 || sourceReport.requiredFailed === 0)
  ) {
    const selectedKeys = new Set([
      ...sentKeys,
      ...followedSelection.flatMap(paperIdentityKeys),
    ]);
    try {
      const exploration = await fetchExplorationUpdates(env, now, sourceReport, openAlexRequests);
      discovery = selectDigestPapers(exploration, {
        limit: 1,
        now,
        exploration: true,
        excludedKeys: selectedKeys,
      });
    } catch (error) {
      console.warn('Digest exploration unavailable', (error as EmailNotificationError)?.code || 'EMAIL_SOURCE_OPENALEX_UNAVAILABLE');
    }
  }
  const papers = [...followedSelection, ...discovery].slice(0, maximum);
  if (!papers.length && sourceReport.requiredFailed > 0) {
    throw new EmailDigestTransientError(sourceReport);
  }
  return { papers, sourceReport };
}

function configuredEmailProvider(env: WorkerEnv) {
  return env.RESEND_API_KEY && env.RESEND_FROM_EMAIL ? 'resend' : '';
}

function resolveResendSender(env: WorkerEnv) {
  return cleanText(env.RESEND_FROM_EMAIL, 320);
}

const kvDeliveryLedgerLocks = new WeakMap<KVNamespace, Map<string, Promise<unknown>>>();

function utcDay(now = Date.now()) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dailySendLimit(env: WorkerEnv) {
  const configuredLimit = Number(env.EMAIL_DAILY_SEND_LIMIT);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : DEFAULT_DAILY_SEND_LIMIT;
}

function deliveryReservationSeed(subscription: Subscription, { test = false, now = Date.now() }: DeliveryOptions = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const uid = cleanText(subscription?.uid, 160) || 'unknown';
  const window = test
    ? `test-${Math.floor(timestamp / TEST_IDEMPOTENCY_WINDOW_MS)}`
    : `digest-${utcDay(timestamp)}`;
  return `papertok:${window}:${uid}:${subscriptionGeneration(subscription)}`;
}

function buildDeliveryReservationId(subscription: Subscription, options: DeliveryOptions = {}) {
  return hashDeliveryReservationId(deliveryReservationSeed(subscription, options));
}

async function hashDeliveryReservationId(seed: string) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(seed),
  ));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function withKvDeliveryLedgerLock<T>(store: KVNamespace, key: string, operation: () => Promise<T>) {
  let locks = kvDeliveryLedgerLocks.get(store);
  if (!locks) {
    locks = new Map();
    kvDeliveryLedgerLocks.set(store, locks);
  }
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  locks.set(key, current);
  return current.finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  });
}

/**
 * The KV emulation of the ledger is serialized by a WeakMap that only exists
 * inside one isolate, so it cannot stop two isolates from duplicating a send or
 * overrunning the daily limit. It stays available for tests and local runs
 * behind an explicit opt-in; a deployment that loses the Durable Object binding
 * must fail loudly instead of degrading into a mode with no guarantees.
 */
function emailDeliveryLedgerMode(env: WorkerEnv) {
  if (env?.EMAIL_DELIVERY_LEDGER?.idFromName && (env?.EMAIL_DELIVERY_LEDGER as Partial<Env['EMAIL_DELIVERY_LEDGER']> | undefined)?.get) return 'durable';
  if (cleanText(env?.EMAIL_DELIVERY_LEDGER_FALLBACK, 20).toLowerCase() === 'kv') return 'kv';
  return 'missing';
}

export function getEmailDeliveryLedgerHealth(env: WorkerEnv) {
  const mode = emailDeliveryLedgerMode(env);
  if (mode === 'durable') return { mode, ok: true };
  return {
    mode,
    ok: false,
    code: mode === 'kv' ? 'EMAIL_DELIVERY_LEDGER_FALLBACK' : 'EMAIL_DELIVERY_LEDGER_MISSING',
  };
}

async function callEmailDeliveryLedger(env: WorkerEnv, payload: DeliveryLedgerPayload, now = Date.now()): Promise<DeliveryLedgerResult> {
  const day = utcDay(now);
  const ledgerNow = Date.now();
  const mode = emailDeliveryLedgerMode(env);
  if (mode === 'missing') {
    throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
  }
  if (mode === 'durable') {
    const id = env.EMAIL_DELIVERY_LEDGER!.idFromName(day);
    const stub = env.EMAIL_DELIVERY_LEDGER!.get(id);
    const response = await stub.fetch('https://papertok.internal/email-delivery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, now: new Date(ledgerNow).toISOString() }),
    });
    const result = await response.json<DeliveryLedgerResult>().catch(() => null);
    if (!response.ok || !result) {
      throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
    }
    return result;
  }

  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${DELIVERY_LEDGER_PREFIX}${day}`;
  return withKvDeliveryLedgerLock(env.NOTIFICATION_STORE, key, async () => {
    const current = await env.NOTIFICATION_STORE!.get<DeliveryLedgerState>(key, 'json');
    const outcome = applyEmailDeliveryLedgerAction(current, {
      ...payload,
      now: new Date(ledgerNow).toISOString(),
    });
    if (outcome.status >= 400) {
      throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
    }
    if (payload.action !== 'inspect') {
      await env.NOTIFICATION_STORE!.put(key, JSON.stringify(outcome.state), {
        expirationTtl: DELIVERY_LEDGER_TTL_SECONDS,
      });
    }
    return outcome.result;
  });
}

async function inspectEmailDelivery(env: WorkerEnv, reservationId: string, now: number) {
  return callEmailDeliveryLedger(env, {
    action: 'inspect',
    reservationId,
  }, now);
}

async function reserveEmailDelivery(env: WorkerEnv, reservationId: string, now: number, draft?: DeliveryDraftInput) {
  const result = await callEmailDeliveryLedger(env, {
    action: 'reserve',
    reservationId,
    limit: dailySendLimit(env),
    retryMinAgeMs: DELIVERY_PENDING_RETRY_MIN_AGE_MS,
    retryWindowMs: DELIVERY_PENDING_RETRY_WINDOW_MS,
    ...(draft ? { draft } : {}),
  }, now);
  if (!result.accepted) {
    if (result.alert) captureEmailSendLimit();
    throw new EmailNotificationError('EMAIL_PROVIDER_LIMIT', 429);
  }
  return result;
}

async function commitEmailDelivery(env: WorkerEnv, reservationId: string, delivery: DeliveryInput, now: number) {
  return callEmailDeliveryLedger(env, {
    action: 'commit',
    reservationId,
    delivery,
  }, now);
}

async function releaseEmailDelivery(env: WorkerEnv, reservationId: string, now: number) {
  try {
    await callEmailDeliveryLedger(env, { action: 'release', reservationId }, now);
  } catch (error) {
    console.warn('Could not release email delivery reservation', (error as EmailNotificationError)?.code || 'EMAIL_DELIVERY_LEDGER_UNAVAILABLE');
  }
}

async function buildProviderIdempotencyKey(subscription: Subscription, options: DeliveryOptions = {}) {
  return buildDeliveryReservationId(subscription, options);
}

function buildResendIdempotencyKey(subscription: Subscription, { test = false, now = Date.now() }: DeliveryOptions = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const sendWindow = test
    ? Math.floor(timestamp / TEST_IDEMPOTENCY_WINDOW_MS)
    : new Date(timestamp).toISOString().slice(0, 10);
  const uid = cleanText(subscription?.uid, 160).replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  return `${test ? 'test' : 'digest'}-${uid}-${sendWindow}`.slice(0, 256);
}

function resendSendErrorCode(status: number, payload: ProviderPayload = {}) {
  const providerMessage = cleanText(`${payload?.name || ''} ${payload?.message || ''}`, 1_000);
  const testRecipientRestricted = status === 403 && (
    /only send testing emails/i.test(providerMessage)
    || /own email address/i.test(providerMessage)
    || /verify a domain/i.test(providerMessage)
    || /resend\.dev/i.test(providerMessage)
  );
  if (testRecipientRestricted) return 'EMAIL_TEST_RECIPIENT_RESTRICTED';
  if (status === 401 || status === 403) return 'EMAIL_PROVIDER_AUTH_FAILED';
  if (status === 429) return ['daily_quota_exceeded', 'monthly_quota_exceeded'].includes(payload?.name || '')
    ? 'EMAIL_PROVIDER_LIMIT'
    : 'EMAIL_PROVIDER_RATE_LIMIT';
  return 'EMAIL_SEND_FAILED';
}

function providerOutcomeDefinitelyRejected(status: number) {
  if (status === 429) return true;
  if ([408, 409, 425].includes(status) || status >= 500) return false;
  return status >= 400 && status < 500;
}

const EMAIL_COPY = {
  nameplate: 'PaperTok',
  subject: (week: string) => `Your papers for the week of ${week}`,
  greeting: (name: string) => (name ? `Hi ${name},` : 'Hi there,'),
  paperCount: (count: number) => (count === 1 ? '1 new paper' : `${count} new papers`),
  emptyHeadline: 'Your email is ready',
  introduction: 'Welcome to your weekly selection of papers we think you might find interesting.',
  outsideFollows: 'Outside your follows',
  alsoInEdition: 'More to read',
  leadLabel: 'Start here',
  byline: (authors: string) => `By ${authors}`,
  andOthers: 'and others',
  authorUnavailable: 'Authors unavailable',
  readPaper: 'Read the paper',
  testSubject: 'PaperTok: test email',
  testKicker: 'Test email',
  testBody: 'Your PaperTok email works. We prepare your weekly edition on Monday when there are new papers. Sending limits may delay delivery.',
  empty: 'Your connection is ready. We have not found recent publications from what you follow yet.',
  closingTitle: "That's all for this edition.",
  closingBody: 'There is more waiting in your feed.',
  openInbox: 'Explore my feed',
  footer: 'You are receiving this email because you turned on email updates in PaperTok.',
  unsubscribe: 'Unsubscribe',
  emailUpdates: 'Email updates',
  unavailable: 'Service unavailable',
  unavailableBody: 'Your email settings could not be reached. Please try this link again later.',
  invalidLink: 'Invalid unsubscribe link',
  invalidLinkBody: 'If you have already unsubscribed, there is nothing more to do. Otherwise, turn off email updates in Settings.',
  openSettings: 'Open Settings',
  confirmTitle: 'Confirm unsubscribe',
  confirmBody: 'Do you want to stop receiving PaperTok updates by email?',
  confirmAction: 'Disable emails',
  disabledTitle: 'Emails disabled',
  disabledBody: 'You will no longer receive PaperTok updates by email.',
  returnToPaperTok: 'Return to PaperTok',
};

/**
 * PaperTok is English-only. Stored subscriptions may still carry a legacy
 * `language: 'es'`; they simply receive English email now.
 */
function subscriptionLanguage(subscription?: Subscription | null): string;
function subscriptionLanguage() {
  return 'en';
}

// The light theme's paper, ink and rules (src/styles/variables.css). A mail
// client cannot read the app's custom properties, so the values are copied.
const EMAIL_PALETTE = Object.freeze({
  page: '#ebeae5', // --bg-secondary: the ink wash around the sheet
  sheet: '#fbf8f0', // --bg-card
  ink: '#1d2b53', // --text-primary, --border-ink
  inkHover: '#3e4a6b', // --accent-primary-hover: the unsubscribe page's button
  secondary: '#46527a', // --text-secondary
  tertiary: '#5a6488', // --text-tertiary
  frame: '#d6ccb6', // --border-default
  brand: '#ffd21e', // --brand-yellow: the PT mark and nothing else
});

// The app's three voices, each followed by what a mail client without web
// fonts (most of them) will actually draw.
const EMAIL_FONTS = Object.freeze({
  serif: "Newsreader,'Iowan Old Style',Georgia,serif",
  sans: "Inter,-apple-system,'Segoe UI',Arial,sans-serif",
  mono: "'IBM Plex Mono',Menlo,Consolas,monospace",
});

const DIGEST_EXCERPT_LENGTH = 180;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// Spelled out by hand rather than through Intl, so the dateline cannot change
// with whatever locale data the runtime ships.
function editionDate(now: number) {
  const date = new Date(now);
  return `${WEEKDAY_NAMES[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The Monday that opens the edition's week, so each week's subject differs. */
function editionWeek(now: number) {
  const date = new Date(now);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - ((date.getUTCDay() + 6) % 7)));
  return `${monday.getUTCDate()} ${MONTH_NAMES[monday.getUTCMonth()]}`;
}

// Counted in code points, so a cut never leaves half of an astral character.
function truncateAtWord(value: string, maxLength: number) {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  const head = characters.slice(0, maxLength).join('');
  const boundary = head.lastIndexOf(' ');
  const kept = boundary > 0 ? head.slice(0, boundary) : characters.slice(0, maxLength - 1).join('');
  return `${kept.replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * The lead story's excerpt: the abstract up to a word boundary. A formula is
 * kept whole or left out, never cut, so no `$` and no half `<sub>` reaches
 * the reader.
 */
function renderScientificExcerpt(value: unknown, maxLength = DIGEST_EXCERPT_LENGTH) {
  const parts: Array<{ text: string; html?: string }> = [];
  let length = 0;
  let cut = false;
  for (const chunk of splitEmailScientificText(value)) {
    if (chunk.type === 'math') {
      const math = renderEmailMath(chunk.value);
      if (length + math.plain.length > maxLength) {
        cut = true;
        break;
      }
      parts.push({ html: mathSpan(math.html), text: math.plain });
      length += math.plain.length;
      continue;
    }
    if (length + chunk.value.length <= maxLength) {
      parts.push({ text: chunk.value });
      length += chunk.value.length;
      continue;
    }
    const head = chunk.value.slice(0, maxLength - length + 1);
    const boundary = head.lastIndexOf(' ');
    if (boundary > 0) parts.push({ text: chunk.value.slice(0, boundary) });
    cut = true;
    break;
  }
  if (cut && parts.length && !parts.at(-1)!.html) {
    parts.at(-1)!.text = parts.at(-1)!.text.replace(/[\s,;:.]+$/, '');
  }
  const text = parts.map(part => part.text).join('');
  if (!text.trim()) return { html: '', text: '' };
  const html = parts.map(part => part.html || escapeHtmlCharacters(part.text)).join('');
  return cut ? { html: `${html}…`, text: `${text}…` } : { html, text };
}

function isDiscovery(paper: DigestPaper) {
  return !(paper.matches || []).length;
}

function fieldLabel(area = '') {
  return Object.hasOwn(CATEGORIES, area) ? CATEGORIES[area].label : '';
}

function paperByline(paper: DigestPaper, { lead = false } = {}) {
  const authors = (paper.authors || []).filter(Boolean);
  if (!authors.length) return EMAIL_COPY.authorUnavailable;
  const names = authors.length <= 3
    ? authors.join(', ')
    : `${authors.slice(0, 3).join(', ')} ${EMAIL_COPY.andOthers}`;
  return lead ? EMAIL_COPY.byline(names) : names;
}

const DIGEST_PREHEADER_MAX_LENGTH = 120;

/** The subject names no paper; the preheader beside it carries the lead title. */
function digestPreheader(papers: DigestPaper[]) {
  const opening = `${EMAIL_COPY.paperCount(papers.length)}${papers.length === 1 ? ': ' : ', starting with: '}`;
  return `${opening}${truncateAtWord(renderScientificText(papers[0].title), DIGEST_PREHEADER_MAX_LENGTH - opening.length)}`;
}

function monoStyle({ size = 11, color = EMAIL_PALETTE.tertiary, tracking = '0.06em' }: { size?: number; color?: string; tracking?: string } = {}) {
  return `font:600 ${size}px/1.5 ${EMAIL_FONTS.mono};letter-spacing:${tracking};text-transform:uppercase;color:${color}`;
}

function storyLink(paper: DigestPaper) {
  return `<a href="${escapeHtml(paper.url || PAPER_TOK_URL)}" style="color:${EMAIL_PALETTE.ink};text-decoration:underline;text-decoration-color:${EMAIL_PALETTE.frame};text-decoration-thickness:1px;text-underline-offset:4px">${renderScientificHtml(paper.title)}</a>`;
}

// Phosphor's bold CaretRight (the app's icon set) in paper ink, rasterised
// because mail clients strip inline SVG. Decorative: the label stands alone.
const EMAIL_CARET_URL = 'https://papertok.app/email/caret-right.png';

/** The link carries the padding so all of it is clickable; Outlook, which drops padding on a link, reads the cell's. */
function emailButton(href: string, label: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${EMAIL_PALETTE.ink};border-radius:3px;mso-padding-alt:14px 20px 14px 22px"><a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 20px 14px 22px;font:600 15px/1 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.sheet};text-decoration:none">${escapeHtml(label)}&nbsp;<img src="${EMAIL_CARET_URL}" width="12" height="12" alt="" style="display:inline-block;width:12px;height:12px;border:0;vertical-align:-1px"></a></td></tr></table>`;
}

function sectionHeading(label: string, count = 0) {
  return `<h2 class="pt-h2" style="margin:0 0 18px;font:500 30px/1.15 ${EMAIL_FONTS.serif};letter-spacing:-0.02em;color:${EMAIL_PALETTE.ink}">${escapeHtml(label)}${count ? ` <span style="font-weight:700">(${count})</span>` : ''}</h2>`;
}

// A gray hairline on every side sets each paper apart from the next.
const STORY_FRAME = `border:1px solid ${EMAIL_PALETTE.frame};border-radius:3px`;

function storyDetails(paper: DigestPaper, { lead = false } = {}) {
  return `<p style="margin:${lead ? 0 : '8px 0 0'};font:400 14px/1.5 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(paperByline(paper, { lead }))}</p>
${isDiscovery(paper) ? `<p style="margin:10px 0 0"><span style="display:inline-block;padding:3px 7px;border:1px solid ${EMAIL_PALETTE.frame};border-radius:2px;${monoStyle({ size: 10, color: EMAIL_PALETTE.secondary })}">${EMAIL_COPY.outsideFollows}</span></p>` : ''}`;
}

function renderLeadStory(paper: DigestPaper) {
  const excerpt = renderScientificExcerpt(paper.abstract);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:36px 0 40px">
${sectionHeading(EMAIL_COPY.leadLabel)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${STORY_FRAME}"><tr><td class="pt-card" style="padding:24px 26px 26px">
<h3 class="pt-lead" style="margin:0 0 14px;font:600 26px/1.2 ${EMAIL_FONTS.serif};letter-spacing:-0.015em;color:${EMAIL_PALETTE.ink}">${storyLink(paper)}</h3>
${excerpt.html ? `<p style="margin:0 0 16px;font:400 17px/1.55 ${EMAIL_FONTS.serif};color:${EMAIL_PALETTE.ink}">${excerpt.html}</p>` : ''}
${storyDetails(paper, { lead: true })}
<div style="margin:22px 0 0">${emailButton(paper.url || PAPER_TOK_URL, EMAIL_COPY.readPaper)}</div>
</td></tr></table>
</td></tr></table>`;
}

function renderBriefs(papers: DigestPaper[]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${papers.map(paper => `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${STORY_FRAME}"><tr><td class="pt-card" style="padding:18px 22px 20px">
<h3 style="margin:0;font:600 21px/1.28 ${EMAIL_FONTS.serif};letter-spacing:-0.01em;color:${EMAIL_PALETTE.ink}">${storyLink(paper)}</h3>
${storyDetails(paper)}
</td></tr></table></td></tr>`).join('')}<tr><td style="height:26px;line-height:26px;font-size:0">&nbsp;</td></tr></table>`;
}

function joinNames(names: string[]) {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The edition's known fields, named once below the introduction. */
function editionIndex(papers: DigestPaper[]) {
  const names = [...new Set(papers.map(paper => fieldLabel(paper.area).toLowerCase()).filter(Boolean))];
  return names.length ? `About ${joinNames(names)}.` : '';
}

/** Tables and inline styles keep the digest readable across mail clients. */
function renderDigest(subscription: Subscription, papers: DigestPaper[], unsubscribeUrl: string, test: boolean, { now = Date.now() } = {}) {
  const firstName = cleanText(subscription?.displayName, 160).split(' ')[0];
  const greeting = EMAIL_COPY.greeting(firstName);
  const dateline = editionDate(now);
  // collectDigestPapers ranks the followed papers first, the discovery last.
  const lead = papers[0] || null;
  const rest = papers.filter(paper => paper !== lead);
  const others = [...rest.filter(paper => !isDiscovery(paper)), ...rest.filter(isDiscovery)];
  const subject = test ? EMAIL_COPY.testSubject : EMAIL_COPY.subject(editionWeek(now));
  const preheader = test ? EMAIL_COPY.testBody : lead ? digestPreheader(papers) : EMAIL_COPY.empty;
  const headline = papers.length ? `${EMAIL_COPY.paperCount(papers.length)} for you` : EMAIL_COPY.emptyHeadline;
  const { ink, sheet, secondary, tertiary } = EMAIL_PALETTE;
  const { serif, sans, mono } = EMAIL_FONTS;
  const index = editionIndex(papers);

  const testNotice = test
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:26px 0 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px dashed ${EMAIL_PALETTE.frame}"><tr><td style="padding:14px 16px">
<p style="margin:0;${monoStyle({ color: ink })}">${escapeHtml(EMAIL_COPY.testKicker)}</p>
<p style="margin:6px 0 0;font:400 15px/1.55 ${sans};color:${secondary}">${escapeHtml(EMAIL_COPY.testBody)}</p>
</td></tr></table></td></tr></table>`
    : '';
  const stories = lead
    ? `${renderLeadStory(lead)}${others.length ? `${sectionHeading(EMAIL_COPY.alsoInEdition, others.length)}${renderBriefs(others)}` : ''}`
    : `<p style="margin:0;padding:30px 0;font:400 16px/1.55 ${sans};color:${secondary}">${escapeHtml(EMAIL_COPY.empty)}</p>`;

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<style>
@media (max-width:620px){
.pt-outer{padding:0!important}
.pt-shell{padding:24px 20px 30px!important}
.pt-h1{font-size:32px!important}
.pt-h2{font-size:25px!important}
.pt-lead{font-size:23px!important}
.pt-card{padding:20px 18px 22px!important}
}
</style>
</head><body style="margin:0;padding:0;background:${EMAIL_PALETTE.page};color:${ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_PALETTE.page}"><tr><td class="pt-outer" align="center" style="padding:32px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${sheet};border:1px solid ${EMAIL_PALETTE.frame}"><tr><td class="pt-shell" style="padding:30px 40px 36px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="width:40px"><div aria-hidden="true" style="width:30px;height:30px;background:${EMAIL_PALETTE.brand};border-radius:3px;text-align:center;font:600 12px/30px ${mono};color:${ink}">PT</div></td>
<td valign="middle"><p style="margin:0;font:600 21px/1 ${serif};letter-spacing:-0.01em;color:${ink}">${escapeHtml(EMAIL_COPY.nameplate)}</p></td>
<td align="right" valign="middle" style="${monoStyle({ size: 10, tracking: '0.05em' })}">${escapeHtml(dateline)}</td>
</tr></table>
<div style="margin:18px 0 0;border-top:2px solid ${ink};height:0;line-height:0;font-size:0">&nbsp;</div>
<p style="margin:32px 0 0;font:italic 400 19px/1.4 ${serif};color:${secondary}">${escapeHtml(greeting)}</p>
<h1 class="pt-h1" style="margin:6px 0 0;font:600 40px/1.08 ${serif};letter-spacing:-0.025em;color:${ink}">${escapeHtml(headline)}</h1>
${lead ? `<p style="margin:16px 0 0;font:400 16px/1.6 ${sans};color:${secondary}">${escapeHtml(EMAIL_COPY.introduction)}</p>` : ''}
${index ? `<p style="margin:6px 0 0;font:400 16px/1.6 ${sans};color:${secondary}">${escapeHtml(index)}</p>` : ''}
${testNotice}
${stories}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:2px solid ${ink}">
<tr><td style="padding:28px 0 0">
${lead ? `<p style="margin:0 0 6px;font:600 22px/1.25 ${serif};color:${ink}">${escapeHtml(EMAIL_COPY.closingTitle)}</p>` : ''}
<p style="margin:0 0 18px;font:400 15px/1.55 ${sans};color:${secondary}">${escapeHtml(EMAIL_COPY.closingBody)}</p>
${emailButton(PAPER_TOK_URL, EMAIL_COPY.openInbox)}
</td></tr>
<tr><td style="padding:30px 0 0;font:400 12px/1.6 ${sans};color:${tertiary}">${escapeHtml(EMAIL_COPY.footer)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${secondary};text-decoration:underline">${escapeHtml(EMAIL_COPY.unsubscribe)}</a>.</td></tr>
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const storyText = (paper: DigestPaper, { isLead = false } = {}) => {
    const lines = [renderScientificText(paper.title)];
    if (isLead) {
      const excerpt = renderScientificExcerpt(paper.abstract).text;
      if (excerpt) lines.push(excerpt);
    }
    lines.push(paperByline(paper, { lead: isLead }));
    if (isDiscovery(paper)) lines.push(EMAIL_COPY.outsideFollows);
    lines.push(paper.url || PAPER_TOK_URL);
    return lines.join('\n');
  };
  const blocks = [
    `${EMAIL_COPY.nameplate.toUpperCase()}\n${dateline}`,
    [greeting, headline, ...(lead ? [EMAIL_COPY.introduction] : []), ...(index ? [index] : [])].join('\n'),
    ...(test ? [`${EMAIL_COPY.testKicker.toUpperCase()}\n${EMAIL_COPY.testBody}`] : []),
    ...(lead ? [`${EMAIL_COPY.leadLabel.toUpperCase()}\n${storyText(lead, { isLead: true })}`] : [EMAIL_COPY.empty]),
    ...(others.length ? [`${EMAIL_COPY.alsoInEdition.toUpperCase()} (${others.length})`, ...others.map(paper => storyText(paper))] : []),
    `${lead ? `${EMAIL_COPY.closingTitle} ` : ''}${EMAIL_COPY.closingBody}\n${EMAIL_COPY.openInbox}: ${PAPER_TOK_URL}\n\n${EMAIL_COPY.footer}\n${EMAIL_COPY.unsubscribe}: ${unsubscribeUrl}`,
  ];
  return { html, text: blocks.join('\n\n'), subject };
}

// Deliberately the same shape as `fetchWithDeadline` in `provider-runtime.js`, down
// to the caller-signal rule. This one used to arm an `AbortController` and clear
// its timer in a `finally`, which reads as bounded and is not: `fetch` resolves
// when the **headers** arrive, so the timer was gone before a byte of the body
// had been read -- and every caller here reads the body afterwards, the Identity
// Toolkit lookup that guards each protected route among them. `AbortSignal.timeout`
// has no timer to clear and stays armed until the response has been read in full.
// Sharing the name with a helper that behaved differently is what let the old
// shape survive a sweep for exactly this bug, so the contracts now match: a
// caller signal is *added* to the deadline, never a replacement for it, and
// `AbortSignal.any` keeps whichever fired first as the reason.
function fetchWithDeadline(input: RequestInfo | URL, init: RequestInit | undefined, timeoutMs: number) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

async function fetchEmailProvider(input: RequestInfo | URL, init: RequestInit) {
  return fetchWithDeadline(input, init, EMAIL_PROVIDER_TIMEOUT_MS);
}

async function sendWithResend(subscription: Pick<Subscription, 'email'>, content: DeliveryDraft['content'], unsubscribeUrl: string | null, env: WorkerEnv, idempotencyKey: string) {
  const from = resolveResendSender(env);
  const response = await fetchEmailProvider(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'user-agent': 'PaperTok/1.0',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [subscription.email],
      subject: content.subject,
      html: content.html,
      text: content.text,
      ...(unsubscribeUrl ? { headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      } } : {}),
    }),
  });
  const payload = await response.json<ProviderPayload>().catch((): ProviderPayload => ({}));
  if (!response.ok) {
    const code = resendSendErrorCode(response.status, payload);
    if (code === 'EMAIL_PROVIDER_LIMIT') captureEmailSendLimit();
    console.error('Resend rejected email', response.status, code);
    const error = new EmailNotificationError(code, response.status === 429 ? 429 : 502);
    error.deliveryRejected = providerOutcomeDefinitelyRejected(response.status);
    throw error;
  }
  return payload?.id || null;
}

function compactSourceReport(report: SourceReportInput = {}) {
  return {
    attempted: Math.max(0, Number(report.attempted) || 0),
    succeeded: Math.max(0, Number(report.succeeded) || 0),
    failed: Math.max(0, Number(report.failed) || 0),
    requestAttempts: Math.max(0, Number(report.requestAttempts) || 0),
    retried: Math.max(0, Number(report.retried) || 0),
    requiredFailed: Math.max(0, Number(report.requiredFailed) || 0),
    bySource: Object.fromEntries(Object.entries(report.bySource || {}).map(([source, counts]) => [source, {
      attempted: Math.max(0, Number(counts?.attempted) || 0),
      succeeded: Math.max(0, Number(counts?.succeeded) || 0),
      failed: Math.max(0, Number(counts?.failed) || 0),
      requestAttempts: Math.max(0, Number(counts?.requestAttempts) || 0),
      retried: Math.max(0, Number(counts?.retried) || 0),
    }])),
    failureCodes: Object.fromEntries(Object.entries(report.failureCodes || {})
      .filter(([, count]) => Number(count) > 0)),
  };
}

function lastDeliveryStatus(status: string, at: string, {
  kind = 'digest',
  paperCount = 0,
  partial = false,
  code,
  sourceReport,
}: StatusOptions = {}) {
  return {
    status,
    kind,
    at,
    paperCount: Math.max(0, Number(paperCount) || 0),
    partial: Boolean(partial),
    ...(code ? { code: cleanText(code, 100) } : {}),
    ...(sourceReport ? { sources: compactSourceReport(sourceReport) } : {}),
  };
}

function deliveryStatePatch(currentState: DeliveryState, delivery: Delivery, status = 'sent') {
  const sentAt = delivery.sentAt || new Date().toISOString();
  if (delivery.kind === 'test') {
    return {
      lastTestAt: sentAt,
      lastTestDelivery: lastDeliveryStatus(status, sentAt, {
        kind: 'test',
        paperCount: delivery.paperCount,
        partial: delivery.partial,
        sourceReport: delivery.sources,
      }),
    };
  }
  const sentPaperKeys = [...new Set([
    ...(currentState.sentPaperKeys || []),
    ...(delivery.paperKeys || []),
  ])].slice(-MAX_SENT_PAPER_KEYS);
  return {
    lastCheckedAt: sentAt,
    lastSentAt: sentAt,
    sentPaperKeys,
    heldDigest: null,
    owedCurrentWeek: false,
    lastDelivery: lastDeliveryStatus(status, sentAt, {
      paperCount: delivery.paperCount,
      partial: delivery.partial,
      sourceReport: delivery.sources,
    }),
  };
}

function papersForCurrentSubscription(papers: DigestPaper[], subscription: Subscription, test: boolean) {
  const sentKeys = test ? new Set<string>() : new Set(subscription.sentPaperKeys || []);
  const followKeys = new Set((subscription.follows || []).map(follow => (
    `${follow.type}:${follow.canonicalId}`
  )));
  return papers.filter(paper => (
    !paperIdentityKeys(paper).some(key => sentKeys.has(key))
    && (!(paper.matches || []).length || getPaperFollowKeys(paper).some(key => followKeys.has(key)))
  )).slice(0, subscription.maxPapers || 5);
}

function buildDeliveryDraft(subscription: Subscription, papers: DigestPaper[], env: WorkerEnv, {
  test = false,
  now = Date.now(),
  sourceReport = createSourceReport(),
  editionAt = now,
}: SendOptions = {}) {
  const workerBase = cleanText(env.WORKER_PUBLIC_URL, 500)
    || 'https://api.papertok.app';
  const unsubscribeUrl = `${workerBase}/notifications/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken!)}`;
  return {
    provider: 'resend',
    recipient: {
      email: subscription.email,
      displayName: subscription.displayName,
    },
    content: renderDigest(subscription, papers, unsubscribeUrl, test, { now: editionAt }),
    unsubscribeUrl,
    delivery: {
      kind: test ? 'test' : 'digest',
      sentAt: new Date(now).toISOString(),
      paperCount: papers.length,
      paperKeys: test ? [] : papers.flatMap(paperIdentityKeys),
      partial: sourceReport.failed > 0,
      sources: compactSourceReport(sourceReport),
    },
  };
}

async function deliverReservedDraft(env: WorkerEnv, reservationId: string, draft: Omit<DeliveryDraft, 'recipient'> & { recipient: Pick<Subscription, 'email' | 'displayName'> }, now: number, {
  ledgerTime = now,
}: { ledgerTime?: number } = {}): Promise<DeliveryOutcome> {
  const idempotencyKey = reservationId;
  if (draft.provider !== 'resend') {
    // A pre-migration Brevo response may have been lost. Treat the old
    // reservation as uncertain instead of sending a duplicate through Resend.
    await commitEmailDelivery(env, reservationId, draft.delivery, ledgerTime);
    return { reconciled: true, uncertain: true, delivery: draft.delivery };
  }
  let providerId;
  try {
    providerId = await sendWithResend(draft.recipient, draft.content, draft.unsubscribeUrl, env, idempotencyKey);
  } catch (error) {
    if ((error as EmailNotificationError)?.deliveryRejected) await releaseEmailDelivery(env, reservationId, now);
    if (error instanceof EmailNotificationError) throw error;
    const unknown = new EmailNotificationError('EMAIL_SEND_OUTCOME_UNKNOWN', 502);
    unknown.transient = true;
    throw unknown;
  }
  await commitEmailDelivery(env, reservationId, draft.delivery, ledgerTime);
  return { sent: true, providerId, delivery: draft.delivery };
}

/**
 * Reconciling a ledger reservation only makes sense while the delivery state
 * has not caught up with it. A committed reservation survives three days, so
 * treating it as pending work spent every cron window of the following day
 * replaying a delivery that was already recorded.
 */
function deliveryAlreadySettled(subscription: Subscription, deliveredAt?: string) {
  const settled = Date.parse(subscription?.lastSentAt || '');
  const delivered = Date.parse(deliveredAt || '');
  return Number.isFinite(settled) && Number.isFinite(delivered) && settled >= delivered;
}

async function resumeScheduledDelivery(subscription: Subscription, env: WorkerEnv, {
  now = Date.now(),
  key = `${SUBSCRIPTION_PREFIX}${subscription.uid}`,
}: { now?: number; key?: string } = {}): Promise<DeliveryOutcome | null> {
  const ledgerTimes = [now, now - DAY_MS];
  for (const ledgerTime of ledgerTimes) {
    const reservationId = await buildDeliveryReservationId(subscription, { now: ledgerTime });
    const existing = await inspectEmailDelivery(env, reservationId, ledgerTime);
    if (existing.status === 'missing') continue;
    if (existing.status === 'committed' && existing.delivery) {
      if (deliveryAlreadySettled(subscription, existing.delivery.sentAt || existing.committedAt)) {
        continue;
      }
      return { reconciled: true, delivery: existing.delivery };
    }
    if (existing.status !== 'reserved') return { pending: true };

    const latest = await loadSubscriptionWithState(env, key);
    if (!latest?.enabled) return { pending: true, cancelled: true };
    if (!(latest.follows || []).length) return { pending: true, invalid: true };
    const draft = existing.draft;
    if (!draft?.delivery) return { pending: true };
    const reservedAt = Date.parse(existing.reservedAt || '');
    const reservationAge = Number.isFinite(reservedAt) ? Date.now() - reservedAt : Number.POSITIVE_INFINITY;
    const retryExpired = (
      reservationAge > DELIVERY_PENDING_RETRY_WINDOW_MS
      || Number(existing.attempts || 1) >= 2
    );
    if (retryExpired) {
      await commitEmailDelivery(env, reservationId, draft.delivery, ledgerTime);
      // Committing keeps the uncertain outcome honest in the ledger, but a
      // delivery the state already records must not be replayed: it would push
      // lastSentAt backwards and cost the reader the digest due right now.
      if (deliveryAlreadySettled(latest, draft.delivery.sentAt)) continue;
      return { reconciled: true, uncertain: true, delivery: draft.delivery };
    }

    const reservation = await reserveEmailDelivery(env, reservationId, ledgerTime);
    if (!reservation.retry || !reservation.draft) return { pending: true };
    return deliverReservedDraft(env, reservationId, reservation.draft, now, { ledgerTime });
  }
  return null;
}

async function sendDigest(subscription: Subscription, papers: DigestPaper[], env: WorkerEnv, {
  test = false,
  now = Date.now(),
  key = `${SUBSCRIPTION_PREFIX}${subscription.uid}`,
  sourceReport = createSourceReport(),
  editionAt = now,
}: SendOptions = {}): Promise<DeliveryOutcome> {
  const provider = configuredEmailProvider(env);
  if (!provider) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const reservationId = await buildDeliveryReservationId(subscription, { test, now });
  const latest = await loadSubscriptionWithState(env, key);
  if (!latest?.enabled || !(latest.follows || []).length) {
    return { cancelled: true, invalid: Boolean(latest?.enabled) };
  }
  if (!test && !isSubscriptionDue(latest, new Date(now))) {
    return { cancelled: true };
  }
  const currentPapers = papersForCurrentSubscription(papers, latest, test);
  if (!test && !currentPapers.length) {
    return { cancelled: true, reconciled: true };
  }
  const draft = buildDeliveryDraft(latest, currentPapers, env, {
    test,
    now,
    sourceReport,
    editionAt,
  });
  const reservation = await reserveEmailDelivery(env, reservationId, now, draft);
  if (reservation.duplicate) {
    if (reservation.status === 'committed' && reservation.delivery) {
      return { reconciled: true, delivery: reservation.delivery };
    }
    if (!reservation.retry) return { pending: true };
  }
  if (!reservation.duplicate) {
    const beforeDelivery = await loadSubscriptionWithState(env, key);
    if (
      !beforeDelivery?.enabled
      || subscriptionGeneration(beforeDelivery) !== subscriptionGeneration(latest)
      || beforeDelivery.updatedAt !== latest.updatedAt
    ) {
      await releaseEmailDelivery(env, reservationId, now);
      return { cancelled: true };
    }
  }
  const reservedDraft = reservation.draft || draft;
  return deliverReservedDraft(env, reservationId, reservedDraft, now);
}

async function testSubscription(env: WorkerEnv, identity: EmailIdentity) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const subscription = await loadSubscriptionWithState(env, key);
  if (!subscription?.enabled) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  if (!(subscription.follows || []).length) throw new EmailNotificationError('EMAIL_FOLLOWS_REQUIRED', 409);
  const lastTestAt = Date.parse((subscription.lastTestAt || 0) as string);
  if (lastTestAt && Date.now() - lastTestAt < 60_000) {
    throw new EmailNotificationError('EMAIL_TEST_RATE_LIMIT', 429);
  }
  const now = Date.now();
  const { papers, sourceReport } = await collectDigestPapers(subscription, env, { test: true, now });
  const result = await sendDigest(subscription, papers, env, {
    test: true,
    now,
    key,
    sourceReport,
  });
  if (result.pending) throw new EmailNotificationError('EMAIL_TEST_RATE_LIMIT', 429);
  if (result.invalid || result.cancelled) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  const updated = await updateDeliveryState(
    env,
    key,
    subscription,
    state => deliveryStatePatch(state, result.delivery!, result.reconciled ? 'reconciled' : 'sent'),
  );
  if (!updated) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  return {
    ok: true,
    providerId: result.providerId || null,
    paperCount: result.delivery!.paperCount,
    followCount: updated.follows?.length || 0,
    preferences: publicSubscription(updated, identity.email),
  };
}

export async function handleEmailNotificationRequest(request: Request, env: WorkerEnv, pathname: string) {
  const identity = await verifyFirebaseIdentity(request, env);
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;

  if (pathname === '/notifications/preferences' && request.method === 'GET') {
    const subscription = await loadSubscriptionWithState(env, key);
    return { preferences: publicSubscription(subscription, identity.email) };
  }
  if (pathname === '/notifications/preferences' && request.method === 'PUT') {
    return { preferences: await saveSubscription(request, env, identity) };
  }
  if (pathname === '/notifications/test' && request.method === 'POST') {
    return testSubscription(env, identity);
  }
  throw new EmailNotificationError('EMAIL_METHOD_NOT_ALLOWED', 405);
}

// Every unsubscribe answer is a page, errors included, and all of them carry
// these headers: the token is in the URL, so nothing may cache, frame or
// refer it onwards.
const UNSUBSCRIBE_PAGE_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
});

/**
 * The page an unsubscribe link opens, set on the digest's paper and ink: its
 * masthead in miniature over a double rule, a mono kicker, a serif headline,
 * one sentence and an ink action. A browser page rather than an email, so one
 * stylesheet carries what style attributes cannot (focus, hover, the phone
 * size). The CSP admits nothing else: no script and no web fonts, so each
 * voice falls back through its stack, as it does in most mail clients.
 */
function unsubscribePage(status: number, { title, body, action }: { title: string; body: string; action: string }) {
  const { page, sheet, ink, inkHover, secondary, tertiary, frame, brand } = EMAIL_PALETTE;
  const { serif, sans, mono } = EMAIL_FONTS;
  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light only">
<title>${escapeHtml(title)} | PaperTok</title>
<style>
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;padding:clamp(16px,9vh,88px) 16px 48px;background:${page};color:${ink};font:400 16px/1.55 ${sans}}
.pt-sheet{max-width:520px;margin:0 auto;padding:26px 32px 32px;background:${sheet};border:1px solid ${frame}}
.pt-masthead{display:flex;align-items:center;justify-content:center;gap:12px;padding:0 0 16px;border-bottom:3px double ${ink}}
.pt-mark{flex:none;width:30px;height:30px;border-radius:3px;background:${brand};box-shadow:2px 2px 0 ${ink};font:600 13px/30px ${mono};text-align:center;color:${ink}}
.pt-nameplate{margin:0;font:600 24px/1 ${serif};letter-spacing:-0.02em}
.pt-kicker{margin:28px 0 0;font:600 11px/1.5 ${mono};letter-spacing:0.06em;text-transform:uppercase;color:${tertiary}}
h1{margin:8px 0 12px;font:600 34px/1.12 ${serif};letter-spacing:-0.02em;text-wrap:balance}
.pt-body{margin:0;color:${secondary};text-wrap:pretty}
.pt-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px 20px;margin-top:26px}
.pt-actions form{margin:0}
.pt-button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:0 16px;border:1px solid ${ink};border-radius:3px;background:${ink};color:${sheet};font:600 14px/1 ${sans};text-decoration:none;white-space:nowrap;cursor:pointer;-webkit-appearance:none;appearance:none}
.pt-link{display:inline-flex;align-items:center;min-height:40px;margin:0 -4px;padding:0 4px;font:600 14px/1 ${sans};color:${ink};text-decoration:underline;text-underline-offset:3px}
.pt-button:focus-visible,.pt-link:focus-visible{outline:2px solid ${ink};outline-offset:2px}
@media (hover:hover) and (pointer:fine){.pt-button:hover{background:${inkHover}}.pt-link:hover{text-decoration-thickness:2px}}
@media (prefers-reduced-motion:no-preference){.pt-button{transition:background-color 150ms ease-out,scale 150ms ease-out}.pt-button:active{scale:0.97}}
@media (max-width:480px){.pt-sheet{padding:22px 18px 26px}h1{font-size:28px}}
</style>
</head><body>
<div class="pt-sheet">
<header class="pt-masthead"><span class="pt-mark" aria-hidden="true">PT</span><p class="pt-nameplate">${escapeHtml(EMAIL_COPY.nameplate)}</p></header>
<main>
<p class="pt-kicker">${escapeHtml(EMAIL_COPY.emailUpdates)}</p>
<h1>${escapeHtml(title)}</h1>
<p class="pt-body">${escapeHtml(body)}</p>
<div class="pt-actions">${action}</div>
</main>
</div>
</body></html>`;
  return new Response(html, { status, headers: UNSUBSCRIBE_PAGE_HEADERS });
}

function pageButtonLink(href: string, label: string) {
  return `<a class="pt-button" href="${href}">${escapeHtml(label)}</a>`;
}

export async function handleEmailUnsubscribe(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  // English-only: a legacy `lang` query parameter (e.g. `lang=es` in links from
  // older emails) and the Accept-Language header are ignored.
  const copy = EMAIL_COPY;
  if (!env.NOTIFICATION_STORE) {
    return unsubscribePage(503, {
      title: copy.unavailable,
      body: copy.unavailableBody,
      action: pageButtonLink(PAPER_TOK_URL, copy.returnToPaperTok),
    });
  }
  // Already used, replaced by a newer email or cut short: the link cannot say
  // which, so the page names the likely case and the way to the setting.
  const invalidLinkPage = () => unsubscribePage(400, {
    title: copy.invalidLink,
    body: copy.invalidLinkBody,
    action: pageButtonLink(PAPER_TOK_SETTINGS_URL, copy.openSettings),
  });
  const token = cleanText(requestUrl.searchParams.get('token'), 100);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(token)) {
    return invalidLinkPage();
  }
  const uid = await env.NOTIFICATION_STORE.get(`${UNSUBSCRIBE_PREFIX}${token}`);
  if (!uid) return invalidLinkPage();
  const subscription = await loadSubscriptionWithState(env, `${SUBSCRIPTION_PREFIX}${uid}`);
  if (!subscription || subscription.unsubscribeToken !== token) {
    await env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${token}`);
    return invalidLinkPage();
  }
  if (request.method === 'POST') {
    await deleteSubscription(env, uid, subscription);
  }

  const title = request.method === 'POST' ? copy.disabledTitle : copy.confirmTitle;
  const body = request.method === 'POST' ? copy.disabledBody : copy.confirmBody;
  const action = request.method === 'GET'
    ? `<form method="post" action="${escapeHtml(requestUrl.pathname)}?token=${encodeURIComponent(token)}"><button type="submit" class="pt-button">${escapeHtml(copy.confirmAction)}</button></form>
<a class="pt-link" href="${PAPER_TOK_URL}">${escapeHtml(copy.returnToPaperTok)}</a>`
    : pageButtonLink(PAPER_TOK_URL, copy.returnToPaperTok);
  return unsubscribePage(200, { title, body, action });
}

export async function getEmailScheduleHealth(env: WorkerEnv, now = Date.now()): Promise<{ available: boolean; fresh: boolean; code?: string; scheduledAt?: string | null; completedAt?: string | null } & Partial<Omit<ScheduleSummary, 'scheduledAt' | 'completedAt'>>> {
  if (!env.NOTIFICATION_STORE) {
    return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_NOT_CONFIGURED' };
  }
  try {
    const summary = await env.NOTIFICATION_STORE.get<ScheduleSummary>(SCHEDULE_STATUS_KEY, 'json');
    if (!summary) return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_NOT_RUN' };
    const completedAt = cleanText(summary.completedAt, 40);
    const completedTime = Date.parse(completedAt);
    const fresh = Number.isFinite(completedTime) && now - completedTime <= 30 * 60 * 60 * 1000;
    const count = (field: keyof ScheduleSummary) => Math.max(0, Number(summary[field]) || 0);
    return {
      available: true,
      fresh,
      ...(fresh ? {} : { code: 'EMAIL_SCHEDULE_STALE' }),
      scheduledAt: cleanText(summary.scheduledAt, 40) || null,
      completedAt: completedAt || null,
      scanned: count('scanned'),
      processed: count('processed'),
      deferred: count('deferred'),
      due: count('due'),
      sent: count('sent'),
      empty: count('empty'),
      invalid: count('invalid'),
      reconciled: count('reconciled'),
      uncertain: count('uncertain'),
      partial: count('partial'),
      skipped: count('skipped'),
      failed: count('failed'),
      failureCodes: Object.fromEntries(Object.entries(summary.failureCodes || {})
        .map(([code, value]): [string, number] => [cleanText(code, 100), Math.max(0, Number(value) || 0)])
        .filter(([code, value]) => code && value > 0)
        .slice(0, 24)),
    };
  } catch {
    return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_UNAVAILABLE' };
  }
}

export async function checkEmailProviderHealth(env: WorkerEnv) {
  const provider = 'resend';
  if (!configuredEmailProvider(env)) {
    return { configured: false, available: false, provider, code: 'EMAIL_NOT_CONFIGURED' };
  }

  try {
    const response = await fetchWithDeadline(`${RESEND_API}/domains?limit=100`, {
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        accept: 'application/json',
        'user-agent': 'PaperTok/1.0',
      },
    }, EMAIL_HEALTH_TIMEOUT_MS);
    if (response.status === 401 || response.status === 403) {
      const errorPayload = await response.json<ProviderPayload>().catch((): ProviderPayload => ({}));
      // A "sending access" (restricted) Resend key can send emails but is not
      // allowed to list domains, so this probe comes back as 401 with
      // name "restricted_api_key". This does not prove that the sender domain
      // is verified, so report unknown sender status rather than an auth failure.
      // See https://resend.com/docs/api-reference/errors
      // Status alone is not enough: a bare 401/403 without this marker means a
      // genuinely rejected key (revoked, suspended, blocked) and must fail closed.
      const isRestrictedKey = response.status === 401 && (
        errorPayload?.name === 'restricted_api_key'
        || /restricted/i.test(errorPayload?.message || '')
      );
      if (isRestrictedKey) {
        return {
          configured: true,
          available: false,
          provider,
          permissionLimited: true,
          code: 'EMAIL_SENDER_STATUS_UNKNOWN',
        };
      }
      console.warn('Resend health probe rejected', response.status, errorPayload?.name || 'unknown');
      return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_AUTH_FAILED' };
    }
    if (!response.ok) return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
    const payload = await response.json<{ data?: Array<{ name?: string; status?: string }> }>()
      .catch((): { data?: Array<{ name?: string; status?: string }> } => ({}));
    if (!Array.isArray(payload.data)) {
      return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
    }
    const senderDomain = resolveResendSender(env).replace(/^.*@/, '').replace(/>$/, '').toLowerCase();
    const senderDomainRecord = payload.data.find(domain => domain.name?.toLowerCase() === senderDomain);
    const verified = senderDomainRecord?.status === 'verified';
    if (senderDomainRecord?.status === 'partially_verified') {
      return { configured: true, available: false, provider, code: 'EMAIL_SENDER_STATUS_UNKNOWN' };
    }
    return {
      configured: true,
      available: verified,
      provider,
      ...(verified ? { senderMode: 'verified-domain' } : { code: 'EMAIL_SENDER_NOT_VERIFIED' }),
    };
  } catch {
    return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
  }
}

// A source failure can retry on Tuesday. A definitively rejected send can
// retry through Sunday: the local ledger refuses before reserving and Resend's
// 429 response is a refusal. Other send failures may have delivered, so only
// their existing reservation is recovered.
function isWeeklySourceFailureRetry(subscription: Subscription, now: Date, dayStart: number) {
  if (now.getUTCDay() !== 2) return false;
  const weekStart = dayStart - DAY_MS;
  const lastSent = Date.parse(subscription.lastSentAt || '');
  if (Number.isFinite(lastSent) && lastSent >= weekStart) return false;
  const lastDelivery = subscription.lastDelivery;
  const failedAt = Date.parse(lastDelivery?.at || '');
  return lastDelivery?.status === 'failed'
    && lastDelivery.code === DIGEST_SOURCES_UNAVAILABLE
    && Number.isFinite(failedAt)
    && failedAt >= weekStart
    && failedAt <= now.getTime();
}

function isWeeklyRejectedSendRetry(subscription: Subscription, now: Date, dayStart: number) {
  if (now.getUTCDay() === 1) return false;
  const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * DAY_MS;
  const lastSent = Date.parse(subscription.lastSentAt || '');
  if (Number.isFinite(lastSent) && lastSent >= weekStart) return false;
  const lastDelivery = subscription.lastDelivery;
  const failedAt = Date.parse(lastDelivery?.at || '');
  return lastDelivery?.status === 'failed'
    && ['EMAIL_PROVIDER_LIMIT', 'EMAIL_PROVIDER_RATE_LIMIT'].includes(lastDelivery.code || '')
    && Number.isFinite(failedAt)
    && failedAt >= weekStart
    && failedAt <= now.getTime();
}

// Monday, whatever frequency the record stored: see DIGEST_FREQUENCY.
function isSubscriptionCalendarDue(subscription: Subscription, now: Date) {
  if (!subscription?.enabled) return false;
  const lastSent = Date.parse((subscription.lastSentAt || 0) as string);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getUTCDay() === 1 && (!lastSent || lastSent < dayStart))
    || (now.getUTCDay() !== 1 && subscription.owedCurrentWeek === true)
    || isWeeklySourceFailureRetry(subscription, now, dayStart)
    || isWeeklyRejectedSendRetry(subscription, now, dayStart);
}

function isSubscriptionDue(subscription: Subscription, now: Date) {
  if (!isSubscriptionCalendarDue(subscription, now)) return false;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastSent = Date.parse(subscription.lastSentAt || '');
  if (subscription.owedCurrentWeek && Number.isFinite(lastSent) && lastSent >= dayStart) return false;
  const lastDeliveryAt = Date.parse((subscription.lastDelivery?.at || 0) as string);
  if (!Number.isFinite(lastDeliveryAt) || lastDeliveryAt < dayStart) return true;
  const elapsed = now.getTime() - lastDeliveryAt;
  if (subscription.lastDelivery?.status === 'invalid') return false;
  if (subscription.lastDelivery?.status === 'failed' && subscription.lastDelivery.code === 'EMAIL_PROVIDER_LIMIT') return false;
  if (subscription.lastDelivery?.status === 'empty') return elapsed >= EMPTY_RETRY_INTERVAL_MS;
  if (subscription.lastDelivery?.status === 'failed') return elapsed >= FAILURE_RETRY_INTERVAL_MS;
  return true;
}

function shouldInspectPreviousDay(subscription: Subscription, now: Date) {
  return isSubscriptionCalendarDue(subscription, now) || [2, 3].includes(now.getUTCDay());
}

function allowsNewScheduledDelivery(now: Date) {
  return !(now.getUTCHours() === 13 && now.getUTCMinutes() >= 40);
}

async function loadScheduleCursor(store: KVNamespace) {
  try {
    return cleanText(await store.get(SCHEDULE_CURSOR_KEY), 2_000) || undefined;
  } catch {
    return undefined;
  }
}

async function persistScheduleCursor(store: KVNamespace, cursor: string | undefined) {
  if (cursor) await store.put(SCHEDULE_CURSOR_KEY, cursor);
  else await store.delete(SCHEDULE_CURSOR_KEY);
}

function failureCodeCounts(sourceReport?: SourceReportInput, code?: string) {
  const counts = { ...(sourceReport?.failureCodes || {}) };
  if (code) counts[code] = (counts[code] || 0) + 1;
  return counts;
}

function mergeSourceReports(target: SourceReport, report?: SourceReportInput) {
  if (!report) return target;
  (['attempted', 'succeeded', 'failed', 'requestAttempts', 'retried', 'requiredFailed'] as const).forEach((field) => {
    target[field] += Math.max(0, Number(report[field]) || 0);
  });
  Object.entries(report.bySource || {}).forEach(([source, counts]) => {
    const bucket = sourceBucket(target, source)!;
    (['attempted', 'succeeded', 'failed', 'requestAttempts', 'retried'] as const).forEach((field) => {
      bucket[field] += Math.max(0, Number(counts?.[field]) || 0);
    });
  });
  Object.entries(report.failureCodes || {}).forEach(([code, count]) => {
    target.failureCodes[code] = (target.failureCodes[code] || 0) + Math.max(0, Number(count) || 0);
  });
  return target;
}

async function recordSubscriptionOutcome(env: WorkerEnv, key: string, subscription: Subscription, status: string, at: string, {
  code,
  paperCount = 0,
  partial = false,
  sourceReport,
  heldDigest,
}: StatusOptions & { heldDigest?: DeliveryState['heldDigest'] } = {}) {
  return updateDeliveryState(env, key, subscription, () => ({
    lastCheckedAt: at,
    ...(['empty', 'invalid'].includes(status) ? { owedCurrentWeek: false } : {}),
    ...(heldDigest === undefined ? {} : { heldDigest }),
    lastDelivery: lastDeliveryStatus(status, at, {
      code,
      paperCount,
      partial,
      sourceReport,
    }),
  }));
}

async function persistScheduledDelivery(env: WorkerEnv, key: string, subscription: Subscription, delivery: DeliveryOutcome, now: Date, selectedAt: string | undefined): Promise<ScheduledOutcome> {
  const status = delivery.uncertain ? 'uncertain' : delivery.reconciled ? 'reconciled' : 'sent';
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * DAY_MS;
  const selectedTime = Date.parse(selectedAt || '');
  const carriedFromLastWeek = Number.isFinite(selectedTime) && selectedTime < weekStart && selectedTime >= weekStart - 7 * DAY_MS;
  const updated = await updateDeliveryState(
    env,
    key,
    subscription,
    state => ({
      ...deliveryStatePatch(state, delivery.delivery!, status),
      owedCurrentWeek: carriedFromLastWeek,
    }),
  );
  if (!updated && delivery.sent) {
    return {
      sent: true,
      partial: Boolean(delivery.delivery!.partial),
      sources: compactSourceReport(delivery.delivery!.sources),
      failureCodes: failureCodeCounts(delivery.delivery!.sources),
    };
  }
  if (!updated) return { skipped: true };
  return {
    [status]: true,
    partial: Boolean(delivery.delivery!.partial),
    sources: compactSourceReport(delivery.delivery!.sources),
    failureCodes: failureCodeCounts(
      delivery.delivery!.sources,
      delivery.uncertain ? 'EMAIL_SEND_OUTCOME_UNCONFIRMED' : undefined,
    ),
  };
}

async function processScheduledSubscription(env: WorkerEnv, key: { name: string }, now: Date, openAlexRequests: OpenAlexRequests): Promise<ScheduledOutcome> {
  const subscription = await loadSubscriptionWithState(env, key.name);
  if (!subscription?.enabled || !shouldInspectPreviousDay(subscription, now)) return { skipped: true };
  const checkedAt = now.toISOString();
  if (!(subscription.follows || []).length) {
    const code = 'EMAIL_SUBSCRIPTION_INVALID';
    // Recorded once. Only a save can give the record follows, so writing the same
    // outcome again in every window spent a KV write per window and changed
    // nothing but its timestamp.
    if (subscription.lastDelivery?.status !== 'invalid') {
      await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code });
    }
    return { invalid: true, failureCodes: { [code]: 1 } };
  }
  let sourceReport: SourceReport | undefined;
  let attemptedPapers: DigestPaper[] | undefined;
  let heldSelectedAt: string | undefined;
  try {
    const resumed = await resumeScheduledDelivery(subscription, env, {
      now: now.getTime(),
      key: key.name,
    });
    if (resumed) {
      if (resumed.invalid) {
        const code = 'EMAIL_SUBSCRIPTION_INVALID';
        await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code, heldDigest: null });
        return { invalid: true, failureCodes: { [code]: 1 } };
      }
      if (resumed.pending || resumed.cancelled) return { skipped: true };
      return persistScheduledDelivery(
        env, key.name, subscription, resumed, now,
        subscription.heldDigest?.selectionKey === heldDigestSelectionKey(subscription)
          ? subscription.heldDigest.selectedAt
          : undefined,
      );
    }

    if (!isSubscriptionDue(subscription, now) || !allowsNewScheduledDelivery(now)) {
      return { skipped: true };
    }

    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * DAY_MS;
    const held = subscription.heldDigest;
    const selectedAt = Date.parse(held?.selectedAt || '');
    const selectionKey = heldDigestSelectionKey(subscription);
    if (
      held?.papers?.length
      && held.selectionKey === selectionKey
      && Number.isFinite(selectedAt)
      && selectedAt >= weekStart - 7 * DAY_MS
      && selectedAt <= now.getTime()
    ) {
      attemptedPapers = held.papers;
      sourceReport = mergeSourceReports(createSourceReport(), held.sourceReport);
      heldSelectedAt = held.selectedAt;
    } else {
      const collected = await collectDigestPapers(subscription, env, {
        now: now.getTime(),
        openAlexRequests,
      });
      attemptedPapers = collected.papers;
      sourceReport = collected.sourceReport;
    }
    if (!attemptedPapers.length) {
      await recordSubscriptionOutcome(env, key.name, subscription, 'empty', checkedAt, { sourceReport, heldDigest: null });
      return {
        empty: true,
        partial: false,
        sources: compactSourceReport(sourceReport),
        failureCodes: failureCodeCounts(sourceReport),
      };
    }

    const delivery = await sendDigest(subscription, attemptedPapers, env, {
      now: now.getTime(),
      key: key.name,
      sourceReport,
      editionAt: heldSelectedAt ? Date.parse(heldSelectedAt) : undefined,
    });
    if (delivery.pending) return { skipped: true, sources: compactSourceReport(sourceReport) };
    if (delivery.invalid) {
      const code = 'EMAIL_SUBSCRIPTION_INVALID';
      await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code, sourceReport, heldDigest: null });
      return {
        invalid: true,
        sources: compactSourceReport(sourceReport),
        failureCodes: failureCodeCounts(sourceReport, code),
      };
    }
    if (delivery.cancelled) return { skipped: true, sources: compactSourceReport(sourceReport) };
    return persistScheduledDelivery(env, key.name, subscription, delivery, now, heldSelectedAt);
  } catch (error) {
    captureWorkerException(error, 'schedule');
    sourceReport ||= (error as EmailNotificationError)?.sourceReport;
    const code = cleanText((error as EmailNotificationError)?.code, 100) || 'EMAIL_SCHEDULE_PROCESSING_FAILED';
    console.warn('Scheduled email subscription failed', code);
    try {
      await recordSubscriptionOutcome(
        env,
        key.name,
        subscription,
        'failed',
        checkedAt,
        {
          code,
          sourceReport,
          heldDigest: ['EMAIL_PROVIDER_LIMIT', 'EMAIL_PROVIDER_RATE_LIMIT'].includes(code) && attemptedPapers?.length
            ? {
              papers: attemptedPapers,
              sourceReport: compactSourceReport(sourceReport),
              selectedAt: heldSelectedAt || checkedAt,
              selectionKey: heldDigestSelectionKey(subscription),
            }
            : null,
        },
      );
    } catch (recordError) {
      console.warn('Could not persist subscription delivery failure', (recordError as Error)?.message || recordError);
    }
    return {
      failed: true,
      partial: false,
      sources: compactSourceReport(sourceReport),
      failureCodes: failureCodeCounts(sourceReport, code),
    };
  }
}

async function recordScheduleOutcome(env: WorkerEnv, summary: ScheduleSummary) {
  console.info('Email notification schedule completed', JSON.stringify(summary));
  if (!env.NOTIFICATION_STORE) return;
  try {
    await env.NOTIFICATION_STORE.put(SCHEDULE_STATUS_KEY, JSON.stringify(summary));
  } catch (error) {
    console.warn('Could not persist email notification schedule outcome', (error as EmailNotificationError)?.message || error);
  }
  try {
    const historyKey = `${SCHEDULE_HISTORY_PREFIX}${summary.scheduledAt}`;
    await env.NOTIFICATION_STORE.put(historyKey, JSON.stringify(summary), {
      expirationTtl: SCHEDULE_HISTORY_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('Could not persist email notification schedule history', (error as EmailNotificationError)?.message || error);
  }
}

export async function runEmailNotificationSchedule(env: WorkerEnv, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  const startedAt = Date.now();
  const provider = configuredEmailProvider(env);
  const ledgerMissing = Boolean(provider && env.NOTIFICATION_STORE) && emailDeliveryLedgerMode(env) === 'missing';
  if (ledgerMissing) {
    console.error('Email delivery ledger binding is missing; refusing to send without an atomic daily limit');
  }
  // The schedule also scans Thursday through Sunday for subscriptions held by
  // an earlier day's provider limit.
  const disabled = !env.NOTIFICATION_STORE || !provider || ledgerMissing;
  if (!env.NOTIFICATION_STORE || disabled) {
    const summary: ScheduleSummary = {
      scheduledAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      provider: provider || null,
      scanned: 0,
      processed: 0,
      deferred: 0,
      due: 0,
      sent: 0,
      empty: 0,
      invalid: 0,
      reconciled: 0,
      uncertain: 0,
      partial: 0,
      skipped: 1,
      failed: 0,
      sources: compactSourceReport(),
      failureCodes: ledgerMissing ? { EMAIL_DELIVERY_LEDGER_MISSING: 1 } : {},
      ...(disabled ? { disabled: true } : {}),
    };
    await recordScheduleOutcome(env, summary);
    return summary;
  }
  let cursor = await loadScheduleCursor(env.NOTIFICATION_STORE);
  let scanned = 0;
  let processed = 0;
  let deferred = 0;
  let sent = 0;
  let empty = 0;
  let invalid = 0;
  let reconciled = 0;
  let uncertain = 0;
  let partial = 0;
  let skipped = 0;
  let failed = 0;
  const sources = createSourceReport();
  const failureCodes: Record<string, number> = {};
  // One per run, never module-level: the isolate outlives the run, so a shared
  // map would hand one run's answers to the next and grow without bound.
  const openAlexRequests: OpenAlexRequests = new Map();
  let inventoryComplete = false;
  while (!inventoryComplete) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SCHEDULE_PROCESSING_BUDGET_MS - SCHEDULE_MIN_BATCH_REMAINING_MS) {
      deferred = 1;
      skipped += 1;
      failureCodes.EMAIL_SCHEDULE_TIME_BUDGET = 1;
      break;
    }
    let page;
    try {
      page = await env.NOTIFICATION_STORE.list({
        prefix: SUBSCRIPTION_PREFIX,
        cursor,
        limit: SCHEDULE_PAGE_SIZE,
      });
    } catch (error) {
      if (!cursor) throw error;
      console.warn('Email schedule cursor was invalid; restarting subscription scan');
      cursor = undefined;
      await persistScheduleCursor(env.NOTIFICATION_STORE, undefined);
      continue;
    }
    const batch = page.keys || [];
    const results = await Promise.allSettled(batch.map(key => processScheduledSubscription(
      env,
      key,
      now,
      openAlexRequests,
    )));
    processed += batch.length;
    scanned += batch.length;
    sent += results.filter(result => result.status === 'fulfilled' && result.value?.sent).length;
    empty += results.filter(result => result.status === 'fulfilled' && result.value?.empty).length;
    invalid += results.filter(result => result.status === 'fulfilled' && result.value?.invalid).length;
    reconciled += results.filter(result => result.status === 'fulfilled' && result.value?.reconciled).length;
    uncertain += results.filter(result => result.status === 'fulfilled' && result.value?.uncertain).length;
    partial += results.filter(result => result.status === 'fulfilled' && result.value?.partial).length;
    skipped += results.filter(result => result.status === 'fulfilled' && result.value?.skipped).length;
    failed += results.filter(result => (
      result.status === 'rejected' || (result.status === 'fulfilled' && result.value?.failed)
    )).length;
    results.forEach((result) => {
      if (result.status === 'fulfilled') mergeSourceReports(sources, result.value?.sources);
      const counts = result.status === 'fulfilled'
        ? result.value?.failureCodes
        : { EMAIL_SCHEDULE_PROCESSING_FAILED: 1 };
      Object.entries(counts || {}).forEach(([code, count]) => {
        failureCodes[code] = (failureCodes[code] || 0) + Number(count || 0);
      });
    });
    cursor = page.list_complete ? undefined : page.cursor;
    inventoryComplete = Boolean(page.list_complete || !page.cursor);
    try {
      await persistScheduleCursor(env.NOTIFICATION_STORE, cursor);
    } catch (error) {
      console.warn('Could not persist email schedule cursor', (error as EmailNotificationError)?.message || error);
    }
    if (!batch.length && !cursor) inventoryComplete = true;
  }
  const summary: ScheduleSummary = {
    scheduledAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    provider,
    scanned,
    processed,
    deferred,
    due: sent + empty + invalid + reconciled + uncertain + failed,
    sent,
    empty,
    invalid,
    reconciled,
    uncertain,
    partial,
    skipped,
    failed,
    sources: compactSourceReport(sources),
    failureCodes,
  };
  await recordScheduleOutcome(env, summary);
  return summary;
}

export const emailNotificationInternals = {
  // Exported for the F2 deadline regressions: the tests need to hand them a
  // 25 ms deadline instead of waiting out the real one.
  fetchDigestSource,
  fetchWithDeadline,
  buildDeliveryReservationId,
  buildProviderIdempotencyKey,
  buildResendIdempotencyKey,
  collectDigestPapers,
  compactSourceReport,
  configuredEmailProvider,
  sanitizeFollow,
  sanitizePaper,
  sanitizePreferences,
  topicSearchQuery,
  fetchOpenAlexUpdates,
  fetchOpenAlexDigestPayload,
  saveSubscription,
  mergePapers,
  arxivCategoriesForFollow,
  parseArxivDigestFeed,
  selectDigestPapers,
  isSubscriptionDue,
  isSubscriptionCalendarDue,
  resendSendErrorCode,
  renderScientificHtml,
  renderDigest,
  readBoundedJson,
  allowsNewScheduledDelivery,
  digestFollowsForWindow,
  providerOutcomeDefinitelyRejected,
  deliveryLedgerPrefix: DELIVERY_LEDGER_PREFIX,
  deliveryStatePrefix: DELIVERY_STATE_PREFIX,
  scheduleCursorKey: SCHEDULE_CURSOR_KEY,
  scheduleHistoryPrefix: SCHEDULE_HISTORY_PREFIX,
  scheduleStatusKey: SCHEDULE_STATUS_KEY,
};

// Petri holding up her key (PetriKey), rasterised because mail clients do not
// draw SVG. Decorative: the email reads the same with images blocked.
const VERIFICATION_ART_URL = 'https://papertok.app/email/petri-key.png';

/** The verification screens' empty state, set as an email: Petri, title, line and ink action. */
function renderInstitutionVerificationEmail(email: string, link: string) {
  const { page: wash, sheet: paper, ink, secondary, tertiary, frame: rule, brand } = EMAIL_PALETTE;
  const { serif, sans } = EMAIL_FONTS;
  const href = escapeHtmlCharacters(link);
  const address = escapeHtmlCharacters(email);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Verify your university email</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Newsreader:opsz,wght@6..72,600&amp;family=IBM+Plex+Mono:wght@600&amp;display=swap" rel="stylesheet">
<style>@media (max-width:620px){.pt-shell{padding:32px 20px 28px!important}.pt-title{font-size:24px!important}}</style>
</head><body style="margin:0;padding:0;background:${wash};color:${ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">Confirm ${address} to link your university to PaperTok. It works once, within one hour.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${wash}"><tr><td align="center" style="padding:28px 10px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:${paper};border:1px solid ${ink};border-radius:3px"><tr><td class="pt-shell" align="center" style="padding:40px 40px 32px;text-align:center">
<img src="${VERIFICATION_ART_URL}" width="128" height="128" alt="" style="display:block;margin:0 auto 16px;border:0">
<h1 class="pt-title" style="margin:0 auto;max-width:28ch;font:600 28px/1.2 ${serif};letter-spacing:-0.01em;color:${ink}">Verify your university email</h1>
<p style="margin:12px auto 0;max-width:38ch;font:400 15px/1.55 ${sans};color:${secondary}">Petri has the key. Confirm that <strong style="font-weight:600;color:${ink}">${address}</strong> is yours to link your university to PaperTok.</p>
<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0"><tr><td style="background:${ink};border-radius:3px"><a href="${href}" style="display:inline-block;padding:13px 22px;font:600 14px/1 ${sans};color:${paper};text-decoration:none">Verify and link university</a></td></tr></table>
<p style="margin:16px auto 0;max-width:40ch;font:400 13px/1.55 ${sans};color:${tertiary}">Open it in the browser where you asked for it, signed in to the same account. It works once, within one hour.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:32px;border-top:1px dashed ${rule}"><tr><td align="left" style="padding:18px 0 0;text-align:left;font:400 12px/1.6 ${sans};color:${tertiary}">
If the button does not work, paste this link into the same browser:<br>
<a href="${href}" style="color:${secondary};text-decoration:underline;word-break:break-all">${href}</a>
<p style="margin:10px 0 0">If you did not ask to link a university, ignore this email. Do not share the link.</p>
</td></tr></table>
</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px"><tr>
<td valign="middle" style="padding-right:8px"><div aria-hidden="true" style="width:20px;height:20px;background:${brand};border-radius:3px;text-align:center;font:600 9px/20px ${EMAIL_FONTS.mono};color:${ink}">PT</div></td>
<td valign="middle" style="${monoStyle({ color: tertiary })}">PaperTok</td>
</tr></table>
</td></tr></table>
</body></html>`;
}

/** Verification credentials stay out of the resumable digest ledger. */
export async function sendInstitutionVerificationEmail(
  env: WorkerEnv, email: string, reservationSeed: string, createLink: () => Promise<string>,
) {
  if (!configuredEmailProvider(env)) {
    throw new EmailNotificationError('INSTITUTION_VERIFICATION_UNAVAILABLE', 503);
  }
  const now = Date.now();
  const reservationId = await hashDeliveryReservationId(reservationSeed);
  const reservation = await reserveEmailDelivery(env, reservationId, now);
  if (reservation.duplicate) {
    if (reservation.status === 'committed') return;
    throw new EmailNotificationError('INSTITUTION_VERIFICATION_UNCERTAIN', 503);
  }
  let sending = false;
  try {
    const link = await createLink();
    const content = {
      subject: 'Verify your university email for PaperTok',
      text: `Verify your university email\n\nConfirm that ${email} is yours to link your university to PaperTok. Open this link in the browser where you asked for it, signed in to the same account:\n${link}\n\nIt works once, within one hour.\n\nIf you did not ask to link a university, ignore this email. Do not share the link.`,
      html: renderInstitutionVerificationEmail(email, link),
    };
    sending = true;
    await sendWithResend({ email }, content, null, env, reservationId);
    await commitEmailDelivery(env, reservationId, { kind: 'verification', sentAt: new Date(now).toISOString() }, now);
  } catch (error) {
    if (!sending || (error instanceof EmailNotificationError && error.deliveryRejected)) {
      await releaseEmailDelivery(env, reservationId, now);
      throw error;
    }
    // A timeout may follow acceptance. Keep its budget reserved and the browser
    // request usable; resending automatically could deliver a second credential.
    throw new EmailNotificationError('INSTITUTION_VERIFICATION_UNCERTAIN', 503);
  }
}
