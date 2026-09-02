import { mapEuropePmcRecord } from '../utils/europePmcRecord.js';
import { PaperBuilder } from './PaperBuilder.js';
import { paperFieldsEqual } from '../utils/feedEnrichment.js';

const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CACHE_PREFIX = 'papertok_epmc_';
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
const MEMORY_CACHE = new Map();

// One reader for the payload, shared with the domain-source search mapper:
// `src/utils/europePmcRecord.js` explains why. What stays here is the shape the
// enrichment path needs -- a patch to merge onto a paper, keyed by PMID.
export function mapEuropePmcResult(result) {
  const record = mapEuropePmcRecord(result);
  const pmid = record.pmid || record.providerId;
  if (!pmid) return null;

  return {
    pmid,
    pmcid: record.pmcid || undefined,
    abstract: record.abstract,
    biomedicalTerms: record.terms,
    concepts: record.terms.map((name, index) => ({
      id: `epmc:${pmid}:${index}`,
      display_name: name,
      level: 2,
    })),
    citationCount: record.citationCount,
    openAccess: record.openAccess,
    landingPageUrl: record.openAccess ? (record.europePmcUrl || undefined) : undefined,
    openAccessPdfUrl: record.pdfUrl || undefined,
    europePmcUrl: record.europePmcUrl || undefined,
    license: record.license,
    hasReferences: record.hasReferences,
    hasData: record.hasData,
    hasSupplement: record.hasSupplement,
    accessSource: record.openAccess ? 'europepmc' : undefined,
  };
}

function readCache(pmid) {
  const memory = MEMORY_CACHE.get(pmid);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${pmid}`));
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(pmid, stored);
      return stored.value;
    }
  } catch { /* Cache is optional. */ }
  return undefined;
}

function writeCache(pmid, value) {
  const entry = { value, timestamp: Date.now(), ttl: value ? POSITIVE_TTL : NEGATIVE_TTL };
  MEMORY_CACHE.set(pmid, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${CACHE_PREFIX}${pmid}`, JSON.stringify(entry)); } catch { /* Cache is optional. */ }
  }
}

export async function enrichPubmedIds(rawPmids) {
  const pmids = [...new Set((rawPmids || []).map(value => String(value || '').trim()).filter(Boolean))];
  const results = new Map();
  const missing = [];

  pmids.forEach(pmid => {
    const cached = readCache(pmid);
    if (cached === undefined) missing.push(pmid);
    else if (cached) results.set(pmid, cached);
  });

  if (missing.length === 0) return results;

  const query = missing.map(pmid => `EXT_ID:${pmid}`).join(' OR ');
  const url = new URL(API_BASE);
  url.searchParams.set('query', `SRC:MED AND (${query})`);
  url.searchParams.set('resultType', 'core');
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageSize', String(missing.length));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Europe PMC Error: ${response.status}`);
    const payload = await response.json();
    const mappedById = new Map(
      (payload?.resultList?.result || [])
        .map(mapEuropePmcResult)
        .filter(Boolean)
        .map(item => [item.pmid, item])
    );

    missing.forEach(pmid => {
      const value = mappedById.get(pmid) || null;
      writeCache(pmid, value);
      if (value) results.set(pmid, value);
    });
  } finally {
    clearTimeout(timeout);
  }

  return results;
}

const CLOSED_RECORD_ACCESS_FIELDS = ['openAccess', 'accessSource', 'landingPageUrl'];

const normalizePmid = value => String(value || '').trim().replace(/^pmid:/i, '');

function unionStrings(base, extra) {
  return [...new Set([...(base || []), ...(extra || [])].filter(Boolean))];
}

/**
 * Late merge of Europe PMC records into an already painted page.
 *
 * ade641a took this enrichment out of PubmedAdapter.fetchSearch so PubMed
 * would stop losing the first-page race, and nothing picked it up again:
 * PubMed cards lost open access, the PMC PDF, citations and the biomedical
 * terms (audit 2026-09-02, A2). Same identity discipline as
 * mergeICiteEnrichment: a record that changes nothing returns the same
 * object, so memo(PaperCard) keeps its IntersectionObserver.
 */
export function mergeEuropePmcEnrichment(papers, recordsByPmid) {
  const lookup = recordsByPmid instanceof Map
    ? recordsByPmid
    : new Map(Object.entries(recordsByPmid || {}));
  if (lookup.size === 0) return papers;

  return papers.map((paper) => {
    const pmid = normalizePmid(paper?.pmid);
    const record = pmid ? lookup.get(pmid) : null;
    if (!record) return paper;

    // Access only ever goes UP, as the adapter code ade641a removed did:
    // PubMed marks a card open the moment a PMC id exists, and an embargoed
    // author manuscript answers isOpenAccess 'N' — handing that to
    // PaperBuilder.merge would flip the card closed a second after it
    // painted. When the record IS open, its landing page replaces PubMed's.
    let patch = record;
    if (!record.openAccess) {
      patch = { ...record };
      for (const field of CLOSED_RECORD_ACCESS_FIELDS) delete patch[field];
    }
    const merged = PaperBuilder.merge(paper, patch, 'europepmc');
    if (record.openAccess && record.landingPageUrl) merged.landingPageUrl = record.landingPageUrl;
    if (record.biomedicalTerms?.length > 0) {
      // PaperBuilder.merge unions the terms; the categories and keywords the
      // classifier reads are unioned here, the way the old adapter did.
      merged.biomedicalTerms = record.biomedicalTerms;
      merged.categories = unionStrings(merged.categories, record.biomedicalTerms);
      merged.keywords = unionStrings(merged.keywords, record.biomedicalTerms);
    }
    return paperFieldsEqual(merged, paper) ? paper : merged;
  });
}
