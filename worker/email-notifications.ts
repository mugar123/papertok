import type { Paper, PaperFollowMatch, PaperSubject } from '../src/models/Paper.ts';
import type { OpenAlexWork } from './openalex-api.ts';
import type { Delivery, DeliveryDraft, DeliveryDraftInput, DeliveryLedgerPayload, DeliveryLedgerResult, DeliveryLedgerState } from './email-delivery-ledger.ts';

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
type PreferencesBody = PreferencesInput & { follows?: FollowInput[]; previewItems?: PaperInput[] };
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
interface SendOptions extends DeliveryOptions { key?: string; sourceReport?: SourceReport }
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
import { CATEGORIES } from '../src/data/categoryTaxonomy.ts';
import { areaKeyForPaper } from '../src/utils/areaAccent.ts';
import { usableOpenAlexAbstract } from '../src/utils/openAlexAbstract.ts';
import { filterRelevantQueryTopicPapers } from '../src/utils/queryTopicSearch.ts';
import { applyEmailDeliveryLedgerAction } from './email-delivery-ledger.ts';
import { readBoundedJson as readBoundedRequestJson } from './bounded-body.ts';

const SUBSCRIPTION_PREFIX = 'notification:subscription:';
const DELIVERY_STATE_PREFIX = 'notification:delivery-state:';
const UNSUBSCRIBE_PREFIX = 'notification:unsubscribe:';
const BREVO_API = 'https://api.brevo.com/v3';
const RESEND_API = 'https://api.resend.com';
const ARXIV_API = 'https://export.arxiv.org/api/query';
// Ruta real desde el 18-09-2026: la app dejo de vivir en el fragmento. Los
// correos ya enviados llevan `/#/following` y siguen llegando a su sitio --
// la puerta de index.html y utils/legacyHashRoute.js los traducen -- pero
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
const DEFAULT_DAILY_SEND_LIMIT = 290;
const SCHEDULE_STATUS_KEY = 'notification:schedule:last-run';
const SCHEDULE_HISTORY_PREFIX = 'notification:schedule:history:';
const SCHEDULE_CURSOR_KEY = 'notification:schedule:cursor';
const DELIVERY_LEDGER_PREFIX = 'notification:delivery-ledger:';
const TEST_IDEMPOTENCY_WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGEST_FRESHNESS_DAYS = 10;
// What the lead story's excerpt can draw on; the excerpt itself is shorter.
const DIGEST_ABSTRACT_MAX_LENGTH = 600;

/**
 * The twelve field inks of the light theme (`--gradient-*` in
 * src/styles/variables.css), keyed like `CATEGORIES`. An email cannot read the
 * app's custom properties, so the values are copied here, and a test holds
 * them to the stylesheet. Every one is at least 4.9:1 on white, so a field
 * name set in its own ink stays readable at mono-label size.
 */
const FIELD_INKS = Object.freeze({
  physics: '#4f46e5',
  cs: '#c2410c',
  math: '#7e22ce',
  stat: '#1d4ed8',
  econ: '#0f766e',
  'q-fin': '#0e7490',
  eess: '#a16207',
  mech: '#475569',
  civil: '#92400e',
  chemeng: '#4d7c0f',
  med: '#be123c',
  bio: '#15803d',
});

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
    // Both stay missing rather than guessed: a paper of no known field is set
    // in ink with no field name, and one without an abstract has no excerpt.
    ...(Object.hasOwn(FIELD_INKS, area) ? { area } : {}),
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
  sourceBucket(report, source!)!.failed += 1;
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
    sourceBucket(report, source!)!.attempted += 1;
  }
  try {
    const result = await operation();
    if (report) {
      report.succeeded += 1;
      sourceBucket(report, source!)!.succeeded += 1;
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

function arxivCategoriesForFollow(follow: FollowInput = {}) {
  const metadataCategories = Array.isArray(follow.metadata?.categoryIds)
    ? follow.metadata.categoryIds
    : [];
  const candidates = metadataCategories.length ? metadataCategories : [follow.canonicalId];
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

const TRUSTED_EMAIL_PROVIDERS = new Set(['google.com', 'github.com']);

/**
 * FIREBASE_WEB_API_KEY is public, so the Worker cannot assume the console only
 * offers Google and GitHub: any sign-up method that hands over an unverified
 * address would otherwise subscribe a stranger's inbox to the digest.
 * Firebase does not always flag federated sign-ins as verified, so an identity
 * provider that vouched for the same address counts as proof of possession.
 */
function accountOwnsEmail(account: EmailAccount) {
  if (account?.emailVerified === true) return true;
  const email = cleanText(account?.email, 320).toLowerCase();
  return (account?.providerUserInfo || []).some(provider => (
    TRUSTED_EMAIL_PROVIDERS.has(cleanText(provider?.providerId, 40).toLowerCase())
    && cleanText(provider?.email, 320).toLowerCase() === email
  ));
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
  const payload = await response.json<{ users?: EmailAccount[] }>().catch(() => ({} as { users?: EmailAccount[] }));
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
  const subscription = await env.NOTIFICATION_STORE!.get<Subscription>(key, 'json');
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
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const existingRecord = await loadSubscriptionRecord(env, key);
  const existingRaw = existingRecord?.subscription || null;
  const existing = existingRaw ? {
    ...existingRaw,
    ...deliveryStateFromSubscription(existingRaw),
    ...(existingRecord!.state || {}),
  } : null;

  if (!preferences.enabled) {
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
  const now = new Date().toISOString();
  const persistedBase = existingRecord?.state
    ? stripDeliveryState(existingRaw!)
    : (existingRaw || {});
  const subscription = {
    ...persistedBase,
    ...preferences,
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
    env.NOTIFICATION_STORE.put(`${UNSUBSCRIBE_PREFIX}${unsubscribeToken}`, identity.uid),
  ]);
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
    // The card's own resolution: the field, then what the topic is called.
    area: areaKeyForPaper({
      primaryTopic: work?.primary_topic,
      categories: [work?.primary_topic?.display_name].filter(Boolean) as string[],
    }),
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

function requestedEmailProvider(env: WorkerEnv) {
  const requested = cleanText(env.EMAIL_PROVIDER, 20).toLowerCase();
  if (requested === 'brevo' || requested === 'resend') return requested;
  if (env.BREVO_API_KEY) return 'brevo';
  if (env.RESEND_API_KEY) return 'resend';
  return '';
}

function configuredEmailProvider(env: WorkerEnv) {
  const provider = requestedEmailProvider(env);
  if (provider === 'brevo' && env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) return provider;
  if (provider === 'resend' && env.RESEND_API_KEY) return provider;
  return '';
}

function resolveBrevoSender(env: WorkerEnv) {
  return {
    name: cleanText(env.BREVO_FROM_NAME, 70) || 'PaperTok',
    email: cleanText(env.BREVO_FROM_EMAIL, 320),
  };
}

async function resolveResendSender(env: WorkerEnv) {
  if (env.RESEND_FROM_EMAIL) return cleanText(env.RESEND_FROM_EMAIL, 320);
  return 'PaperTok <onboarding@resend.dev>';
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

async function buildDeliveryReservationId(subscription: Subscription, options: DeliveryOptions = {}) {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(deliveryReservationSeed(subscription, options)),
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
  if (!result.accepted) throw new EmailNotificationError('EMAIL_PROVIDER_LIMIT', 429);
  return result;
}

async function commitEmailDelivery(env: WorkerEnv, reservationId: string, delivery: Delivery, now: number) {
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
  if (status === 429) return 'EMAIL_PROVIDER_LIMIT';
  return 'EMAIL_SEND_FAILED';
}

function brevoSendErrorCode(status: number, payload: ProviderPayload = {}) {
  const providerMessage = cleanText(`${payload?.code || ''} ${payload?.message || ''}`, 1_000);
  if (status === 401 || status === 403) return 'EMAIL_PROVIDER_AUTH_FAILED';
  if (status === 429) return 'EMAIL_PROVIDER_LIMIT';
  if (status === 400 && /sender|not valid|not verified|unauthorized/i.test(providerMessage)) {
    return 'EMAIL_SENDER_NOT_VERIFIED';
  }
  return 'EMAIL_SEND_FAILED';
}

function providerOutcomeDefinitelyRejected(status: number) {
  if (status === 429) return true;
  if ([408, 409, 425].includes(status) || status >= 500) return false;
  return status >= 400 && status < 500;
}

const EMAIL_COPY = {
  nameplate: 'The PaperTok Weekly',
  standfirst: 'New research from the people, topics and places you follow',
  edition: 'Weekly edition',
  editionFor: (name: string) => `Weekly edition for ${name}`,
  paperCount: (count: number) => (count === 1 ? '1 paper' : `${count} papers`),
  followReason: (names: string[]) => `You follow ${names.slice(0, 2).join(' and ')}`,
  outsideFollows: 'Outside your follows',
  alsoInEdition: 'Also in this edition',
  byline: (authors: string) => `By ${authors}`,
  andOthers: 'and others',
  authorUnavailable: 'Authors unavailable',
  citations: (count: number) => `${count} ${count === 1 ? 'citation' : 'citations'}`,
  openAccess: 'Open access',
  readPaper: 'Read the paper',
  andMore: (count: number) => `, and ${count} more`,
  testSubject: 'PaperTok: test email',
  testKicker: 'Test email',
  testBody: 'Your PaperTok email works. The weekly edition arrives on Monday mornings when there is something new from what you follow.',
  empty: 'Your connection is ready. We have not found recent publications from what you follow yet.',
  openInbox: 'Open my feed',
  colophon: 'The PaperTok Weekly · Every Monday',
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

// The light theme's ground, ink and rules (src/styles/variables.css), copied
// for the same reason as FIELD_INKS.
const EMAIL_PALETTE = Object.freeze({
  page: '#f7f7f8', // --bg-secondary
  sheet: '#ffffff', // --bg-card
  ink: '#111318', // --text-primary, --border-ink
  inkHover: '#2b2f38', // --accent-primary-hover: the unsubscribe page's button
  secondary: '#5b6270', // --text-secondary
  tertiary: '#6b7280', // --text-tertiary
  rule: '#e6e7ea', // --border-subtle
  frame: '#d3d5db', // --border-default
  brand: '#ffd21e', // --brand-yellow: the PT mark and nothing else
});

// The app's three voices, each followed by what a mail client without web
// fonts (most of them) will actually draw.
const EMAIL_FONTS = Object.freeze({
  serif: "Newsreader,'Iowan Old Style',Georgia,serif",
  sans: "Inter,-apple-system,'Segoe UI',Arial,sans-serif",
  mono: "'IBM Plex Mono',Menlo,Consolas,monospace",
});

const DIGEST_EXCERPT_LENGTH = 280;
const DIGEST_SUBJECT_MAX_LENGTH = 90;
const DIGEST_PREHEADER_MAX_LENGTH = 140;
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

function publicationLabel(value: string | undefined) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()].slice(0, 3)} ${date.getUTCFullYear()}`;
}

function truncateAtWord(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const head = value.slice(0, maxLength);
  const boundary = head.lastIndexOf(' ');
  const kept = boundary > 0 ? head.slice(0, boundary) : head.slice(0, maxLength - 1);
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

function paperReason(paper: DigestPaper) {
  const names = (paper.matches || []).map(match => match.displayName).filter(Boolean) as string[];
  return names.length ? EMAIL_COPY.followReason(names) : EMAIL_COPY.outsideFollows;
}

function paperField(paper: DigestPaper) {
  if (!Object.hasOwn(FIELD_INKS, paper.area || '')) return { label: '', ink: EMAIL_PALETTE.ink };
  return { label: CATEGORIES[paper.area as keyof typeof FIELD_INKS].label, ink: FIELD_INKS[paper.area as keyof typeof FIELD_INKS] };
}

function paperByline(paper: DigestPaper, { lead = false } = {}) {
  const authors = (paper.authors || []).filter(Boolean);
  if (!authors.length) return EMAIL_COPY.authorUnavailable;
  const names = authors.length <= 3
    ? authors.join(', ')
    : `${authors.slice(0, 3).join(', ')} ${EMAIL_COPY.andOthers}`;
  return lead ? EMAIL_COPY.byline(names) : names;
}

function paperMeta(paper: DigestPaper) {
  return [
    publicationLabel(paper.published),
    paper.journal,
    paper.citationCount ? EMAIL_COPY.citations(paper.citationCount) : '',
    paper.openAccess ? EMAIL_COPY.openAccess : '',
  ].filter(Boolean).join(' · ');
}

function textKicker(paper: DigestPaper) {
  const field = paperField(paper).label.toUpperCase();
  return isDiscovery(paper)
    ? [EMAIL_COPY.outsideFollows.toUpperCase(), field].filter(Boolean).join(' · ')
    : [field, paperReason(paper)].filter(Boolean).join(' · ');
}

function digestSubject(lead: DigestPaper | null, count: number) {
  if (!lead) return EMAIL_COPY.nameplate;
  const more = count > 1 ? EMAIL_COPY.andMore(count - 1) : '';
  return `${truncateAtWord(renderScientificText(lead.title), DIGEST_SUBJECT_MAX_LENGTH - more.length)}${more}`;
}

function monoStyle({ size = 11, color = EMAIL_PALETTE.tertiary, weight = 600, tracking = '0.06em' }: { size?: number; color?: string; weight?: number; tracking?: string } = {}) {
  return `font:${weight} ${size}px/1.5 ${EMAIL_FONTS.mono};letter-spacing:${tracking};text-transform:uppercase;color:${color}`;
}

// The field rule: the 34 × 3 bar the app sets above a headline.
function fieldRule(ink: string) {
  return `<div style="width:34px;height:3px;background:${ink};line-height:3px;font-size:0">&nbsp;</div>`;
}

function storyLink(paper: DigestPaper, style: string) {
  return `<a href="${escapeHtml(paper.url || PAPER_TOK_URL)}" style="${style}">${renderScientificHtml(paper.title)}</a>`;
}

function renderLeadStory(paper: DigestPaper) {
  const field = paperField(paper);
  const reason = `<span style="color:${EMAIL_PALETTE.tertiary}">${escapeHtml(isDiscovery(paper) ? EMAIL_COPY.outsideFollows : paperReason(paper))}</span>`;
  const label = field.label ? `<span style="color:${field.ink}">${escapeHtml(field.label)}</span> · ` : '';
  const excerpt = renderScientificExcerpt(paper.abstract);
  const meta = paperMeta(paper);
  const url = escapeHtml(paper.url || PAPER_TOK_URL);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:26px 0">
${fieldRule(field.ink)}
<p style="margin:12px 0 0;${monoStyle()}">${label}${reason}</p>
<h2 class="pt-lead" style="margin:10px 0 12px;font:600 34px/1.12 ${EMAIL_FONTS.serif};letter-spacing:-0.02em;color:${EMAIL_PALETTE.ink}">${storyLink(paper, `color:${EMAIL_PALETTE.ink};text-decoration:none`)}</h2>
${excerpt.html ? `<p style="margin:0 0 14px;font:400 17px/1.55 ${EMAIL_FONTS.serif};color:${EMAIL_PALETTE.ink}">${excerpt.html}</p>` : ''}
<p style="margin:0;font:400 14px/1.5 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(paperByline(paper, { lead: true }))}</p>
${meta ? `<p style="margin:6px 0 0;${monoStyle({ tracking: '0.04em' })}">${escapeHtml(meta)}</p>` : ''}
<p style="margin:14px 0 0"><a href="${url}" style="font:600 14px/1 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.ink};text-decoration:underline">${escapeHtml(EMAIL_COPY.readPaper)}&nbsp;→</a></p>
</td></tr></table>`;
}

function renderBrief(paper: DigestPaper) {
  const field = paperField(paper);
  const meta = paperMeta(paper);
  const small = { size: 10.5 };
  if (isDiscovery(paper)) {
    // The exploration pick is set apart in a ruled box, like an editor's note.
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${EMAIL_PALETTE.ink};background:${EMAIL_PALETTE.page}"><tr><td style="padding:14px 14px 16px">
<p style="margin:0;${monoStyle({ ...small, color: EMAIL_PALETTE.ink })}"><span aria-hidden="true">★ </span>${escapeHtml(EMAIL_COPY.outsideFollows)}</p>
${field.label ? `<p style="margin:6px 0 0;${monoStyle({ ...small, color: field.ink })}">${escapeHtml(field.label)}</p>` : ''}
<h3 style="margin:6px 0 8px;font:600 18px/1.25 ${EMAIL_FONTS.serif};color:${EMAIL_PALETTE.ink}">${storyLink(paper, `color:${EMAIL_PALETTE.ink};text-decoration:none`)}</h3>
<p style="margin:0;font:400 13px/1.5 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(paperByline(paper))}</p>
${meta ? `<p style="margin:5px 0 0;${monoStyle({ ...small, color: EMAIL_PALETTE.secondary, tracking: '0.04em' })}">${escapeHtml(meta)}</p>` : ''}
</td></tr></table>`;
  }
  return `${fieldRule(field.ink)}
${field.label ? `<p style="margin:10px 0 0;${monoStyle({ ...small, color: field.ink })}">${escapeHtml(field.label)}</p>` : ''}
<h3 style="margin:${field.label ? 7 : 10}px 0 8px;font:600 19px/1.25 ${EMAIL_FONTS.serif};color:${EMAIL_PALETTE.ink}">${storyLink(paper, `color:${EMAIL_PALETTE.ink};text-decoration:none`)}</h3>
<p style="margin:0;font:400 13px/1.5 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(paperByline(paper))}</p>
${meta ? `<p style="margin:5px 0 0;${monoStyle({ ...small, tracking: '0.04em' })}">${escapeHtml(meta)}</p>` : ''}
<p style="margin:5px 0 0;${monoStyle({ ...small, tracking: '0.04em' })}">${escapeHtml(paperReason(paper))}</p>`;
}

// Two columns of briefs; a phone stacks them (the media query in the head).
function renderBriefs(papers: DigestPaper[]) {
  const rows = [];
  for (let index = 0; index < papers.length; index += 2) {
    const [first, second] = papers.slice(index, index + 2);
    if (index > 0) {
      rows.push(`<tr><td colspan="2" style="border-top:1px solid ${EMAIL_PALETTE.rule};height:20px;font-size:0;line-height:0">&nbsp;</td></tr>`);
    }
    rows.push(`<tr>
<td class="pt-col" width="50%" valign="top" style="width:50%;padding:0 16px 22px 0">${renderBrief(first)}</td>
${second
    ? `<td class="pt-col pt-col-second" width="50%" valign="top" style="width:50%;padding:0 0 22px 16px;border-left:1px solid ${EMAIL_PALETTE.rule}">${renderBrief(second)}</td>`
    : '<td class="pt-col" width="50%" style="width:50%;font-size:0">&nbsp;</td>'}
</tr>`);
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`;
}

function editionIndex(papers: DigestPaper[]) {
  const fields = [...new Set(papers.map(paper => paper.area).filter(area => Object.hasOwn(FIELD_INKS, area || '')))];
  return [
    escapeHtml(EMAIL_COPY.paperCount(papers.length)),
    ...fields.map(area => `<span style="color:${FIELD_INKS[area as keyof typeof FIELD_INKS]}">${escapeHtml(CATEGORIES[area as keyof typeof FIELD_INKS].label)}</span>`),
  ].join('&nbsp;&nbsp;·&nbsp;&nbsp;');
}

/**
 * The weekly digest, set as the front page of a small newspaper in the app's
 * own language: a serif nameplate over a double rule, the strongest paper as
 * the lead story with an excerpt of its abstract, the rest as two columns of
 * briefs, and the exploration pick boxed apart. Each paper wears its field's
 * ink; one of no known field wears the brand ink and no field name.
 *
 * Tables and inline styles, because that is what mail clients render; the
 * one stylesheet only stacks the columns on a phone.
 */
function renderDigest(subscription: Subscription, papers: DigestPaper[], unsubscribeUrl: string, test: boolean, { now = Date.now() } = {}) {
  const firstName = cleanText(subscription?.displayName, 160).split(' ')[0];
  const edition = firstName ? EMAIL_COPY.editionFor(firstName) : EMAIL_COPY.edition;
  const dateline = editionDate(now);
  // collectDigestPapers ranks the followed papers first, the discovery last.
  const lead = papers[0] || null;
  const rest = papers.filter(paper => paper !== lead);
  const others = [...rest.filter(paper => !isDiscovery(paper)), ...rest.filter(isDiscovery)];
  const subject = test ? EMAIL_COPY.testSubject : digestSubject(lead, papers.length);
  const preheader = test
    ? EMAIL_COPY.testBody
    : truncateAtWord(
      others.map(paper => renderScientificText(paper.title)).join(' · ')
        || renderScientificExcerpt(lead?.abstract).text
        || EMAIL_COPY.standfirst,
      DIGEST_PREHEADER_MAX_LENGTH,
    );
  const ink = EMAIL_PALETTE.ink;

  const testNotice = test
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:22px 0 0">
<p style="margin:0;${monoStyle({ color: ink })}">${escapeHtml(EMAIL_COPY.testKicker)}</p>
<p style="margin:6px 0 0;font:400 15px/1.55 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(EMAIL_COPY.testBody)}</p>
</td></tr></table>`
    : '';
  const stories = lead
    ? `${renderLeadStory(lead)}${others.length
      ? `<h2 style="margin:0;padding:8px 0 18px;border-top:1px solid ${ink};${monoStyle({ size: 10.5, color: ink, tracking: '0.08em' })}">${escapeHtml(EMAIL_COPY.alsoInEdition)}</h2>${renderBriefs(others)}`
      : ''}`
    : `<p style="margin:0;padding:26px 0;font:400 15px/1.55 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.secondary}">${escapeHtml(EMAIL_COPY.empty)}</p>`;

  const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&amp;family=IBM+Plex+Mono:wght@500;600&amp;display=swap" rel="stylesheet">
<style>
@media (max-width:620px){
.pt-shell{padding:22px 18px 26px!important}
.pt-nameplate{font-size:34px!important}
.pt-lead{font-size:26px!important}
.pt-strip-cell{display:block!important;text-align:left!important;padding:0 0 6px!important}
.pt-col{display:block!important;width:auto!important;padding:0 0 20px!important;border-left:0!important}
.pt-col-second{border-top:1px solid ${EMAIL_PALETTE.rule}!important;padding-top:20px!important}
}
</style>
</head><body style="margin:0;padding:0;background:${EMAIL_PALETTE.page};color:${ink};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${EMAIL_PALETTE.page}"><tr><td align="center" style="padding:28px 10px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:${EMAIL_PALETTE.sheet};border:1px solid ${EMAIL_PALETTE.frame}"><tr><td class="pt-shell" style="padding:26px 36px 30px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${ink}"><tr>
<td class="pt-strip-cell" style="padding:0 0 9px;${monoStyle({ size: 10.5, color: ink, tracking: '0.08em' })}">${escapeHtml(dateline)}</td>
<td class="pt-strip-cell" align="right" style="padding:0 0 9px;${monoStyle({ size: 10.5, tracking: '0.08em' })}">${escapeHtml(edition)}</td>
</tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:22px 0 6px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle" style="padding-right:14px"><div aria-hidden="true" style="width:38px;height:38px;background:${EMAIL_PALETTE.brand};border-radius:3px;box-shadow:3px 3px 0 ${ink};text-align:center;font:600 16px/38px ${EMAIL_FONTS.mono};color:${ink}">PT</div></td>
<td valign="middle"><h1 class="pt-nameplate" style="margin:0;font:600 48px/1 ${EMAIL_FONTS.serif};letter-spacing:-0.03em;color:${ink}">${escapeHtml(EMAIL_COPY.nameplate)}</h1></td>
</tr></table>
</td></tr>
<tr><td align="center" style="padding:6px 0 14px;font:italic 400 15px/1.4 ${EMAIL_FONTS.serif};color:${EMAIL_PALETTE.secondary}">${escapeHtml(EMAIL_COPY.standfirst)}</td></tr>
</table>
<div style="border-top:3px double ${ink};height:0;line-height:0;font-size:0">&nbsp;</div>
${papers.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-bottom:1px solid ${EMAIL_PALETTE.frame}"><tr><td align="center" style="padding:9px 0;${monoStyle({ size: 10.5, color: EMAIL_PALETTE.secondary, tracking: '0.08em' })}">${editionIndex(papers)}</td></tr></table>` : ''}
${testNotice}
${stories}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:3px double ${ink}">
<tr><td style="padding:20px 0 0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${ink};border-radius:3px"><a href="${PAPER_TOK_URL}" style="display:inline-block;padding:12px 20px;font:600 14px/1 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.sheet};text-decoration:none">${escapeHtml(EMAIL_COPY.openInbox)}</a></td></tr></table></td></tr>
<tr><td style="padding:22px 0 0;${monoStyle({ size: 10.5, tracking: '0.05em' })}">${escapeHtml(EMAIL_COPY.colophon)}</td></tr>
<tr><td style="padding:6px 0 0;font:400 12px/1.6 ${EMAIL_FONTS.sans};color:${EMAIL_PALETTE.tertiary}">${escapeHtml(EMAIL_COPY.footer)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:${EMAIL_PALETTE.secondary};text-decoration:underline">${escapeHtml(EMAIL_COPY.unsubscribe)}</a>.</td></tr>
</table>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const storyText = (paper: DigestPaper, { isLead = false } = {}) => {
    const lines = [textKicker(paper), renderScientificText(paper.title)];
    if (isLead) {
      const excerpt = renderScientificExcerpt(paper.abstract).text;
      if (excerpt) lines.push(excerpt);
    }
    lines.push(paperByline(paper, { lead: isLead }));
    const meta = paperMeta(paper);
    if (meta) lines.push(meta);
    lines.push(paper.url || PAPER_TOK_URL);
    return lines.join('\n');
  };
  const blocks = [
    `${EMAIL_COPY.nameplate.toUpperCase()}\n${dateline} · ${edition}`,
    ...(test ? [`${EMAIL_COPY.testKicker.toUpperCase()}\n${EMAIL_COPY.testBody}`] : []),
    ...(lead ? [storyText(lead, { isLead: true })] : [EMAIL_COPY.empty]),
    ...(others.length ? [EMAIL_COPY.alsoInEdition.toUpperCase(), ...others.map(paper => storyText(paper))] : []),
    `${EMAIL_COPY.openInbox}: ${PAPER_TOK_URL}\n${EMAIL_COPY.unsubscribe}: ${unsubscribeUrl}`,
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

async function sendWithBrevo(subscription: Subscription, content: DeliveryDraft['content'], unsubscribeUrl: string, env: WorkerEnv, { test = false, idempotencyKey }: { test?: boolean; idempotencyKey?: string } = {}) {
  const sender = resolveBrevoSender(env);
  const response = await fetchEmailProvider(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY!,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'PaperTok/1.0',
    },
    body: JSON.stringify({
      sender,
      to: [{
        email: subscription.email,
        ...(subscription.displayName ? { name: cleanText(subscription.displayName, 160) } : {}),
      }],
      subject: content.subject,
      htmlContent: content.html,
      textContent: content.text,
      headers: {
        idempotencyKey,
        // RFC 8058 one-click: Gmail and Yahoo score sender reputation on it, and
        // /notifications/unsubscribe already accepts a bodyless POST.
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      tags: [test ? 'papertok-test' : 'papertok-following-digest'],
    }),
  });
  const payload = await response.json<ProviderPayload>().catch((): ProviderPayload => ({}));
  if (!response.ok) {
    if (response.status === 400 && /duplicate_parameter/i.test(cleanText(
      `${payload?.code || ''} ${payload?.message || ''}`,
      500,
    ))) {
      return null;
    }
    const code = brevoSendErrorCode(response.status, payload);
    console.error('Brevo rejected digest', response.status, code);
    const error = new EmailNotificationError(code, response.status === 429 ? 429 : 502);
    error.deliveryRejected = providerOutcomeDefinitelyRejected(response.status);
    throw error;
  }
  return payload?.messageId || payload?.messageIds?.[0] || null;
}

async function sendWithResend(subscription: Subscription, content: DeliveryDraft['content'], unsubscribeUrl: string, env: WorkerEnv, { idempotencyKey }: { test?: boolean; idempotencyKey?: string } = {}) {
  const from = await resolveResendSender(env);
  const response = await fetchEmailProvider(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'user-agent': 'PaperTok/1.0',
      'idempotency-key': idempotencyKey!,
    },
    body: JSON.stringify({
      from,
      to: [subscription.email],
      subject: content.subject,
      html: content.html,
      text: content.text,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  const payload = await response.json<ProviderPayload>().catch((): ProviderPayload => ({}));
  if (!response.ok) {
    const code = resendSendErrorCode(response.status, payload);
    console.error('Resend rejected digest', response.status, code);
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

function buildDeliveryDraft(subscription: Subscription, papers: DigestPaper[], provider: string, env: WorkerEnv, {
  test = false,
  now = Date.now(),
  sourceReport = createSourceReport(),
}: SendOptions = {}) {
  const workerBase = cleanText(env.WORKER_PUBLIC_URL, 500)
    || 'https://api.papertok.app';
  const unsubscribeUrl = `${workerBase}/notifications/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken!)}`;
  return {
    provider,
    recipient: {
      email: subscription.email,
      displayName: subscription.displayName,
    },
    content: renderDigest(subscription, papers, unsubscribeUrl, test, { now }),
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
  test = false,
  ledgerTime = now,
}: { test?: boolean; ledgerTime?: number } = {}): Promise<DeliveryOutcome> {
  const idempotencyKey = reservationId;
  let providerId;
  try {
    providerId = draft.provider === 'brevo'
      ? await sendWithBrevo(draft.recipient, draft.content, draft.unsubscribeUrl, env, { test, idempotencyKey })
      : await sendWithResend(
        draft.recipient,
        draft.content,
        draft.unsubscribeUrl,
        env,
        { test, idempotencyKey },
      );
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
  const draft = buildDeliveryDraft(latest, currentPapers, provider, env, {
    test,
    now,
    sourceReport,
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
  return deliverReservedDraft(env, reservationId, reservedDraft, now, { test });
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
 * The page an unsubscribe link opens, set on the digest's own paper: its
 * masthead in miniature over the double rule, a mono kicker, a serif headline,
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
  const provider = requestedEmailProvider(env);
  if (!configuredEmailProvider(env)) {
    return { configured: false, available: false, provider: provider || null, code: 'EMAIL_NOT_CONFIGURED' };
  }

  if (provider === 'brevo') {
    try {
      const response = await fetchWithDeadline(`${BREVO_API}/senders`, {
        headers: {
          'api-key': env.BREVO_API_KEY!,
          accept: 'application/json',
          'user-agent': 'PaperTok/1.0',
        },
      }, EMAIL_HEALTH_TIMEOUT_MS);
      if (response.status === 401 || response.status === 403) {
        return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_AUTH_FAILED' };
      }
      if (!response.ok) {
        return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
      }
      const payload = await response.json<{ senders?: Array<{ active?: boolean; email?: string }> }>().catch(() => ({} as { senders?: Array<{ active?: boolean; email?: string }> }));
      const senderEmail = cleanText(env.BREVO_FROM_EMAIL, 320).toLowerCase();
      const activeSender = (payload?.senders || []).some(sender => (
        sender?.active && cleanText(sender.email, 320).toLowerCase() === senderEmail
      ));
      if (!activeSender) {
        return { configured: true, available: false, provider, code: 'EMAIL_SENDER_NOT_VERIFIED' };
      }
      return {
        configured: true,
        available: true,
        provider,
        senderMode: 'brevo-verified-sender',
        permissionLimited: false,
      };
    } catch {
      return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
    }
  }

  try {
    const response = await fetchWithDeadline(`${RESEND_API}/domains?limit=1`, {
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
      // name "restricted_api_key". That is a VALID credential — the provider is
      // available, just permission-limited — so we must not report it as an
      // auth failure. See https://resend.com/docs/api-reference/errors
      // Status alone is not enough: a bare 401/403 without this marker means a
      // genuinely rejected key (revoked, suspended, blocked) and must fail closed.
      const isRestrictedKey = errorPayload?.name === 'restricted_api_key'
        || /restricted/i.test(errorPayload?.message || '');
      if (isRestrictedKey) {
        return {
          configured: true,
          available: true,
          provider,
          senderMode: env.RESEND_FROM_EMAIL ? 'verified-domain' : 'resend-test',
          permissionLimited: true,
        };
      }
      console.warn('Resend health probe rejected', response.status, errorPayload?.name || 'unknown');
      return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_AUTH_FAILED' };
    }
    if (!response.ok) return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
    const payload = await response.json<{ data?: Array<{ status?: string }> }>().catch(() => ({} as { data?: Array<{ status?: string }> }));
    const verified = (payload?.data || []).some(domain => domain.status === 'verified');
    return {
      configured: true,
      available: true,
      provider,
      senderMode: env.RESEND_FROM_EMAIL || verified ? 'verified-domain' : 'resend-test',
    };
  } catch {
    return { configured: true, available: false, provider, code: 'EMAIL_PROVIDER_UNAVAILABLE' };
  }
}

// Monday's weekly digest may be retried on Tuesday, and only on Tuesday, when
// this week's last attempt failed because the sources were unavailable. That
// failure is raised while papers are collected, before any delivery is
// reserved, so no email can stand behind it. A send failure may have been
// delivered, a send this week was delivered, and a failure from an earlier week
// is not this week's digest: none of them starts a new digest before next
// Monday. Wednesday remains recovery-only for Tuesday's reservations. A
// failure stamped after `now` is not a failure of this week's past.
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

// Monday, whatever frequency the record stored: see DIGEST_FREQUENCY.
function isSubscriptionCalendarDue(subscription: Subscription, now: Date) {
  if (!subscription?.enabled) return false;
  const lastSent = Date.parse((subscription.lastSentAt || 0) as string);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return (now.getUTCDay() === 1 && (!lastSent || lastSent < dayStart))
    || isWeeklySourceFailureRetry(subscription, now, dayStart);
}

function isSubscriptionDue(subscription: Subscription, now: Date) {
  if (!isSubscriptionCalendarDue(subscription, now)) return false;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastDeliveryAt = Date.parse((subscription.lastDelivery?.at || 0) as string);
  if (!Number.isFinite(lastDeliveryAt) || lastDeliveryAt < dayStart) return true;
  const elapsed = now.getTime() - lastDeliveryAt;
  if (subscription.lastDelivery?.status === 'invalid') return false;
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
}: StatusOptions = {}) {
  return updateDeliveryState(env, key, subscription, () => ({
    lastCheckedAt: at,
    lastDelivery: lastDeliveryStatus(status, at, {
      code,
      paperCount,
      partial,
      sourceReport,
    }),
  }));
}

async function persistScheduledDelivery(env: WorkerEnv, key: string, subscription: Subscription, delivery: DeliveryOutcome): Promise<ScheduledOutcome> {
  const status = delivery.uncertain ? 'uncertain' : delivery.reconciled ? 'reconciled' : 'sent';
  const updated = await updateDeliveryState(
    env,
    key,
    subscription,
    state => deliveryStatePatch(state, delivery.delivery!, status),
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
    await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code });
    return { invalid: true, failureCodes: { [code]: 1 } };
  }
  let sourceReport;
  try {
    const resumed = await resumeScheduledDelivery(subscription, env, {
      now: now.getTime(),
      key: key.name,
    });
    if (resumed) {
      if (resumed.invalid) {
        const code = 'EMAIL_SUBSCRIPTION_INVALID';
        await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code });
        return { invalid: true, failureCodes: { [code]: 1 } };
      }
      if (resumed.pending || resumed.cancelled) return { skipped: true };
      return persistScheduledDelivery(env, key.name, subscription, resumed);
    }

    if (!isSubscriptionDue(subscription, now) || !allowsNewScheduledDelivery(now)) {
      return { skipped: true };
    }

    const collected = await collectDigestPapers(subscription, env, {
      now: now.getTime(),
      openAlexRequests,
    });
    sourceReport = collected.sourceReport;
    if (!collected.papers.length) {
      await recordSubscriptionOutcome(env, key.name, subscription, 'empty', checkedAt, { sourceReport });
      return {
        empty: true,
        partial: false,
        sources: compactSourceReport(sourceReport),
        failureCodes: failureCodeCounts(sourceReport),
      };
    }

    const delivery = await sendDigest(subscription, collected.papers, env, {
      now: now.getTime(),
      key: key.name,
      sourceReport,
    });
    if (delivery.pending) return { skipped: true, sources: compactSourceReport(sourceReport) };
    if (delivery.invalid) {
      const code = 'EMAIL_SUBSCRIPTION_INVALID';
      await recordSubscriptionOutcome(env, key.name, subscription, 'invalid', checkedAt, { code, sourceReport });
      return {
        invalid: true,
        sources: compactSourceReport(sourceReport),
        failureCodes: failureCodeCounts(sourceReport, code),
      };
    }
    if (delivery.cancelled) return { skipped: true, sources: compactSourceReport(sourceReport) };
    return persistScheduledDelivery(env, key.name, subscription, delivery);
  } catch (error) {
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
        { code, sourceReport },
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
  if (!env.NOTIFICATION_STORE || !provider || ledgerMissing) {
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
      disabled: true,
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
  brevoSendErrorCode,
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
  fieldInks: FIELD_INKS,
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
