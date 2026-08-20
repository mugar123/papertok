/**
 * Paper stubs (P5): the shared document a comment thread hangs off.
 *
 * The app stores no papers. A stub is a minimal cache of public metadata,
 * keyed by the canonical identity (`src/utils/paperCanonicalKey.js`), created
 * lazily by the first person who comments — never by browsing, so the feed's
 * cost does not move. The stub is immutable after creation (rules): its
 * title is what every reader of the thread sees, and a rewritable cache
 * would be a defacement surface.
 *
 * Nothing here is imported by the feed. A feed load still costs one read.
 */

import { doc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, IS_DEMO } from './firebase.js';
import {
  candidateStubIdentities,
  canonicalArxivIdOf,
  canonicalDoiOf,
  canonicalPaperIdentity,
  keyFromIdentity,
} from '../utils/paperCanonicalKey.js';

export const PAPER_STUB_LIMITS = Object.freeze({
  title: 500,
  authors: 20,
  authorLength: 160,
  category: 120,
  abstract: 1500,
  openUrl: 2000,
});

export class PaperStubUnsupportedError extends Error {
  constructor() {
    super('Paper threads are unavailable in demo mode.');
    this.name = 'PaperStubUnsupportedError';
    this.code = 'STUBS_UNSUPPORTED_IN_DEMO';
  }
}

function cleanText(value, maximum) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function cleanAuthors(authors) {
  if (!Array.isArray(authors)) return [];
  return authors
    .map(author => cleanText(
      typeof author === 'string' ? author : author?.name,
      PAPER_STUB_LIMITS.authorLength,
    ))
    .filter(Boolean)
    .slice(0, PAPER_STUB_LIMITS.authors);
}

function cleanYear(value) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null;
}

function cleanOpenUrl(paper) {
  for (const candidate of [paper?.landingPageUrl, paper?.openUrl, paper?.pdfUrl]) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (/^https:\/\/\S+$/.test(url) && url.length <= PAPER_STUB_LIMITS.openUrl) return url;
  }
  return null;
}

/**
 * The stub document for a paper object, without the write-time fields
 * (`createdAt`/`createdBy` belong to the batch that creates it). Null when the
 * paper identifies nothing or has no title — such an object cannot anchor a
 * thread anyone else could find again.
 *
 * The identifier fields come from the same normalizers as the key, because
 * the rules refuse a stub whose `doi`/`arxivId` disagree with its
 * `canonicalKey`.
 */
export function buildPaperStubData(paper) {
  const canonicalKey = canonicalPaperIdentity(paper);
  const title = cleanText(paper?.title, PAPER_STUB_LIMITS.title);
  if (!canonicalKey || !title) return null;

  const doi = canonicalDoiOf(paper);
  const arxivId = canonicalArxivIdOf(paper);
  const year = cleanYear(paper?.year);
  const category = cleanText(paper?.category || paper?.primaryCategory, PAPER_STUB_LIMITS.category);
  const abstract = cleanText(paper?.abstract || paper?.summary, PAPER_STUB_LIMITS.abstract);
  const openUrl = cleanOpenUrl(paper);

  return {
    canonicalKey,
    title,
    authors: cleanAuthors(paper?.authors),
    ...(year !== null ? { year } : {}),
    ...(category ? { category } : {}),
    ...(abstract ? { abstract } : {}),
    ...(doi ? { doi } : {}),
    ...(arxivId ? { arxivId } : {}),
    ...(openUrl ? { openUrl } : {}),
  };
}

function operations(overrides = {}) {
  return {
    database: overrides.database || db,
    currentUser: overrides.currentUser === undefined ? auth.currentUser : overrides.currentUser,
    isDemo: overrides.isDemo === undefined ? IS_DEMO : overrides.isDemo,
    document: overrides.document || doc,
    getDocument: overrides.getDocument || getDoc,
    now: overrides.now || serverTimestamp,
  };
}

function requireSupported(api) {
  if (api.isDemo) throw new PaperStubUnsupportedError();
}

export function stubReference(api, paperKey) {
  return api.document(api.database, 'papers', paperKey);
}

/**
 * Where this paper's thread lives, and whether it exists yet.
 *
 * Reads the stub under the primary (most canonical) key, and — only when the
 * object carries a second identity — under the alternate keys too: a reader
 * whose copy of the paper lacked the DOI may have opened the thread under the
 * arXiv key, and those comments must not be invisible (the split-brain
 * mitigation in 00-ARCHITECTURE.md). One read in the common case, two when
 * the object is dual-identity.
 *
 * New comments always go to the primary key; the alternates are read-only
 * carriers of what history already wrote.
 */
export async function resolveThreadAnchor(paper, overrides) {
  const api = operations(overrides);
  requireSupported(api);

  const identities = candidateStubIdentities(paper);
  if (!identities.length) return null;

  const [primaryIdentity, ...alternateIdentities] = identities;
  const primaryKey = keyFromIdentity(primaryIdentity);
  const primarySnapshot = await api.getDocument(stubReference(api, primaryKey));

  // Concurrently: the alternates are independent documents, and awaiting them
  // one at a time made a dual-identity paper pay two round trips end to end
  // before its sheet could show anything.
  const alternateSnapshots = await Promise.all(alternateIdentities.map(async (identity) => {
    const key = keyFromIdentity(identity);
    return { key, identity, snapshot: await api.getDocument(stubReference(api, key)) };
  }));
  const alternates = alternateSnapshots
    .filter(entry => entry.snapshot?.exists())
    .map(entry => ({ key: entry.key, identity: entry.identity, stub: entry.snapshot.data() }));

  return {
    key: primaryKey,
    identity: primaryIdentity,
    stubExists: Boolean(primarySnapshot?.exists()),
    stub: primarySnapshot?.exists() ? primarySnapshot.data() : null,
    alternates,
  };
}
