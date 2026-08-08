import { XMLParser } from 'fast-xml-parser';
import { filterRelevantQueryTopicPapers } from '../src/utils/queryTopicSearch.js';

const SUBSCRIPTION_PREFIX = 'notification:subscription:';
const UNSUBSCRIBE_PREFIX = 'notification:unsubscribe:';
const BREVO_API = 'https://api.brevo.com/v3';
const RESEND_API = 'https://api.resend.com';
const ARXIV_API = 'https://export.arxiv.org/api/query';
const PAPER_TOK_URL = 'https://mugar123.github.io/papertok/#/following';
const MAX_FOLLOWS = 40;
const MAX_QUERIED_FOLLOWS = 24;
const MAX_PREVIEW_ITEMS = 20;
const MAX_SENT_PAPER_KEYS = 120;
const DEFAULT_DAILY_SEND_LIMIT = 290;
const SEND_COUNT_PREFIX = 'notification:send-count:';
const SCHEDULE_STATUS_KEY = 'notification:schedule:last-run';
const TEST_IDEMPOTENCY_WINDOW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
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

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
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

async function fetchArxivTopicUpdates(follows) {
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
        'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
      },
    });
    if (!response.ok) throw new Error(`arXiv digest error: ${response.status}`);
    return parseArxivDigestFeed(await response.text(), follows);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function verifyFirebaseIdentity(request, env) {
  const authorization = request.headers.get('authorization') || '';
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new EmailNotificationError('EMAIL_AUTH_REQUIRED', 401);
  if (!env.FIREBASE_WEB_API_KEY) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);

  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: token }),
  });
  const payload = await response.json().catch(() => ({}));
  const account = payload?.users?.[0];
  if (!response.ok || !account?.localId || !account?.email) {
    throw new EmailNotificationError('EMAIL_AUTH_REQUIRED', 401);
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

async function deleteSubscription(env, uid, subscription) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  await Promise.all([
    env.NOTIFICATION_STORE.delete(`${SUBSCRIPTION_PREFIX}${uid}`),
    subscription?.unsubscribeToken
      ? env.NOTIFICATION_STORE.delete(`${UNSUBSCRIBE_PREFIX}${subscription.unsubscribeToken}`)
      : Promise.resolve(),
  ]);
}

async function saveSubscription(request, env, identity) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const body = await request.json().catch(() => null);
  if (!body) throw new EmailNotificationError('EMAIL_INVALID_REQUEST', 400);
  const preferences = sanitizePreferences(body);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const existing = await env.NOTIFICATION_STORE.get(key, 'json');

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
  const subscription = {
    ...existing,
    ...preferences,
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName,
    follows,
    previewItems,
    unsubscribeToken,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await Promise.all([
    env.NOTIFICATION_STORE.put(key, JSON.stringify(subscription)),
    env.NOTIFICATION_STORE.put(`${UNSUBSCRIBE_PREFIX}${unsubscribeToken}`, identity.uid),
  ]);
  return publicSubscription(subscription, identity.email);
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

async function fetchOpenAlexUpdates(follow, env, now = Date.now()) {
  const id = normalizeId(follow.canonicalId);
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  const cutoff = new Date(now - 9 * DAY_MS).toISOString().slice(0, 10);
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
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenAlex digest error: ${response.status}`);
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
}

async function fetchExplorationUpdates(env, now = Date.now()) {
  const url = addOpenAlexCredentials(new URL('https://api.openalex.org/works'), env);
  const cutoff = new Date(now - 4 * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  url.searchParams.set(
    'filter',
    `from_publication_date:${cutoff},to_publication_date:${today},is_retracted:false`,
  );
  url.searchParams.set('sort', 'cited_by_count:desc');
  url.searchParams.set('per-page', '8');
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    console.warn('OpenAlex digest exploration unavailable', response.status);
    return [];
  }
  const payload = await response.json().catch(() => ({}));
  return (payload?.results || []).map(work => mapOpenAlexPaper(work, null)).filter(Boolean);
}

async function fetchProjectUpdates(follow, env) {
  const requestUrl = new URL('https://api.openaire.eu/search/publications');
  requestUrl.searchParams.set('format', 'json');
  requestUrl.searchParams.set('size', '10');
  requestUrl.searchParams.set('page', '1');
  requestUrl.searchParams.set(follow.canonicalId.includes('::') ? 'openaireProjectID' : 'projectID', follow.canonicalId);
  const response = await fetch(requestUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OpenAIRE digest error: ${response.status}`);
  const payload = await response.json();
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
  const openAlexResponse = await fetch(openAlexUrl, { headers: { accept: 'application/json' } });
  if (!openAlexResponse.ok) return [];
  const openAlexPayload = await openAlexResponse.json();
  return (openAlexPayload?.results || []).map(work => mapOpenAlexPaper(work, follow)).filter(Boolean);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        output[index] = await mapper(items[index]);
      } catch (error) {
        console.warn('Digest source unavailable', error?.message || error);
        output[index] = [];
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output.flat();
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

async function collectDigestPapers(subscription, env, { test = false, now = Date.now() } = {}) {
  const follows = (subscription.follows || []).slice(0, MAX_QUERIED_FOLLOWS);
  if (!follows.length) return [];
  const arxivFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length > 0);
  const indexedFollows = follows.filter(follow => arxivCategoriesForFollow(follow).length === 0);
  const indexedFreshPromise = mapWithConcurrency(indexedFollows, 4, follow => (
    follow.type === 'project' ? fetchProjectUpdates(follow, env) : fetchOpenAlexUpdates(follow, env, now)
  ));
  const arxivFreshPromise = fetchArxivTopicUpdates(arxivFollows).catch(async (error) => {
    console.warn('arXiv digest unavailable, using OpenAlex fallback', error?.message || error);
    return mapWithConcurrency(arxivFollows, 2, follow => fetchOpenAlexUpdates(follow, env, now));
  });
  const [indexedFresh, arxivFresh] = await Promise.all([indexedFreshPromise, arxivFreshPromise]);
  const combined = mergePapers([
    ...indexedFresh,
    ...arxivFresh,
    ...(subscription.previewItems || []),
  ]);
  const fallbackDays = subscription.frequency === 'weekly' ? 8 : 2;
  const cutoff = subscription.lastSentAt
    ? Date.parse(subscription.lastSentAt) - 60 * 60 * 1000
    : now - fallbackDays * DAY_MS;
  const maximum = subscription.maxPapers || 5;
  const sentKeys = test ? new Set() : new Set(subscription.sentPaperKeys || []);
  const followedSelection = selectDigestPapers(
    combined.filter(paper => publicationTime(paper) >= cutoff),
    { limit: maximum, now, excludedKeys: sentKeys },
  );
  if (test || !followedSelection.length || followedSelection.length >= maximum) {
    return followedSelection;
  }

  const selectedKeys = new Set([
    ...sentKeys,
    ...followedSelection.flatMap(paperIdentityKeys),
  ]);
  const exploration = await fetchExplorationUpdates(env, now).catch((error) => {
    console.warn('Digest exploration unavailable', error?.message || error);
    return [];
  });
  const discovery = selectDigestPapers(exploration, {
    limit: 1,
    now,
    exploration: true,
    excludedKeys: selectedKeys,
  });
  return [...followedSelection, ...discovery].slice(0, maximum);
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

async function dailySendState(env) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const configuredLimit = Number(env.EMAIL_DAILY_SEND_LIMIT);
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0
    ? Math.floor(configuredLimit)
    : DEFAULT_DAILY_SEND_LIMIT;
  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `${SEND_COUNT_PREFIX}${dateKey}`;
  const current = Number(await env.NOTIFICATION_STORE.get(key)) || 0;
  return { current, key, limit };
}

async function assertDailySendAvailable(env) {
  const state = await dailySendState(env);
  if (state.current >= state.limit) throw new EmailNotificationError('EMAIL_PROVIDER_LIMIT', 429);
  return state;
}

async function recordSuccessfulSend(env, state) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const latest = Number(await env.NOTIFICATION_STORE.get(state.key)) || 0;
  await env.NOTIFICATION_STORE.put(
    state.key,
    String(Math.min(latest + 1, state.limit)),
    { expirationTtl: 172_800 },
  );
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

async function sendWithBrevo(subscription, content, env, { test = false } = {}) {
  const sender = resolveBrevoSender(env);
  const response = await fetch(`${BREVO_API}/smtp/email`, {
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
      tags: [test ? 'papertok-test' : 'papertok-following-digest'],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Brevo rejected digest', response.status, payload?.message || payload?.code || 'unknown');
    const code = brevoSendErrorCode(response.status, payload);
    throw new EmailNotificationError(code, response.status === 429 ? 429 : 502);
  }
  return payload?.messageId || payload?.messageIds?.[0] || null;
}

async function sendWithResend(subscription, content, unsubscribeUrl, env, { test = false } = {}) {
  const from = await resolveResendSender(env);
  const response = await fetch(`${RESEND_API}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
      'user-agent': 'PaperTok/1.0',
      'idempotency-key': buildResendIdempotencyKey(subscription, { test }),
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
    console.error('Resend rejected digest', response.status, payload?.message || payload?.name || 'unknown');
    const code = resendSendErrorCode(response.status, payload);
    throw new EmailNotificationError(code, response.status === 429 ? 429 : 502);
  }
  return payload?.id || null;
}

async function sendDigest(subscription, papers, env, { test = false } = {}) {
  const provider = configuredEmailProvider(env);
  if (!provider) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const sendState = await assertDailySendAvailable(env);
  const workerBase = cleanText(env.WORKER_PUBLIC_URL, 500) || 'https://papertok-report-api.papertok-mugar123.workers.dev';
  const unsubscribeUrl = `${workerBase}/notifications/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken)}&lang=${subscriptionLanguage(subscription)}`;
  const content = renderDigest(subscription, papers, unsubscribeUrl, test);
  const providerId = provider === 'brevo'
    ? await sendWithBrevo(subscription, content, env, { test })
    : await sendWithResend(subscription, content, unsubscribeUrl, env, { test });
  await recordSuccessfulSend(env, sendState);
  return providerId;
}

async function testSubscription(env, identity) {
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;
  const subscription = await env.NOTIFICATION_STORE.get(key, 'json');
  if (!subscription?.enabled) throw new EmailNotificationError('EMAIL_SUBSCRIPTION_REQUIRED', 409);
  const lastTestAt = Date.parse(subscription.lastTestAt || 0);
  if (lastTestAt && Date.now() - lastTestAt < 60_000) {
    throw new EmailNotificationError('EMAIL_TEST_RATE_LIMIT', 429);
  }
  const papers = await collectDigestPapers(subscription, env, { test: true });
  const providerId = await sendDigest(subscription, papers, env, { test: true });
  const updated = { ...subscription, lastTestAt: new Date().toISOString() };
  await env.NOTIFICATION_STORE.put(key, JSON.stringify(updated));
  return {
    ok: true,
    providerId,
    paperCount: papers.length,
    followCount: subscription.follows?.length || 0,
    preferences: publicSubscription(updated, identity.email),
  };
}

export async function handleEmailNotificationRequest(request, env, pathname) {
  const identity = await verifyFirebaseIdentity(request, env);
  if (!env.NOTIFICATION_STORE) throw new EmailNotificationError('EMAIL_NOT_CONFIGURED', 503);
  const key = `${SUBSCRIPTION_PREFIX}${identity.uid}`;

  if (pathname === '/notifications/preferences' && request.method === 'GET') {
    const subscription = await env.NOTIFICATION_STORE.get(key, 'json');
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
  if (!token) return new Response(EMAIL_COPY[requestedLanguage].invalidLink, { status: 400 });
  const uid = await env.NOTIFICATION_STORE.get(`${UNSUBSCRIBE_PREFIX}${token}`);
  let language = requestedLanguage;
  if (uid) {
    const subscription = await env.NOTIFICATION_STORE.get(`${SUBSCRIPTION_PREFIX}${uid}`, 'json');
    language = subscriptionLanguage(subscription);
    await deleteSubscription(env, uid, subscription);
  }
  const copy = EMAIL_COPY[language];
  return new Response(`<!doctype html><html lang="${language}"><body style="background:#0c0b10;color:#f6f4fb;font-family:Arial,sans-serif;text-align:center;padding:80px 20px"><h1>${escapeHtml(copy.disabledTitle)}</h1><p style="color:#aaa3b6">${escapeHtml(copy.disabledBody)}</p><a href="${PAPER_TOK_URL}" style="color:#a98cf7">${escapeHtml(copy.returnToPaperTok)}</a></body></html>`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function checkEmailProviderHealth(env) {
  const provider = requestedEmailProvider(env);
  if (!configuredEmailProvider(env)) {
    return { configured: false, available: false, provider: provider || null, code: 'EMAIL_NOT_CONFIGURED' };
  }

  if (provider === 'brevo') {
    try {
      const response = await fetch(`${BREVO_API}/senders`, {
        headers: {
          'api-key': env.BREVO_API_KEY,
          accept: 'application/json',
          'user-agent': 'PaperTok/1.0',
        },
      });
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
    const response = await fetch(`${RESEND_API}/domains?limit=1`, {
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        accept: 'application/json',
        'user-agent': 'PaperTok/1.0',
      },
    });
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

function isSubscriptionDue(subscription, now) {
  if (!subscription?.enabled) return false;
  const lastSent = Date.parse(subscription.lastSentAt || 0);
  if (subscription.frequency === 'weekly') {
    return now.getUTCDay() === 1 && (!lastSent || now.getTime() - lastSent >= 6 * 24 * 60 * 60 * 1000);
  }
  return !lastSent || now.getTime() - lastSent >= 20 * 60 * 60 * 1000;
}

async function processScheduledSubscription(env, key, now) {
  const subscription = await env.NOTIFICATION_STORE.get(key.name, 'json');
  if (!isSubscriptionDue(subscription, now)) return { skipped: true };
  const papers = await collectDigestPapers(subscription, env, { now: now.getTime() });
  const checkedAt = now.toISOString();
  if (!papers.length) {
    await env.NOTIFICATION_STORE.put(key.name, JSON.stringify({ ...subscription, lastCheckedAt: checkedAt }));
    return { empty: true };
  }
  await sendDigest(subscription, papers, env);
  const sentPaperKeys = [...new Set([
    ...(subscription.sentPaperKeys || []),
    ...papers.flatMap(paperIdentityKeys),
  ])].slice(-MAX_SENT_PAPER_KEYS);
  await env.NOTIFICATION_STORE.put(key.name, JSON.stringify({
    ...subscription,
    lastCheckedAt: checkedAt,
    lastSentAt: checkedAt,
    sentPaperKeys,
  }));
  return { sent: true };
}

async function recordScheduleOutcome(env, summary) {
  console.info('Email notification schedule completed', JSON.stringify(summary));
  if (!env.NOTIFICATION_STORE) return;
  try {
    await env.NOTIFICATION_STORE.put(SCHEDULE_STATUS_KEY, JSON.stringify(summary));
  } catch (error) {
    console.warn('Could not persist email notification schedule outcome', error?.message || error);
  }
}

export async function runEmailNotificationSchedule(env, scheduledTime = Date.now()) {
  const now = new Date(scheduledTime);
  const provider = configuredEmailProvider(env);
  if (!env.NOTIFICATION_STORE || !provider) {
    const summary = {
      scheduledAt: now.toISOString(),
      completedAt: new Date().toISOString(),
      provider: provider || null,
      scanned: 0,
      due: 0,
      sent: 0,
      empty: 0,
      skipped: 1,
      failed: 0,
      disabled: true,
    };
    await recordScheduleOutcome(env, summary);
    return summary;
  }
  let cursor;
  let scanned = 0;
  let sent = 0;
  let empty = 0;
  let skipped = 0;
  let failed = 0;
  do {
    const page = await env.NOTIFICATION_STORE.list({ prefix: SUBSCRIPTION_PREFIX, cursor, limit: 100 });
    for (let index = 0; index < page.keys.length; index += 3) {
      const batch = page.keys.slice(index, index + 3);
      const results = await Promise.allSettled(batch.map(key => processScheduledSubscription(env, key, now)));
      scanned += batch.length;
      sent += results.filter(result => result.status === 'fulfilled' && result.value?.sent).length;
      empty += results.filter(result => result.status === 'fulfilled' && result.value?.empty).length;
      skipped += results.filter(result => result.status === 'fulfilled' && result.value?.skipped).length;
      failed += results.filter(result => result.status === 'rejected').length;
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const summary = {
    scheduledAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    provider,
    scanned,
    due: sent + empty + failed,
    sent,
    empty,
    skipped,
    failed,
  };
  await recordScheduleOutcome(env, summary);
  return summary;
}

export const emailNotificationInternals = {
  brevoSendErrorCode,
  buildResendIdempotencyKey,
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
  scheduleStatusKey: SCHEDULE_STATUS_KEY,
};
