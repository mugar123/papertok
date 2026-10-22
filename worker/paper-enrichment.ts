import type { Paper } from '../src/models/Paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/openAlexTypes.ts';
import type { EuropePmcRecord } from '../src/utils/europePmcRecord.ts';
import type { WorkerEnv } from './env.ts';
import type { StoreEnv } from './paper-store.ts';

import { getOpenAlexEnrichmentId, mergeOpenAlexEnrichment, needsOpenAlexEnrichment } from '../src/utils/feedEnrichment.ts';
import { OPENALEX_ENRICHMENT_SELECT, mapOpenAlexEnrichmentWork } from '../src/utils/openAlexWork.ts';
import { mapICitePublication, mergeICiteEnrichment } from '../src/services/iCiteRecords.ts';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from '../src/services/europePmcRecords.ts';
import { withCrossrefType } from '../src/services/feedPublicationRules.ts';
import { normalizeDoi } from '../src/utils/publicNavigation.ts';
import { handleOpenAlex } from './openalex-api.ts';
import { handleICite } from './source-api.ts';
import { fetchWithDeadline } from './provider-runtime.ts';
import { database, rewriteWorks } from './paper-store.ts';

// What the feed used to add to every page it showed, added once to each stored
// paper instead: OpenAlex's citations, topics, authors and access; iCite's and
// Europe PMC's for PubMed papers; Crossref's type for OpenAlex's own records,
// which drops books. The same mappers and merges the browser ran.

const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const DAY_MS = 86_400_000;
// OpenAlex lists a new arXiv paper days after arXiv does. A paper it did not
// know yet is asked again after this many days per miss, three times at most.
const RETRY_DAYS_PER_MISS = 3;
const MAX_MISSES = 3;
// 25 arXiv ids are 50 landing-page values, the most one OpenAlex filter takes.
const ARXIV_CHUNK = 25;
const ID_CHUNK = 50;
const ICITE_CHUNK = 200;
const EUROPE_PMC_CHUNK = 100;
const CROSSREF_CHUNK = 20;

type EnrichEnv = StoreEnv & WorkerEnv;
interface Row { id: number; paper: string; enrich_misses: number }

const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

class BudgetSpent extends Error {}

async function openAlexChunk(env: EnrichEnv, filter: string) {
  const url = new URL('https://papertok.internal/openalex/works');
  url.searchParams.set('filter', filter);
  url.searchParams.set('per_page', '50');
  url.searchParams.set('select', OPENALEX_ENRICHMENT_SELECT);
  const response = await handleOpenAlex(new Request(url), env);
  // The day's OpenAlex budget is spent: the rest waits for tomorrow's run.
  if (response.status === 429) throw new BudgetSpent();
  if (!response.ok) throw new Error(`OpenAlex enrichment answered ${response.status}`);
  return ((await response.json()) as { results?: OpenAlexWork[] }).results || [];
}

/** OpenAlex's enrichment of each paper, keyed as `getOpenAlexEnrichmentId` names it. */
async function openAlexEnrichments(env: EnrichEnv, ids: string[]) {
  const arxivIds = ids.filter(id => !id.startsWith('doi:') && !id.startsWith('openalex:'));
  const dois = ids.filter(id => id.startsWith('doi:')).map(id => id.slice(4));
  const openAlexIds = ids.filter(id => id.startsWith('openalex:')).map(id => id.slice('openalex:'.length));
  const filters = [
    ...chunks(arxivIds, ARXIV_CHUNK).map(chunk => `locations.landing_page_url:${chunk.flatMap(id => [`http://arxiv.org/abs/${id}`, `https://arxiv.org/abs/${id}`]).join('|')}`),
    ...chunks(dois, ID_CHUNK).map(chunk => `doi:${chunk.join('|')}`),
    ...chunks(openAlexIds, ID_CHUNK).map(chunk => `openalex:${chunk.join('|')}`),
  ];
  const byId: Record<string, Partial<Paper>> = {};
  for (const filter of filters) {
    for (const work of await openAlexChunk(env, filter)) {
      const mapped = mapOpenAlexEnrichmentWork(work);
      if (!mapped) continue;
      if (mapped.arxivId) byId[mapped.arxivId] = mapped.enrichment;
      const doi = normalizeDoi(work.doi || work.ids?.doi);
      if (doi) byId[`doi:${doi}`] = mapped.enrichment;
      byId[`openalex:${mapped.openAlexId}`] = mapped.enrichment;
    }
  }
  return byId;
}

async function iCiteMetrics(env: EnrichEnv, pmids: string[]) {
  const byPmid: Record<string, Partial<Paper>> = {};
  for (const chunk of chunks(pmids, ICITE_CHUNK)) {
    const response = await handleICite(new Request(`https://papertok.internal/enrich/icite?pmids=${chunk.join(',')}`), env);
    if (!response.ok) continue;
    const { data = [] } = await response.json() as { data?: Array<Record<string, unknown>> };
    for (const item of data.map(mapICitePublication)) if (item) byPmid[item.pmid] = item;
  }
  return byPmid;
}

async function europePmcRecords(pmids: string[]) {
  const byPmid = new Map<string, NonNullable<ReturnType<typeof mapEuropePmcResult>>>();
  for (const chunk of chunks(pmids, EUROPE_PMC_CHUNK)) {
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    url.searchParams.set('query', `SRC:MED AND (${chunk.map(pmid => `EXT_ID:${pmid}`).join(' OR ')})`);
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageSize', String(chunk.length));
    const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 15_000);
    if (!response.ok) continue;
    const payload = await response.json() as { resultList?: { result?: EuropePmcRecord[] } };
    for (const record of (payload?.resultList?.result || []).map(mapEuropePmcResult)) if (record) byPmid.set(record.pmid, record);
  }
  return byPmid;
}

async function crossrefTypes(dois: string[]) {
  const types = new Map<string, string>();
  for (const chunk of chunks(dois, CROSSREF_CHUNK)) {
    const url = new URL('https://api.crossref.org/works');
    url.search = new URLSearchParams({
      filter: chunk.map(doi => `doi:${doi}`).join(','),
      select: 'DOI,type',
      rows: String(chunk.length),
      mailto: 'app@papertok.io',
    }).toString();
    const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 15_000);
    if (!response.ok) continue;
    const payload = await response.json() as { message?: { items?: Array<{ DOI?: unknown; type?: unknown }> } };
    for (const work of payload?.message?.items || []) {
      const doi = normalizeDoi(work?.DOI);
      if (chunk.includes(doi) && typeof work?.type === 'string' && /^[a-z-]+$/.test(work.type)) types.set(doi, work.type);
    }
  }
  return types;
}

async function pendingRows(db: D1Database, limit: number, now: number) {
  const { results: fresh } = await db.prepare(`SELECT id, paper, enrich_misses FROM works
    WHERE enriched_at IS NULL ORDER BY published DESC LIMIT ?`).bind(limit).all<Row>();
  if (fresh.length >= limit) return fresh;
  // Each miss waits RETRY_DAYS_PER_MISS days longer than the one before.
  const { results: retries } = await db.prepare(`SELECT id, paper, enrich_misses, enriched_at FROM works
    WHERE enrich_misses BETWEEN 1 AND ? AND enriched_at < ? ORDER BY enriched_at LIMIT ?`)
    .bind(MAX_MISSES, new Date(now - RETRY_DAYS_PER_MISS * DAY_MS).toISOString(), limit * 4).all<Row & { enriched_at: string }>();
  const due = retries.filter(row => Date.parse(row.enriched_at) <= now - row.enrich_misses * RETRY_DAYS_PER_MISS * DAY_MS);
  return [...fresh, ...due.slice(0, limit - fresh.length)];
}

/**
 * Enriches up to `limit` stored papers not enriched yet, newest first, and
 * reports how many it went through: 0 once none are waiting or OpenAlex's
 * budget for the day is spent. A source that fails leaves its fields unknown.
 */
export async function enrichPending(env: EnrichEnv, limit: number, now = Date.now()) {
  const db = database(env);
  const rows = await pendingRows(db, limit, now);
  if (rows.length === 0) return 0;
  const papers = rows.map(row => JSON.parse(row.paper) as Paper);

  let openAlex: Record<string, Partial<Paper>> = {};
  let spent = false;
  try {
    openAlex = await openAlexEnrichments(env, [...new Set(papers.filter(needsOpenAlexEnrichment).map(getOpenAlexEnrichmentId).filter(Boolean))]);
  } catch (error) {
    if (!(error instanceof BudgetSpent)) throw error;
    spent = true;
  }
  const pmids = [...new Set(papers.map(paper => paper.pmid).filter(Boolean) as string[])];
  const [iCite, europePmc] = await Promise.all([
    pmids.length ? iCiteMetrics(env, pmids).catch(() => ({})) : {},
    pmids.length ? europePmcRecords(pmids).catch(() => new Map()) : new Map(),
  ]);
  let enriched = mergeOpenAlexEnrichment(papers, openAlex);
  enriched = mergeICiteEnrichment(enriched, iCite);
  enriched = mergeEuropePmcEnrichment(enriched, europePmc);
  const crossrefDois = [...new Set(enriched
    .filter(paper => paper.sources?.primary === 'openalex')
    .map(paper => normalizeDoi(paper.doi))
    .filter(doi => doi && !doi.includes(',') && doi.length <= 240))];
  const types = crossrefDois.length ? await crossrefTypes(crossrefDois).catch(() => new Map<string, string>()) : new Map<string, string>();
  enriched = enriched.map(paper => withCrossrefType(paper, types.get(normalizeDoi(paper.doi))));

  await rewriteWorks(env, rows.map((row, index) => ({ id: row.id, before: papers[index], after: enriched[index] })));
  // A paper OpenAlex should have known but did not counts a miss; one it was
  // not asked about (the budget ran out) is left as it was.
  const attempted = spent ? [] : rows;
  const statements = attempted.map((row, index) => {
    const missed = needsOpenAlexEnrichment(papers[index]) && needsOpenAlexEnrichment(enriched[index]);
    return db.prepare('UPDATE works SET enriched_at = ?, enrich_misses = ? WHERE id = ?')
      .bind(new Date(now).toISOString(), missed ? row.enrich_misses + 1 : 0, row.id);
  });
  for (const chunk of chunks(statements, 50)) await db.batch(chunk);
  return spent ? 0 : rows.length;
}
