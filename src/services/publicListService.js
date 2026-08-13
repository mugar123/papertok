import {
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';
import { safeDoiUrl, safeExternalUrl } from '../utils/externalUrl.js';

export const PUBLIC_LIST_LIMITS = Object.freeze({
  papers: 12,
  title: 120,
  description: 600,
  paperTitle: 500,
  abstract: 3000,
  authors: 20,
  author: 160,
  concepts: 12,
  concept: 120,
  id: 300,
  url: 2000,
});

export class PublicListUnsupportedError extends Error {
  constructor() {
    super('Public lists are unavailable in demo mode.');
    this.name = 'PublicListUnsupportedError';
    this.code = 'PUBLIC_LISTS_UNSUPPORTED_IN_DEMO';
  }
}

function cleanString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maximum);
}

function cleanMultilineString(value, maximum) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\r\n?/g, '\n').slice(0, maximum);
}

function normalizeDoi(value) {
  const url = safeDoiUrl(value);
  if (!url) return '';
  try {
    return decodeURI(url.replace('https://doi.org/', ''));
  } catch {
    return '';
  }
}

function normalizeArxivId(value) {
  const candidate = cleanString(value, 100)
    .replace(/^arxiv:/i, '')
    .replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '');
  return /^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?$/i.test(candidate)
    ? candidate
    : '';
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map(author => cleanString(typeof author === 'string' ? author : author?.name, PUBLIC_LIST_LIMITS.author))
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.authors);
}

function normalizeConcepts(concepts) {
  if (!Array.isArray(concepts)) return [];
  return concepts
    .map(concept => cleanString(
      typeof concept === 'string' ? concept : (concept?.display_name || concept?.name || concept?.title),
      PUBLIC_LIST_LIMITS.concept,
    ))
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.concepts);
}

function stablePaperId(paper, doi, arxivId) {
  const rawId = cleanString(paper?.id, PUBLIC_LIST_LIMITS.id);
  if (doi) return `doi:${doi.toLowerCase()}`;
  if (arxivId) return `arxiv:${arxivId.toLowerCase()}`;
  return rawId;
}

export function sanitizePublicPaper(paper) {
  if (!paper || typeof paper !== 'object') return null;

  const doi = normalizeDoi(paper.doi);
  const arxivId = normalizeArxivId(paper.arxivId || (String(paper.id || '').startsWith('arxiv:') ? paper.id : ''));
  const id = stablePaperId(paper, doi, arxivId);
  const title = cleanString(paper.title, PUBLIC_LIST_LIMITS.paperTitle);
  if (!id || !title) return null;

  const result = {
    id,
    title,
    authors: normalizeAuthors(paper.authors),
  };
  const abstract = cleanMultilineString(paper.abstract || paper.summary, PUBLIC_LIST_LIMITS.abstract);
  const category = cleanString(
    paper.category || paper.primaryCategory || paper.categories?.[0],
    120,
  );
  const concepts = normalizeConcepts(paper.concepts);
  const openUrl = safeExternalUrl(
    paper.openUrl || paper.landingPageUrl || paper.openAccessPdfUrl || paper.pdfUrl,
  ).slice(0, PUBLIC_LIST_LIMITS.url);
  const year = Number.isInteger(paper.year) && paper.year >= 1000 && paper.year <= 3000
    ? paper.year
    : null;
  const date = cleanString(paper.date || paper.published, 40);
  const citations = Number.isInteger(paper.citations)
    ? paper.citations
    : paper.citationCount;

  if (abstract) result.abstract = abstract;
  if (year) result.year = year;
  if (date) result.date = date;
  if (category) result.category = category;
  if (concepts.length) result.concepts = concepts;
  if (Number.isInteger(citations) && citations >= 0 && citations <= 1_000_000_000) {
    result.citations = citations;
  }
  if (doi) result.doi = doi;
  if (arxivId) result.arxivId = arxivId;
  if (openUrl) result.openUrl = openUrl;
  return result;
}

export function sanitizePublicList(input) {
  const title = cleanString(input?.title || input?.name, PUBLIC_LIST_LIMITS.title);
  if (!title) throw new TypeError('A public list title is required.');

  const papers = (Array.isArray(input?.papers) ? input.papers : [])
    .map(sanitizePublicPaper)
    .filter(Boolean)
    .slice(0, PUBLIC_LIST_LIMITS.papers);
  const description = cleanMultilineString(input?.description, PUBLIC_LIST_LIMITS.description);

  return {
    title,
    ...(description ? { description } : {}),
    language: input?.language === 'en' ? 'en' : 'es',
    paperCount: papers.length,
    papers,
  };
}

export function createPublicListShareId(cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.getRandomValues) {
    throw new Error('Secure random IDs are not supported in this environment.');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    batch: overrides.batch || (database => writeBatch(database)),
    deleteValue: overrides.deleteValue || deleteField,
    document: overrides.document || doc,
    getDocument: overrides.getDocument || getDoc,
    now: overrides.now || serverTimestamp,
    cryptoApi: overrides.cryptoApi || globalThis.crypto,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new PublicListUnsupportedError();
}

function requireOwner(api) {
  const ownerId = cleanString(api.currentUser?.uid, 128);
  if (!ownerId) throw new Error('Authentication is required to manage a public list.');
  return ownerId;
}

function validateShareId(shareId) {
  const normalized = cleanString(shareId, 64);
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new TypeError('Invalid public list ID.');
  return normalized;
}

function validatePrivateListId(listId) {
  const normalized = cleanString(listId, 160);
  if (!normalized || normalized.includes('/')) throw new TypeError('Invalid private list ID.');
  return normalized;
}

function publicListReferences(api, ownerId, listId, shareId) {
  return {
    publicList: api.document(api.database, 'publicLists', shareId),
    owner: api.document(api.database, 'publicListOwners', shareId),
    privateList: api.document(api.database, 'users', ownerId, 'lists', listId),
  };
}

export async function publishPublicList(input, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const ownerId = requireOwner(api);
  const listId = validatePrivateListId(input?.listId);
  const shareId = createPublicListShareId(api.cryptoApi);
  const payload = sanitizePublicList(input);
  const timestamp = api.now();
  const references = publicListReferences(api, ownerId, listId, shareId);
  const batch = api.batch(api.database);

  batch.set(references.owner, { ownerId, listId, createdAt: timestamp });
  batch.set(references.publicList, {
    ...payload,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  batch.update(references.privateList, { publicShareId: shareId });
  await batch.commit();
  return { shareId, ...payload };
}

export async function updatePublicList(shareId, input, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const ownerId = requireOwner(api);
  const listId = validatePrivateListId(input?.listId);
  const normalizedShareId = validateShareId(shareId);
  const payload = sanitizePublicList(input);
  const references = publicListReferences(api, ownerId, listId, normalizedShareId);
  const batch = api.batch(api.database);

  batch.update(references.publicList, {
    ...payload,
    updatedAt: api.now(),
  });
  batch.update(references.privateList, { publicShareId: normalizedShareId });
  await batch.commit();
  return { shareId: normalizedShareId, ...payload };
}

export async function unpublishPublicList(shareId, listId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const ownerId = requireOwner(api);
  const normalizedListId = validatePrivateListId(listId);
  const normalizedShareId = validateShareId(shareId);
  const references = publicListReferences(api, ownerId, normalizedListId, normalizedShareId);
  const batch = api.batch(api.database);

  batch.delete(references.publicList);
  batch.delete(references.owner);
  batch.update(references.privateList, { publicShareId: api.deleteValue() });
  await batch.commit();
}

export async function readPublicList(shareId, overrides) {
  const api = operations(overrides);
  requireSupported(api);
  const normalizedShareId = validateShareId(shareId);
  const snapshot = await api.getDocument(api.document(api.database, 'publicLists', normalizedShareId));
  return snapshot.exists() ? { shareId: snapshot.id, ...snapshot.data() } : null;
}
