import { XMLParser } from 'fast-xml-parser';
import { filterRelevantQueryTopicPapers } from '../src/utils/queryTopicSearch.js';
import { applyEmailDeliveryLedgerAction } from './email-delivery-ledger.js';

const SUBSCRIPTION_PREFIX = 'notification:subscription:';
const DELIVERY_STATE_PREFIX = 'notification:delivery-state:';
const UNSUBSCRIBE_PREFIX = 'notification:unsubscribe:';
const BREVO_API = 'https://api.brevo.com/v3';
const RESEND_API = 'https://api.resend.com';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const PAPER_TOK_URL = 'https://papertok.app/#/following';
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
const SCHEDULE_HISTORY_TTL_SECONDS = 14 * 24 * 60 * 60;
const DELIVERY_LEDGER_TTL_SECONDS = 3 * 24 * 60 * 60;
const DELIVERY_STATE_TTL_SECONDS = 120 * 24 * 60 * 60;
const DELIVERY_PENDING_RETRY_MIN_AGE_MS = 5 * 60 * 1000;
const DELIVERY_PENDING_RETRY_WINDOW_MS = 25 * 60 * 1000;
const DIGEST_SOURCE_MAX_ATTEMPTS = 2;
const DIGEST_SOURCE_TIMEOUT_MS = 5_000;
const DIGEST_SOURCE_RETRY_MAX_DELAY_MS = 1_000;
const EMAIL_PROVIDER_TIMEOUT_MS = 12_000;
const EMAIL_IDENTITY_TIMEOUT_MS = 8_000;
const EMAIL_HEALTH_TIMEOUT_MS = 8_000;
const SCHEDULE_PROCESSING_BUDGET_MS = 12 * 60 * 1000;
const SCHEDULE_MIN_BATCH_REMAINING_MS = 3 * 60 * 1000;
const SCHEDULE_PAGE_SIZE = 3;
const EMPTY_RETRY_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FAILURE_RETRY_INTERVAL_MS = 40 * 60 * 1000;
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
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = 'EmailNotificationError';
    this.code = code;
    this.status = status;
  }
}

export class EmailDigestTransientError extends EmailNotificationError {
  constructor(sourceReport) {
    super('EMAIL_DIGEST_SOURCES_UNAVAILABLE', 503);
    this.name = 'EmailDigestTransientError';
    this.transient = true;
    this.sourceReport = sourceReport;
  }
}

class DigestSourceError extends Error {
  constructor(source, code, message = code) {
    super(message);
    this.name = 'DigestSourceError';
    this.source = source;
    this.code = code;
    this.transient = true;
  }
}

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function readBoundedJson(request, maximumBytes = MAX_PREFERENCES_REQUEST_BYTES) {
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new EmailNotificationError('EMAIL_REQUEST_TOO_LARGE', 413);
  }
  let bytes;
  if (request.body?.getReader) {
    const reader = request.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > maximumBytes) {
          await reader.cancel();
          throw new EmailNotificationError('EMAIL_REQUEST_TOO_LARGE', 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const fallbackBytes = new TextEncoder().encode(await request.text());
    if (fallbackBytes.byteLength > maximumBytes) {
      throw new EmailNotificationError('EMAIL_REQUEST_TOO_LARGE', 413);
    }
    bytes = fallbackBytes;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new EmailNotificationError('EMAIL_INVALID_REQUEST', 400);
  }
}

function escapeHtml(value) {
  return cleanText(value, 5_000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const EMAIL_LATEX_DELIMITERS = [
  { left: '$$', right: '$$' },
  { left: '\\[', right: '\\]' },
  { left: '\\(', right: '\\)' },
  { left: '$', right: '$' },
];

const EMAIL_LATEX_SYMBOLS = {
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

function isEscaped(text, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor -= 1) slashCount += 1;
  return slashCount % 2 === 1;
}

function findEmailLatexDelimiter(text, startIndex) {
  let next = null;
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

function splitEmailScientificText(value) {
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

function simplifyEmailLatex(value) {
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

function renderEmailMath(value) {
  const expression = simplifyEmailLatex(value);
  let html = '';
  let plain = '';
  let cursor = 0;

  const appendText = (text) => {
    html += escapeHtml(text);
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
    html += `<${tag}>${escapeHtml(token)}</${tag}>`;
    plain += `${marker}${token}`;
  }

  return { html, plain };
}

function renderScientificHtml(value) {
  return splitEmailScientificText(value).map((chunk) => {
    if (chunk.type === 'text') return escapeHtml(chunk.value);
    return `<span style="font-family:Arial,sans-serif;white-space:nowrap">${renderEmailMath(chunk.value).html}</span>`;
  }).join('');
}

function renderScientificText(value) {
  return splitEmailScientificText(value).map(chunk => (
    chunk.type === 'text' ? cleanText(chunk.value, 5_000) : renderEmailMath(chunk.value).plain
  )).join('');
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeId(value) {
  return cleanText(value, 300)
    .replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, '')
    .replace(/^https?:\/\/ror\.org\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

function isOpaqueQueryText(value) {
  return /^query(?:-|$)/i.test(cleanText(value, 300));
}

function isQueryTopicId(value) {
  return /^query-[a-f0-9]{8}$/i.test(normalizeId(value));
}

function topicSearchQuery(follow = {}) {
  const storedQuery = cleanText(follow.metadata?.query, 180);
  if (storedQuery && !isOpaqueQueryText(storedQuery)) return storedQuery;
  const displayName = cleanText(follow.displayName, 200);
  return displayName && !isOpaqueQueryText(displayName) ? displayName : '';
}

function normalizePaperTitle(value) {
  return cleanText(value, 500)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizePaperAuthor(value) {
  return cleanText(value, 160)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sanitizeFollow(input = {}) {
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
    type,
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

function normalizePaperDoi(value) {
  return cleanText(value, 300).toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
}

function paperWorkKey(paper = {}) {
  const title = normalizePaperTitle(paper.title);
  const firstAuthor = normalizePaperAuthor(paper.authors?.[0]?.name || paper.authors?.[0]);
  return title && firstAuthor ? `work:${title}|${firstAuthor}` : '';
}

function paperIdentityKeys(paper = {}) {
  const doi = normalizePaperDoi(paper.doi);
  const id = cleanText(paper.id, 300).toLowerCase();
  return [...new Set([
    doi ? `doi:${doi}` : '',
    paperWorkKey(paper),
    id ? `id:${id}` : '',
  ].filter(Boolean))];
}

function paperKey(paper = {}) {
  const identities = paperIdentityKeys(paper);
  return identities[0] || `title:${normalizePaperTitle(paper.title)}`;
}

function sanitizePaper(input = {}) {
  const title = cleanText(input.title, 500);
  if (!title) return null;
  const authors = Array.isArray(input.authors)
    ? input.authors.map(author => cleanText(author?.name || author?.display_name || author, 120)).filter(Boolean).slice(0, 6)
    : [];
  const matches = Array.isArray(input._followedEntityMatches || input.matches)
    ? (input._followedEntityMatches || input.matches).map(sanitizeFollow).filter(Boolean).slice(0, 4)
    : [];
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
  };
}

function sanitizePreferences(input = {}) {
  const frequency = input.frequency === 'weekly' ? 'weekly' : 'daily';
  const requestedMax = Number(input.maxPapers);
  const maxPapers = [3, 5, 10].includes(requestedMax) ? requestedMax : 5;
  return {
    enabled: Boolean(input.enabled),
    frequency,
    maxPapers,
    language: input.language === 'en' ? 'en' : 'es',
  };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function createSourceReport() {
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

function sourceCodeName(source) {
  return cleanText(source, 40).toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'UNKNOWN';
}

function sourceBucket(report, source) {
  if (!report) return null;
  report.bySource[source] ||= { attempted: 0, succeeded: 0, failed: 0 };
  return report.bySource[source];
}

function recordSourceFailure(report, source, code) {
  if (!report) return;
  report.failed += 1;
  sourceBucket(report, source).failed += 1;
  report.failureCodes[code] = (report.failureCodes[code] || 0) + 1;
}

function digestSourceError(source, error) {
  if (error instanceof DigestSourceError) return error;
  return new DigestSourceError(
    source,
    `EMAIL_SOURCE_${sourceCodeName(source)}_INVALID_RESPONSE`,
    error?.message,
  );
}

function retryDelayMs(response, attempt) {
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

function wait(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function fetchDigestSource(input, init, {
  source,
  report,
  timeoutMs = DIGEST_SOURCE_TIMEOUT_MS,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < DIGEST_SOURCE_MAX_ATTEMPTS; attempt += 1) {
    if (report) {
      report.requestAttempts += 1;
      if (attempt > 0) report.retried += 1;
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
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      lastError = new DigestSourceError(
        source,
        `EMAIL_SOURCE_${sourceCodeName(source)}_${timedOut ? 'TIMEOUT' : 'UNAVAILABLE'}`,
        error?.message,
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

async function trackDigestSource(report, source, operation) {
  if (report) {
    report.attempted += 1;
    sourceBucket(report, source).attempted += 1;
  }
  try {
    const result = await operation();
    if (report) {
      report.succeeded += 1;
      sourceBucket(report, source).succeeded += 1;
    }
    return result;
  } catch (error) {
    const sourceError = digestSourceError(source, error);
    recordSourceFailure(report, source, sourceError.code);
    throw sourceError;
  }
}

function isArxivCategory(value) {
  const category = cleanText(value, 80);
  if (!/^[a-z-]+(?:\.[A-Za-z-]+)?$/.test(category)) return false;
  return ARXIV_CATEGORY_PREFIXES.some(prefix => (
    category === prefix || category.startsWith(`${prefix}.`)
  ));
}

function arxivCategoriesForFollow(follow = {}) {
  const metadataCategories = Array.isArray(follow.metadata?.categoryIds)
    ? follow.metadata.categoryIds
    : [];
  const candidates = metadataCategories.length ? metadataCategories : [follow.canonicalId];
  return [...new Set(candidates.map(category => cleanText(category, 80)).filter(isArxivCategory))];
}

function parseArxivDigestFeed(xml, follows = []) {
  const parsed = ARXIV_XML_PARSER.parse(String(xml || ''));
  const entries = asArray(parsed?.feed?.entry);
  const followsByCategory = new Map();

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
    });
  }).filter(Boolean);
}

async function fetchArxivTopicUpdates(follows, sourceReport) {
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
 * address would otherwise subscribe a stranger's inbox to the daily digest.
 * Firebase does not always flag federated sign-ins as verified, so an identity
 * provider that vouched for the same address counts as proof of possession.
 */
function accountOwnsEmail(account) {
  if (account?.emailVerified === true) return true;
  const email = cleanText(account?.email, 320).toLowerCase();
  return (account?.providerUserInfo || []).some(provider => (
    TRUSTED_EMAIL_PROVIDERS.has(cleanText(provider?.providerId, 40).toLowerCase())
    && cleanText(provider?.email, 320).toLowerCase() === email
  ));
}

async function verifyFirebaseIdentity(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new EmailNotificationError('EMAIL_AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);

  const response = await fetchWithDeadline(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  }, EMAIL_IDENTITY_TIMEOUT_MS);
  const payload = await response.json().catch(() => ({}));
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

function publicSubscription(subscription, email) {
  return {
    enabled: Boolean(subscription?.enabled),
    frequency: subscription?.frequency || 'daily',
    maxPapers: subscription?.maxPapers || 5,
    language: subscription?.language === 'en' ? 'en' : 'es',
    email,
    lastSentAt: subscription?.lastSentAt || null,
    lastTestAt: subscription?.lastTestAt || null,
  };
}

const DELIVERY_STATE_FIELDS = [
  'lastCheckedAt',
  'lastSentAt',
  'lastTestAt',
  'sentPaperKeys',
  'lastDelivery',
  'lastTestDelivery',
];

function deliveryStateKey(subscriptionKey, subscription) {
  const uid = String(subscriptionKey || '').startsWith(SUBSCRIPTION_PREFIX)
    ? String(subscriptionKey).slice(SUBSCRIPTION_PREFIX.length)
    : String(subscriptionKey || '');
  const stateId = cleanText(subscription?.stateId, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  return stateId
    ? `${DELIVERY_STATE_PREFIX}${uid}:${stateId}`
    : `${DELIVERY_STATE_PREFIX}${uid}`;
}

function deliveryStateFromSubscription(subscription = {}) {
  return Object.fromEntries(DELIVERY_STATE_FIELDS
    .filter(field => subscription?.[field] !== undefined)
    .map(field => [field, subscription[field]]));
}

function stripDeliveryState(subscription = {}) {
  const clean = { ...subscription };
  DELIVERY_STATE_FIELDS.forEach(field => { delete clean[field]; });
  return clean;
}

function subscriptionGeneration(subscription = {}) {
  const stateId = cleanText(subscription.stateId, 80);
  if (stateId) return `state:${stateId}`;
  return `legacy:${cleanText(
    subscription.unsubscribeToken || subscription.createdAt || subscription.uid,
    200,
  )}`;
}

async function loadSubscriptionRecord(env, key) {
  const subscription = await env.NOTIFICATION_STORE.get(key, 'json');
  if (!subscription) return null;
  const stateKey = deliveryStateKey(key, subscription);
  const state = await env.NOTIFICATION_STORE.get(stateKey, 'json');
  return { subscription, state, stateKey };
}

async function loadSubscriptionWithState(env, key) {
  const record = await loadSubscriptionRecord(env, key);
  if (!record) return null;
  return {
    ...record.subscription,
    ...deliveryStateFromSubscription(record.subscription),
    ...(record.state || {}),
  };
}

async function updateDeliveryState(env, key, expectedSubscription, buildPatch) {
  const subscription = await env.NOTIFICATION_STORE.get(key, 'json');
  if (!subscription) return null;
  if (
    expectedSubscription
    && subscriptionGeneration(subscription) !== subscriptionGeneration(expectedSubscription)
  ) {
    return null;
  }
  const stateKey = deliveryStateKey(key, subscription);
  const storedState = await env.NOTIFICATION_STORE.get(stateKey, 'json');
  const currentState = {
    ...deliveryStateFromSubscription(subscription),
    ...(storedState || {}),
  };
  const mergedState = { ...currentState, ...buildPatch(currentState, subscription) };
  await env.NOTIFICATION_STORE.put(stateKey, JSON.stringify(mergedState), {
    expirationTtl: DELIVERY_STATE_TTL_SECONDS,
  });
  return { ...subscription, ...mergedState };
}

async function deleteSubscription(env, uid, subscription) {
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
export async function purgeEmailSubscription(env, uid) {
  if (!env?.NOTIFICATION_STORE || !uid) return { purged: false };
  const key = `${SUBSCRIPTION_PREFIX}${uid}`;
  const subscription = await env.NOTIFICATION_STORE.get(key, 'json');
  await Promise.all([
    env.NOTIFICATION_STORE.delete(key),
    env.NOTIFICATION_STORE.delete(deliveryStateKey(uid, subscription || { uid })),
    subscription?.unsubscribeToken
      ? env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${subscription.unsubscribeToken}`)
      : Promise.resolve(),
  ]);
  return { purged: true };
}

async function saveSubscription(request, env, identity) {
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
    ...(existingRecord.state || {}),
  } : null;

  if (!preferences.enabled) {
    await deleteSubscription(env, identity.uid, existing);
    return publicSubscription(null, identity.email);
  }

  const follows = Array.isArray(body.follows)
    ? body.follows.map(sanitizeFollow).filter(Boolean).slice(0, MAX_FOLLOWS)
    : [];
  const previewItems = Array.isArray(body.previewItems)
    ? body.previewItems.map(sanitizePaper).filter(Boolean).slice(0, MAX_PREVIEW_ITEMS)
    : [];
  if (!follows.length) {
    throw new EmailNotificationError('EMAIL_FOLLOWS_REQUIRED', 409);
  }
  const unsubscribeToken = existing?.unsubscribeToken || crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const persistedBase = existingRecord?.state
    ? stripDeliveryState(existingRaw)
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

function addOpenAlexCredentials(url, env) {
  url.searchParams.set('mailto', 'app@papertok.io');
  if (env.OPENALEX_API_KEY) url.searchParams.set('api_key', env.OPENALEX_API_KEY);
  return url;
}

function mapOpenAlexPaper(work, follow) {
  const doi = cleanText(work?.doi, 300).replace(/^https?:\/\/doi\.org\//i, '');
  return sanitizePaper({
    id: normalizeId(work?.id) || doi,
    doi,
    title: work?.display_name || work?.title,
    authors: (work?.authorships || []).map(authorship => authorship?.author?.display_name).filter(Boolean),
    published: work?.publication_date,
    journal: work?.primary_location?.source?.display_name,
    citationCount: work?.cited_by_count,
    openAccess: work?.open_access?.is_oa,
    landingPageUrl: work?.best_oa_location?.landing_page_url || work?.primary_location?.landing_page_url,
    _followedEntityMatches: follow ? [follow] : [],
  });
}

function reconstructOpenAlexAbstract(index = {}) {
  const words = [];
  Object.entries(index || {}).forEach(([word, positions]) => {
    (positions || []).forEach(position => { words[position] = word; });
  });
  return words.filter(Boolean).join(' ');
}

function openAlexWorkForTopicRelevance(work = {}) {
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

async function fetchOpenAlexUpdates(follow, env, now = Date.now(), sourceReport) {
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
    const response = await fetchDigestSource(url, { headers: { accept: 'application/json' } }, {
      source: 'openalex',
      report: sourceReport,
    });
    const payload = await response.json();
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

async function fetchExplorationUpdates(env, now = Date.now(), sourceReport) {
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
    const response = await fetchDigestSource(url, { headers: { accept: 'application/json' } }, {
      source: 'openalex',
      report: sourceReport,
    });
    const payload = await response.json();
    return (payload?.results || []).map(work => mapOpenAlexPaper(work, null)).filter(Boolean);
  });
}

async function fetchProjectUpdates(follow, env, sourceReport) {
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
    return response.json();
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
    const openAlexResponse = await fetchDigestSource(
      openAlexUrl,
      { headers: { accept: 'application/json' } },
      { source: 'openalex', report: sourceReport },
    );
    const openAlexPayload = await openAlexResponse.json();
    return (openAlexPayload?.results || []).map(work => mapOpenAlexPaper(work, follow)).filter(Boolean);
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
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

function publicationTime(paper) {
  const value = Date.parse(paper.published || '');
  return Number.isFinite(value) ? value : 0;
}

function mergePaperRecords(current, paper) {
  const matches = [...(current.matches || []), ...(paper.matches || [])];
  return {
    ...current,
    ...paper,
    id: current.id || paper.id,
    doi: current.doi || paper.doi,
    title: current.title?.length >= (paper.title?.length || 0) ? current.title : paper.title,
    authors: current.authors?.length >= (paper.authors?.length || 0) ? current.authors : paper.authors,
    published: current.published || paper.published,
    journal: current.journal || paper.journal,
    url: current.url || paper.url,
    openAccess: Boolean(current.openAccess || paper.openAccess),
    citationCount: Math.max(current.citationCount || 0, paper.citationCount || 0),
    matches: matches.filter((match, index) => matches.findIndex(candidate => (
      candidate.type === match.type && candidate.canonicalId === match.canonicalId
    )) === index),
  };
}

function mergePapers(papers) {
  const mergedByIdentity = new Map();
  papers.filter(Boolean).forEach((paper) => {
    const identityKeys = paperIdentityKeys(paper);
    const existingRecords = [...new Set(identityKeys
      .map(key => mergedByIdentity.get(key))
      .filter(Boolean))];
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

function digestPaperScore(paper, now = Date.now()) {
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

function getPaperFollowKeys(paper = {}) {
  return [...new Set((paper.matches || []).map(match => (
    `${match.type}:${match.canonicalId}`
  )))];
}

function sharesFollow(left, right) {
  const rightKeys = new Set(getPaperFollowKeys(right));
  return getPaperFollowKeys(left).some(key => rightKeys.has(key));
}

function blockedFollowKeys(selected) {
  if (selected.length < 2) return new Set();
  const previous = new Set(getPaperFollowKeys(selected.at(-1)));
  const beforePrevious = new Set(getPaperFollowKeys(selected.at(-2)));
  return new Set([...previous].filter(key => beforePrevious.has(key)));
}

function selectDigestPapers(papers, {
  limit = 5,
  now = Date.now(),
  exploration = false,
  excludedKeys = [],
} = {}) {
  const excluded = excludedKeys instanceof Set ? excludedKeys : new Set(excludedKeys);
  const minimumScore = exploration ? EXPLORATION_PAPER_MIN_SCORE : FOLLOWED_PAPER_MIN_SCORE;
  const ranked = mergePapers(papers)
    .filter(paper => !paperIdentityKeys(paper).some(key => excluded.has(key)))
    .filter(paper => exploration ? !(paper.matches || []).length : (paper.matches || []).length > 0)
    .map(paper => ({ paper, score: digestPaperScore(paper, now) }))
    .filter(candidate => (
      Number.isFinite(candidate.score)
      && candidate.score >= minimumScore
      && (!exploration || candidate.paper.citationCount >= EXPLORATION_MIN_CITATIONS)
    ))
    .sort((left, right) => (
      right.score - left.score
      || publicationTime(right.paper) - publicationTime(left.paper)
      || paperKey(left.paper).localeCompare(paperKey(right.paper))
    ));

  if (exploration) return ranked.slice(0, Math.max(0, limit)).map(candidate => candidate.paper);

  const selected = [];
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

function digestFollowsForWindow(follows, now = Date.now()) {
  const allFollows = Array.isArray(follows) ? follows : [];
  if (allFollows.length <= MAX_QUERIED_FOLLOWS) return allFollows;
  const dayIndex = Math.floor(now / DAY_MS);
  const offset = dayIndex % allFollows.length;
  return allFollows.slice(offset).concat(allFollows.slice(0, offset)).slice(0, MAX_QUERIED_FOLLOWS);
}

async function collectDigestPapers(subscription, env, { test = false, now = Date.now() } = {}) {
  const follows = digestFollowsForWindow(subscription.follows, now);
  const sourceReport = createSourceReport();
  if (!follows.length) return { papers: [], sourceReport };
  const arxivFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length > 0);
  const indexedFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length === 0);
  const indexedFreshPromise = mapWithConcurrency(indexedFollows, 4, follow => (
    follow.type === 'project'
      ? fetchProjectUpdates(follow, env, sourceReport)
      : fetchOpenAlexUpdates(follow, env, now, sourceReport)
  ));
  const arxivFreshPromise = (async () => {
    if (!arxivFollows.length) return { papers: [], requiredFailed: 0 };
    try {
      return {
        papers: await fetchArxivTopicUpdates(arxivFollows, sourceReport),
        requiredFailed: 0,
      };
    } catch (error) {
      console.warn('arXiv digest unavailable, using OpenAlex fallback', error?.code || 'EMAIL_SOURCE_ARXIV_UNAVAILABLE');
      const fallbackResults = await mapWithConcurrency(
        arxivFollows,
        2,
        follow => fetchOpenAlexUpdates(follow, env, now, sourceReport),
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
  const sentKeys = test ? new Set() : new Set(subscription.sentPaperKeys || []);
  const followedSelection = selectDigestPapers(
    combined.filter(paper => publicationTime(paper) >= cutoff),
    { limit: maximum, now, excludedKeys: sentKeys },
  );
  let discovery = [];
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
      const exploration = await fetchExplorationUpdates(env, now, sourceReport);
      discovery = selectDigestPapers(exploration, {
        limit: 1,
        now,
        exploration: true,
        excludedKeys: selectedKeys,
      });
    } catch (error) {
      console.warn('Digest exploration unavailable', error?.code || 'EMAIL_SOURCE_OPENALEX_UNAVAILABLE');
    }
  }
  const papers = [...followedSelection, ...discovery].slice(0, maximum);
  if (!papers.length && sourceReport.requiredFailed > 0) {
    throw new EmailDigestTransientError(sourceReport);
  }
  return { papers, sourceReport };
}

function requestedEmailProvider(env) {
  const requested = cleanText(env.EMAIL_PROVIDER, 20).toLowerCase();
  if (requested === 'brevo' || requested === 'resend') return requested;
  if (env.BREVO_API_KEY) return 'brevo';
  if (env.RESEND_API_KEY) return 'resend';
  return '';
}

function configuredEmailProvider(env) {
  const provider = requestedEmailProvider(env);
  if (provider === 'brevo' && env.BREVO_API_KEY && env.BREVO_FROM_EMAIL) return provider;
  if (provider === 'resend' && env.RESEND_API_KEY) return provider;
  return '';
}

function resolveBrevoSender(env) {
  return {
    name: cleanText(env.BREVO_FROM_NAME, 70) || 'PaperTok',
    email: cleanText(env.BREVO_FROM_EMAIL, 320),
  };
}

async function resolveResendSender(env) {
  if (env.RESEND_FROM_EMAIL) return cleanText(env.RESEND_FROM_EMAIL, 320);
  return 'PaperTok <onboarding@resend.dev>';
}

const kvDeliveryLedgerLocks = new WeakMap();

function utcDay(now = Date.now()) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dailySendLimit(env) {
  const configuredLimit = Number(env.EMAIL_DAILY_SEND_LIMIT);
  return Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : DEFAULT_DAILY_SEND_LIMIT;
}

function deliveryReservationSeed(subscription, { test = false, now = Date.now() } = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const uid = cleanText(subscription?.uid, 160) || 'unknown';
  const window = test
    ? `test-${Math.floor(timestamp / TEST_IDEMPOTENCY_WINDOW_MS)}`
    : `digest-${utcDay(timestamp)}`;
  return `papertok:${window}:${uid}:${subscriptionGeneration(subscription)}`;
}

async function buildDeliveryReservationId(subscription, options = {}) {
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

function withKvDeliveryLedgerLock(store, key, operation) {
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
function emailDeliveryLedgerMode(env) {
  if (env?.EMAIL_DELIVERY_LEDGER?.idFromName && env?.EMAIL_DELIVERY_LEDGER?.get) return 'durable';
  if (cleanText(env?.EMAIL_DELIVERY_LEDGER_FALLBACK, 20).toLowerCase() === 'kv') return 'kv';
  return 'missing';
}

export function getEmailDeliveryLedgerHealth(env) {
  const mode = emailDeliveryLedgerMode(env);
  if (mode === 'durable') return { mode, ok: true };
  return {
    mode,
    ok: false,
    code: mode === 'kv' ? 'EMAIL_DELIVERY_LEDGER_FALLBACK' : 'EMAIL_DELIVERY_LEDGER_MISSING',
  };
}

async function callEmailDeliveryLedger(env, payload, now = Date.now()) {
  const day = utcDay(now);
  const ledgerNow = Date.now();
  const mode = emailDeliveryLedgerMode(env);
  if (mode === 'missing') {
    throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
  }
  if (mode === 'durable') {
    const id = env.EMAIL_DELIVERY_LEDGER.idFromName(day);
    const stub = env.EMAIL_DELIVERY_LEDGER.get(id);
    const response = await stub.fetch('https://papertok.internal/email-delivery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, now: new Date(ledgerNow).toISOString() }),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
    }
    return result;
  }

  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${DELIVERY_LEDGER_PREFIX}${day}`;
  return withKvDeliveryLedgerLock(env.NOTIFICATION_STORE, key, async () => {
    const current = await env.NOTIFICATION_STORE.get(key, 'json');
    const outcome = applyEmailDeliveryLedgerAction(current, {
      ...payload,
      now: new Date(ledgerNow).toISOString(),
    });
    if (outcome.status >= 400) {
      throw new EmailNotificationError('EMAIL_DELIVERY_LEDGER_UNAVAILABLE', 503);
    }
    if (payload.action !== 'inspect') {
      await env.NOTIFICATION_STORE.put(key, JSON.stringify(outcome.state), {
        expirationTtl: DELIVERY_LEDGER_TTL_SECONDS,
      });
    }
    return outcome.result;
  });
}

async function inspectEmailDelivery(env, reservationId, now) {
  return callEmailDeliveryLedger(env, {
    action: 'inspect',
    reservationId,
  }, now);
}

async function reserveEmailDelivery(env, reservationId, now, draft) {
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

async function commitEmailDelivery(env, reservationId, delivery, now) {
  return callEmailDeliveryLedger(env, {
    action: 'commit',
    reservationId,
    delivery,
  }, now);
}

async function releaseEmailDelivery(env, reservationId, now) {
  try {
    await callEmailDeliveryLedger(env, { action: 'release', reservationId }, now);
  } catch (error) {
    console.warn('Could not release email delivery reservation', error?.code || 'EMAIL_DELIVERY_LEDGER_UNAVAILABLE');
  }
}

async function buildProviderIdempotencyKey(subscription, options = {}) {
  return buildDeliveryReservationId(subscription, options);
}

function buildResendIdempotencyKey(subscription, { test = false, now = Date.now() } = {}) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const sendWindow = test
    ? Math.floor(timestamp / TEST_IDEMPOTENCY_WINDOW_MS)
    : new Date(timestamp).toISOString().slice(0, 10);
  const uid = cleanText(subscription?.uid, 160).replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  return `${test ? 'test' : 'digest'}-${uid}-${sendWindow}`.slice(0, 256);
}

function resendSendErrorCode(status, payload = {}) {
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

function brevoSendErrorCode(status, payload = {}) {
  const providerMessage = cleanText(`${payload?.code || ''} ${payload?.message || ''}`, 1_000);
  if (status === 401 || status === 403) return 'EMAIL_PROVIDER_AUTH_FAILED';
  if (status === 429) return 'EMAIL_PROVIDER_LIMIT';
  if (status === 400 && /sender|not valid|not verified|unauthorized/i.test(providerMessage)) {
    return 'EMAIL_SENDER_NOT_VERIFIED';
  }
  return 'EMAIL_SEND_FAILED';
}

function providerOutcomeDefinitelyRejected(status) {
  if (status === 429) return true;
  if ([408, 409, 425].includes(status) || status >= 500) return false;
  return status >= 400 && status < 500;
}

const EMAIL_COPY = {
  es: {
    header: 'PAPERTOK · NOVEDADES SEGUIDAS',
    testTitle: 'Tu correo de PaperTok funciona',
    testSubject: 'PaperTok: correo de prueba',
    greeting: 'Hola',
    selection: frequency => `Esta es tu selección ${frequency === 'weekly' ? 'semanal' : 'diaria'}.`,
    digestTitle: count => (count === 1 ? '1 novedad científica para ti' : `${count} novedades científicas para ti`),
    followReason: names => `Porque sigues ${names.slice(0, 2).join(' y ')}`,
    discoveryReason: 'Descubrimiento destacado de PaperTok',
    authorUnavailable: 'Autoría no disponible',
    citations: count => `${count} ${count === 1 ? 'cita' : 'citas'}`,
    empty: 'La conexión está lista. Todavía no hemos encontrado publicaciones recientes entre tus seguimientos.',
    openInbox: 'Abrir mi bandeja',
    footer: 'Recibes este correo porque activaste las novedades por email en PaperTok.',
    unsubscribe: 'Darme de baja',
    openPaperTok: 'Abrir PaperTok',
    unavailable: 'Servicio no disponible',
    invalidLink: 'Enlace de baja no válido',
    confirmTitle: 'Confirmar baja',
    confirmBody: '¿Quieres dejar de recibir novedades de PaperTok por email?',
    confirmAction: 'Desactivar correos',
    disabledTitle: 'Correos desactivados',
    disabledBody: 'Ya no recibirás novedades de PaperTok por email.',
    returnToPaperTok: 'Volver a PaperTok',
  },
  en: {
    header: 'PAPERTOK · FOLLOWING UPDATES',
    testTitle: 'Your PaperTok email works',
    testSubject: 'PaperTok: test email',
    greeting: 'Hi',
    selection: frequency => `This is your ${frequency === 'weekly' ? 'weekly' : 'daily'} selection.`,
    digestTitle: count => (count === 1 ? '1 scientific update for you' : `${count} scientific updates for you`),
    followReason: names => `Because you follow ${names.slice(0, 2).join(' and ')}`,
    discoveryReason: 'A highlighted PaperTok discovery',
    authorUnavailable: 'Authors unavailable',
    citations: count => `${count} ${count === 1 ? 'citation' : 'citations'}`,
    empty: 'Your connection is ready. We have not found recent publications from what you follow yet.',
    openInbox: 'Open my feed',
    footer: 'You are receiving this email because you enabled email updates in PaperTok.',
    unsubscribe: 'Unsubscribe',
    openPaperTok: 'Open PaperTok',
    unavailable: 'Service unavailable',
    invalidLink: 'Invalid unsubscribe link',
    confirmTitle: 'Confirm unsubscribe',
    confirmBody: 'Do you want to stop receiving PaperTok updates by email?',
    confirmAction: 'Disable emails',
    disabledTitle: 'Emails disabled',
    disabledBody: 'You will no longer receive PaperTok updates by email.',
    returnToPaperTok: 'Return to PaperTok',
  },
};

function subscriptionLanguage(subscription) {
  return subscription?.language === 'en' ? 'en' : 'es';
}

function paperReason(paper, language = 'es') {
  const copy = EMAIL_COPY[language];
  const names = (paper.matches || []).map(match => match.displayName).filter(Boolean);
  return names.length
    ? copy.followReason(names)
    : copy.discoveryReason;
}

function renderDigest(subscription, papers, unsubscribeUrl, test) {
  const language = subscriptionLanguage(subscription);
  const copy = EMAIL_COPY[language];
  const greeting = subscription.displayName
    ? `${copy.greeting}, ${subscription.displayName.split(' ')[0]}`
    : copy.greeting;
  const title = test ? copy.testTitle : copy.digestTitle(papers.length);
  const paperHtml = papers.length
    ? papers.map(paper => `
      <div style="padding:20px 0;border-bottom:1px solid #2b2933">
        <div style="font-size:12px;color:#a98cf7;margin-bottom:7px">${escapeHtml(paperReason(paper, language))}</div>
        <a href="${escapeHtml(paper.url || PAPER_TOK_URL)}" style="color:#f6f4fb;text-decoration:none;font-size:18px;font-weight:700;line-height:1.35">${renderScientificHtml(paper.title)}</a>
        <div style="color:#a7a2b3;font-size:13px;margin-top:8px">${escapeHtml(paper.authors?.slice(0, 3).join(', ') || copy.authorUnavailable)}</div>
        <div style="color:#787381;font-size:12px;margin-top:6px">${escapeHtml([paper.published, paper.journal, paper.citationCount ? copy.citations(paper.citationCount) : ''].filter(Boolean).join(' · '))}</div>
      </div>`).join('')
    : `<div style="padding:24px 0;color:#b9b4c3">${escapeHtml(copy.empty)}</div>`;

  const html = `<!doctype html><html><body style="margin:0;background:#0c0b10;color:#f6f4fb;font-family:Arial,sans-serif">
    <div style="max-width:640px;margin:0 auto;padding:36px 24px">
      <div style="color:#8b5cf6;font-size:12px;font-weight:700;letter-spacing:1px">${escapeHtml(copy.header)}</div>
      <h1 style="font-size:28px;line-height:1.15;margin:14px 0 8px">${escapeHtml(title)}</h1>
      <p style="color:#a7a2b3;margin:0 0 16px">${escapeHtml(`${greeting}. ${copy.selection(subscription.frequency)}`)}</p>
      ${paperHtml}
      <a href="${PAPER_TOK_URL}" style="display:inline-block;margin-top:24px;padding:12px 18px;background:#8b5cf6;color:white;text-decoration:none;border-radius:6px;font-weight:700">${escapeHtml(copy.openInbox)}</a>
      <p style="color:#676270;font-size:11px;line-height:1.5;margin-top:34px">${escapeHtml(copy.footer)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#9b93a8">${escapeHtml(copy.unsubscribe)}</a>.</p>
    </div></body></html>`;
  const text = `${title}\n\n${greeting}. ${copy.selection(subscription.frequency)}\n\n${papers.map(paper => `${renderScientificText(paper.title)}\n${paperReason(paper, language)}\n${paper.url || PAPER_TOK_URL}`).join('\n\n')}\n\n${copy.openPaperTok}: ${PAPER_TOK_URL}\n${copy.unsubscribe}: ${unsubscribeUrl}`;
  return { html, text, subject: test ? copy.testSubject : title };
}

// Deliberately the same shape as `fetchWithDeadline` in `report-api.js`, down
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
function fetchWithDeadline(input, init, timeoutMs) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

async function fetchEmailProvider(input, init) {
  return fetchWithDeadline(input, init, EMAIL_PROVIDER_TIMEOUT_MS);
}

async function sendWithBrevo(subscription, content, unsubscribeUrl, env, { test = false, idempotencyKey } = {}) {
  const sender = resolveBrevoSender(env);
  const response = await fetchEmailProvider(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
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
  const payload = await response.json().catch(() => ({}));
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

async function sendWithResend(subscription, content, unsubscribeUrl, env, { idempotencyKey } = {}) {
  const from = await resolveResendSender(env);
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
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = resendSendErrorCode(response.status, payload);
    console.error('Resend rejected digest', response.status, code);
    const error = new EmailNotificationError(code, response.status === 429 ? 429 : 502);
    error.deliveryRejected = providerOutcomeDefinitelyRejected(response.status);
    throw error;
  }
  return payload?.id || null;
}

function compactSourceReport(report = {}) {
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
    }])),
    failureCodes: Object.fromEntries(Object.entries(report.failureCodes || {})
      .filter(([, count]) => Number(count) > 0)),
  };
}

function lastDeliveryStatus(status, at, {
  kind = 'digest',
  paperCount = 0,
  partial = false,
  code,
  sourceReport,
} = {}) {
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

function deliveryStatePatch(currentState, delivery, status = 'sent') {
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

function papersForCurrentSubscription(papers, subscription, test) {
  const sentKeys = test ? new Set() : new Set(subscription.sentPaperKeys || []);
  const followKeys = new Set((subscription.follows || []).map(follow => (
    `${follow.type}:${follow.canonicalId}`
  )));
  return papers.filter(paper => (
    !paperIdentityKeys(paper).some(key => sentKeys.has(key))
    && (!(paper.matches || []).length || getPaperFollowKeys(paper).some(key => followKeys.has(key)))
  )).slice(0, subscription.maxPapers || 5);
}

function buildDeliveryDraft(subscription, papers, provider, env, {
  test = false,
  now = Date.now(),
  sourceReport = createSourceReport(),
} = {}) {
  const workerBase = cleanText(env.WORKER_PUBLIC_URL, 500)
    || 'https://api.papertok.app';
  const unsubscribeUrl = `${workerBase}/notifications/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken)}&lang=${subscriptionLanguage(subscription)}`;
  return {
    provider,
    recipient: {
      email: subscription.email,
      displayName: subscription.displayName,
    },
    content: renderDigest(subscription, papers, unsubscribeUrl, test),
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

async function deliverReservedDraft(env, reservationId, draft, now, {
  test = false,
  ledgerTime = now,
} = {}) {
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
    if (error?.deliveryRejected) await releaseEmailDelivery(env, reservationId, now);
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
function deliveryAlreadySettled(subscription, deliveredAt) {
  const settled = Date.parse(subscription?.lastSentAt || '');
  const delivered = Date.parse(deliveredAt || '');
  return Number.isFinite(settled) && Number.isFinite(delivered) && settled >= delivered;
}

async function resumeScheduledDelivery(subscription, env, {
  now = Date.now(),
  key = `${SUBSCRIPTION_PREFIX}${subscription.uid}`,
} = {}) {
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

async function sendDigest(subscription, papers, env, {
  test = false,
  now = Date.now(),
  key = `${SUBSCRIPTION_PREFIX}${subscription.uid}`,
  sourceReport = createSourceReport(),
} = {}) {
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

async function testSubscription(env, identity) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const subscription = await loadSubscriptionWithState(env, key);
  if (!subscription?.enabled) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  if (!(subscription.follows || []).length) throw new EmailNotificationError('EMAIL_FOLLOWS_REQUIRED', 409);
  const lastTestAt = Date.parse(subscription.lastTestAt || 0);
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
    state => deliveryStatePatch(state, result.delivery, result.reconciled ? 'reconciled' : 'sent'),
  );
  if (!updated) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  return {
    ok: true,
    providerId: result.providerId || null,
    paperCount: result.delivery.paperCount,
    followCount: updated.follows?.length || 0,
    preferences: publicSubscription(updated, identity.email),
  };
}

export async function handleEmailNotificationRequest(request, env, pathname) {
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

export async function handleEmailUnsubscribe(request, env) {
  const requestUrl = new URL(request.url);
  const requestedLanguage = requestUrl.searchParams.get('lang') === 'en'
    || (!requestUrl.searchParams.has('lang') && /^en(?:-|,|$)/i.test(request.headers.get('accept-language') || ''))
    ? 'en'
    : 'es';
  if (!env.NOTIFICATION_STORE) return new Response(EMAIL_COPY[requestedLanguage].unavailable, { status: 503 });
  const token = cleanText(requestUrl.searchParams.get('token'), 100);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(token)) {
    return new Response(EMAIL_COPY[requestedLanguage].invalidLink, { status: 400 });
  }
  const uid = await env.NOTIFICATION_STORE.get(`${UNSUBSCRIBE_PREFIX}${token}`);
  if (!uid) return new Response(EMAIL_COPY[requestedLanguage].invalidLink, { status: 400 });
  const subscription = await loadSubscriptionWithState(env, `${SUBSCRIPTION_PREFIX}${uid}`);
  if (!subscription || subscription.unsubscribeToken !== token) {
    await env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${token}`);
    return new Response(EMAIL_COPY[requestedLanguage].invalidLink, { status: 400 });
  }
  const language = subscriptionLanguage(subscription);
  const copy = EMAIL_COPY[language];
  if (request.method === 'POST') {
    await deleteSubscription(env, uid, subscription);
  }

  const title = request.method === 'POST' ? copy.disabledTitle : copy.confirmTitle;
  const body = request.method === 'POST' ? copy.disabledBody : copy.confirmBody;
  const action = request.method === 'GET'
    ? `<form method="post" action="${escapeHtml(requestUrl.pathname)}?token=${encodeURIComponent(token)}&lang=${language}"><button type="submit" style="border:0;border-radius:8px;background:#8b5cf6;color:white;padding:12px 18px;font-weight:700;cursor:pointer">${escapeHtml(copy.confirmAction)}</button></form>`
    : `<a href="${PAPER_TOK_URL}" style="color:#a98cf7">${escapeHtml(copy.returnToPaperTok)}</a>`;
  return new Response(`<!doctype html><html lang="${language}"><head><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="background:#0c0b10;color:#f6f4fb;font-family:Arial,sans-serif;text-align:center;padding:80px 20px"><h1>${escapeHtml(title)}</h1><p style="color:#aaa3b6">${escapeHtml(body)}</p>${action}</body></html>`, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function getEmailScheduleHealth(env, now = Date.now()) {
  if (!env.NOTIFICATION_STORE) {
    return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_NOT_CONFIGURED' };
  }
  try {
    const summary = await env.NOTIFICATION_STORE.get(SCHEDULE_STATUS_KEY, 'json');
    if (!summary) return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_NOT_RUN' };
    const completedAt = cleanText(summary.completedAt, 40);
    const completedTime = Date.parse(completedAt);
    const fresh = Number.isFinite(completedTime) && now - completedTime <= 30 * 60 * 60 * 1000;
    const count = field => Math.max(0, Number(summary[field]) || 0);
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
        .map(([code, value]) => [cleanText(code, 100), Math.max(0, Number(value) || 0)])
        .filter(([code, value]) => code && value > 0)
        .slice(0, 24)),
    };
  } catch {
    return { available: false, fresh: false, code: 'EMAIL_SCHEDULE_UNAVAILABLE' };
  }
}

export async function checkEmailProviderHealth(env) {
  const provider = requestedEmailProvider(env);
  if (!configuredEmailProvider(env)) {
    return { configured: false, available: false, provider: provider || null, code: 'EMAIL_NOT_CONFIGURED' };
  }

  if (provider === 'brevo') {
    try {
      const response = await fetchWithDeadline(`${BREVO_API}/senders`, {
        headers: {
          'api-key': env.BREVO_API_KEY,
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
      const payload = await response.json().catch(() => ({}));
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
      const errorPayload = await response.json().catch(() => ({}));
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
    const payload = await response.json().catch(() => ({}));
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

function isSubscriptionCalendarDue(subscription, now) {
  if (!subscription?.enabled) return false;
  const lastSent = Date.parse(subscription.lastSentAt || 0);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (subscription.frequency === 'weekly') {
    return now.getUTCDay() === 1 && (!lastSent || lastSent < dayStart);
  }
  return !lastSent || lastSent < dayStart;
}

function isSubscriptionDue(subscription, now) {
  if (!isSubscriptionCalendarDue(subscription, now)) return false;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastDeliveryAt = Date.parse(subscription.lastDelivery?.at || 0);
  if (!Number.isFinite(lastDeliveryAt) || lastDeliveryAt < dayStart) return true;
  const elapsed = now.getTime() - lastDeliveryAt;
  if (subscription.lastDelivery?.status === 'invalid') return false;
  if (subscription.lastDelivery?.status === 'empty') return elapsed >= EMPTY_RETRY_INTERVAL_MS;
  if (subscription.lastDelivery?.status === 'failed') return elapsed >= FAILURE_RETRY_INTERVAL_MS;
  return true;
}

function shouldInspectPreviousDay(subscription, now) {
  return (
    isSubscriptionCalendarDue(subscription, now)
    || (subscription?.frequency === 'weekly' && now.getUTCDay() === 2)
  );
}

function allowsNewScheduledDelivery(now) {
  return !(now.getUTCHours() === 13 && now.getUTCMinutes() >= 40);
}

async function loadScheduleCursor(store) {
  try {
    return cleanText(await store.get(SCHEDULE_CURSOR_KEY), 2_000) || undefined;
  } catch {
    return undefined;
  }
}

async function persistScheduleCursor(store, cursor) {
  if (cursor) await store.put(SCHEDULE_CURSOR_KEY, cursor);
  else await store.delete(SCHEDULE_CURSOR_KEY);
}

function failureCodeCounts(sourceReport, code) {
  const counts = { ...(sourceReport?.failureCodes || {}) };
  if (code) counts[code] = (counts[code] || 0) + 1;
  return counts;
}

function mergeSourceReports(target, report) {
  if (!report) return target;
  ['attempted', 'succeeded', 'failed', 'requestAttempts', 'retried', 'requiredFailed'].forEach((field) => {
    target[field] += Math.max(0, Number(report[field]) || 0);
  });
  Object.entries(report.bySource || {}).forEach(([source, counts]) => {
    target.bySource[source] ||= { attempted: 0, succeeded: 0, failed: 0 };
    ['attempted', 'succeeded', 'failed'].forEach((field) => {
      target.bySource[source][field] += Math.max(0, Number(counts?.[field]) || 0);
    });
  });
  Object.entries(report.failureCodes || {}).forEach(([code, count]) => {
    target.failureCodes[code] = (target.failureCodes[code] || 0) + Math.max(0, Number(count) || 0);
  });
  return target;
}

async function recordSubscriptionOutcome(env, key, subscription, status, at, {
  code,
  paperCount = 0,
  partial = false,
  sourceReport,
} = {}) {
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

async function persistScheduledDelivery(env, key, subscription, delivery) {
  const status = delivery.uncertain ? 'uncertain' : delivery.reconciled ? 'reconciled' : 'sent';
  const updated = await updateDeliveryState(
    env,
    key,
    subscription,
    state => deliveryStatePatch(state, delivery.delivery, status),
  );
  if (!updated && delivery.sent) {
    return {
      sent: true,
      partial: Boolean(delivery.delivery.partial),
      sources: compactSourceReport(delivery.delivery.sources),
      failureCodes: failureCodeCounts(delivery.delivery.sources),
    };
  }
  if (!updated) return { skipped: true };
  return {
    [status]: true,
    partial: Boolean(delivery.delivery.partial),
    sources: compactSourceReport(delivery.delivery.sources),
    failureCodes: failureCodeCounts(
      delivery.delivery.sources,
      delivery.uncertain ? 'EMAIL_SEND_OUTCOME_UNCONFIRMED' : undefined,
    ),
  };
}

async function processScheduledSubscription(env, key, now) {
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

    const collected = await collectDigestPapers(subscription, env, { now: now.getTime() });
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
    sourceReport ||= error?.sourceReport;
    const code = cleanText(error?.code, 100) || 'EMAIL_SCHEDULE_PROCESSING_FAILED';
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
      console.warn('Could not persist subscription delivery failure', recordError?.message || recordError);
    }
    return {
      failed: true,
      partial: false,
      sources: compactSourceReport(sourceReport),
      failureCodes: failureCodeCounts(sourceReport, code),
    };
  }
}

async function recordScheduleOutcome(env, summary) {
  console.info('Email notification schedule completed', JSON.stringify(summary));
  if (!env.NOTIFICATION_STORE) return;
  try {
    await env.NOTIFICATION_STORE.put(SCHEDULE_STATUS_KEY, JSON.stringify(summary));
  } catch (error) {
    console.warn('Could not persist email notification schedule outcome', error?.message || error);
  }
  try {
    const historyKey = `${SCHEDULE_HISTORY_PREFIX}${summary.scheduledAt}`;
    await env.NOTIFICATION_STORE.put(historyKey, JSON.stringify(summary), {
      expirationTtl: SCHEDULE_HISTORY_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('Could not persist email notification schedule history', error?.message || error);
  }
}

export async function runEmailNotificationSchedule(env, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  const startedAt = Date.now();
  const provider = configuredEmailProvider(env);
  const ledgerMissing = Boolean(provider && env.NOTIFICATION_STORE) && emailDeliveryLedgerMode(env) === 'missing';
  if (ledgerMissing) {
    console.error('Email delivery ledger binding is missing; refusing to send without an atomic daily limit');
  }
  if (!env.NOTIFICATION_STORE || !provider || ledgerMissing) {
    const summary = {
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
  const failureCodes = {};
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
    const results = await Promise.allSettled(batch.map(key => processScheduledSubscription(env, key, now)));
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
      console.warn('Could not persist email schedule cursor', error?.message || error);
    }
    if (!batch.length && !cursor) inventoryComplete = true;
  }
  const summary = {
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
  saveSubscription,
  mergePapers,
  arxivCategoriesForFollow,
  parseArxivDigestFeed,
  selectDigestPapers,
  isSubscriptionDue,
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
