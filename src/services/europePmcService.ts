import type { EuropePmcRecord } from '../utils/europePmcRecord.ts';
type Enrichment = EuropePmcEnrichment;
interface CacheEntry { value: Enrichment | null; timestamp: number; ttl: number; }

import { mapEuropePmcResult, type EuropePmcEnrichment } from './europePmcRecords.ts';

const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CACHE_PREFIX = 'papertok_epmc_';
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
const MEMORY_CACHE = new Map<string, CacheEntry>();

function readCache(pmid: string) {
  const memory = MEMORY_CACHE.get(pmid);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${pmid}`)!) as CacheEntry | null;
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(pmid, stored);
      return stored.value;
    }
  } catch { /* Cache is optional. */ }
  return undefined;
}

function writeCache(pmid: string, value: Enrichment | null) {
  const entry = { value, timestamp: Date.now(), ttl: value ? POSITIVE_TTL : NEGATIVE_TTL };
  MEMORY_CACHE.set(pmid, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${CACHE_PREFIX}${pmid}`, JSON.stringify(entry)); } catch { /* Cache is optional. */ }
  }
}

export async function enrichPubmedIds(rawPmids: string[]) {
  const pmids = [...new Set((rawPmids || []).map(value => String(value || '').trim()).filter(Boolean))];
  const results = new Map<string, Enrichment>();
  const missing: string[] = [];

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
    const payload = await response.json() as { resultList?: { result?: EuropePmcRecord[] } };
    const mappedById = new Map(
      ((payload?.resultList?.result || [])
        .map(mapEuropePmcResult)
        .filter(Boolean) as Enrichment[])
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
