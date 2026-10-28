import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/open-alex-types.ts';
import type { EuropePmcRecord } from '../src/utils/europe-pmc-record.ts';
import type { WorkerEnv } from './env.ts';
import type { StoreEnv } from './paper-store.ts';

import { getMissingAbstractDois, getMissingArxivAbstractIds, getOpenAlexEnrichmentId, mergeFeedAbstracts, mergeOpenAlexEnrichment, needsOpenAlexEnrichment, normalizeEnrichmentDoi, recoverableAbstractDois } from '../src/utils/feed-enrichment.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
import { fetchInspireAbstracts } from '../src/services/inspire-abstract-service.ts';
import { normalizeScientificMarkup } from '../src/utils/latex.ts';
import { OPENALEX_ENRICHMENT_SELECT, mapOpenAlexEnrichmentWork } from '../src/utils/open-alex-work.ts';
import { mapICitePublication, mergeICiteEnrichment } from '../src/services/i-cite-records.ts';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from '../src/services/europe-pmc-records.ts';
import { withCrossrefType } from '../src/services/feed-publication-rules.ts';
import { normalizeDoi } from '../src/utils/public-navigation.ts';
import { handleHarvestOpenAlex } from './openalex-api.ts';
import { handleICite } from './source-api.ts';
import { fetchWithDeadline, reserveInternalCall } from './provider-runtime.ts';
import { database, rewriteWorks } from './paper-store.ts';
import { fetchArxivPapers } from './paper-sources.ts';

// What the feed used to add to every page it showed, added once to each stored
// paper instead: OpenAlex's citations, topics, authors and access; iCite's and
// Europe PMC's for PubMed papers; Crossref's type for OpenAlex's own records,
// which drops books; the abstracts OpenAlex's and PubMed's records lack. The
// same mappers and merges the browser ran.

const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const DAY_MS = 86_400_000;
// OpenAlex lists a new arXiv paper days after arXiv does. A paper it did not
// know yet is asked again after this many days per miss, three times at most.
const RETRY_DAYS_PER_MISS = 3;
const MAX_MISSES = 3;
// A paper enriched this long ago is asked again for its counts, after the rest.
const REFRESH_DAYS = 14;
// 25 arXiv ids are 50 landing-page values, the most one OpenAlex filter takes.
const ARXIV_CHUNK = 25;
const ID_CHUNK = 50;
const ICITE_CHUNK = 200;
const EUROPE_PMC_CHUNK = 100;
const CROSSREF_CHUNK = 20;
// The most ids Semantic Scholar's batch endpoint takes in one call.
const S2_RECOVERY_BATCH = 500;

type EnrichEnv = StoreEnv & WorkerEnv;
interface Row { id: number; paper: string; enrich_misses: number }

const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

// OpenAlex will not answer this run: its day (or the harvest's share of it) is
// spent, or it is failing. The papers still waiting for it wait for the next run.
class OpenAlexUnavailable extends Error {}

async function openAlexChunk(env: EnrichEnv, filter: string) {
  const url = new URL('https://papertok.internal/openalex/works');
  url.searchParams.set('filter', filter);
  url.searchParams.set('per_page', '50');
  url.searchParams.set('select', OPENALEX_ENRICHMENT_SELECT);
  for (let attempt = 0; ; attempt += 1) {
    // A timeout or a refused connection is OpenAlex failing, like a 5xx.
    const response = await handleHarvestOpenAlex(new Request(url), env).catch((error: Error) => {
      throw new OpenAlexUnavailable(`OpenAlex enrichment failed: ${error?.name || error}`);
    });
    if (response.ok) return (await response.json<{ results?: OpenAlexWork[] }>()).results || [];
    // A short wait (OpenAlex's own rate limit) is waited out once; a spent day
    // or harvest share, which the relay refuses with five minutes, is not.
    const wait = Number(response.headers.get('retry-after')) || 0;
    if (response.status === 429 && attempt === 0 && wait > 0 && wait <= 60) {
      await new Promise(resolve => setTimeout(resolve, wait * 1000));
      continue;
    }
    throw new OpenAlexUnavailable(`OpenAlex enrichment answered ${response.status}`);
  }
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
      // OpenAlex can hold an eprint as a work of its own beside the journal's,
      // and answer an arXiv id with both, the most cited first: a retracted
      // article's eprint record would otherwise hide the retraction.
      const keep = (key: string) => {
        if (byId[key]?.publicationStatus !== 'retracted') byId[key] = mapped.enrichment;
      };
      if (mapped.arxivId) keep(mapped.arxivId);
      const doi = normalizeDoi(work.doi || work.ids?.doi);
      if (doi) keep(`doi:${doi}`);
      keep(`openalex:${mapped.openAlexId}`);
    }
  }
  return byId;
}

async function iCiteMetrics(env: EnrichEnv, pmids: string[]) {
  const byPmid: Record<string, Partial<Paper>> = {};
  for (const chunk of chunks(pmids, ICITE_CHUNK)) {
    const response = await handleICite(new Request(`https://papertok.internal/enrich/icite?pmids=${chunk.join(',')}`), env);
    if (!response.ok) continue;
    const { data = [] } = await response.json<{ data?: Array<Record<string, unknown>> }>();
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
    const payload = await response.json<{ resultList?: { result?: EuropePmcRecord[] } }>();
    for (const record of (payload?.resultList?.result || []).map(mapEuropePmcResult)) if (record) byPmid.set(record.pmid, record);
  }
  return byPmid;
}

interface CrossrefRecord { type?: string; abstract?: string }

// Crossref's abstracts are JATS: one `<jats:abstract>` per language when a
// publisher deposits several, a heading ("Abstract") the card does not show,
// a structured abstract's sections each opening with a title, each formula
// twice inside `<jats:alternatives>` (TeX and MathML), and XML entities. The
// text keeps the first abstract, a section's title as its label ("Background:
// "), as PubMed's and Europe PMC's records keep theirs, no heading, the TeX
// spelling.
const JATS_ABSTRACT = /<(?:[a-z][\w.-]*:)?abstract(?:\s[^<>]*)?>[\s\S]*?<\/(?:[a-z][\w.-]*:)?abstract\s*>/i;
const JATS_SECTION_TITLE = /<(?:[a-z][\w.-]*:)?sec(?:\s[^<>]*)?>\s*<(?:[a-z][\w.-]*:)?title(?:\s[^<>]*)?>([\s\S]*?)<\/(?:[a-z][\w.-]*:)?title\s*>/gi;
const JATS_TITLE = /<(?:[a-z][\w.-]*:)?title(?:\s[^<>]*)?>[\s\S]*?<\/(?:[a-z][\w.-]*:)?title\s*>/gi;

// A publisher may wrap the abstract's own heading in a section too.
const JATS_HEADINGS = new Set(['abstract', 'summary']);

function sectionLabel(_match: string, title: string) {
  const label = normalizeScientificMarkup(title);
  if (!label || JATS_HEADINGS.has(label.replace(/[:.]$/, '').toLowerCase())) return ' ';
  return ` ${title.trim()}${/[:.]$/.test(label) ? '' : ':'} `;
}

function crossrefAbstractText(jats: unknown) {
  const deposit = String(jats || '');
  const first = JATS_ABSTRACT.exec(deposit)?.[0] ?? deposit;
  return normalizeScientificMarkup(first
    .replace(JATS_SECTION_TITLE, sectionLabel)
    .replace(JATS_TITLE, ' ')
    .replace(/<\/(?:[a-z][\w.-]*:)?(?:p|sec)\s*>/gi, ' '));
}

/** Crossref's type of each work, and its abstract when Crossref has a usable one, by DOI. */
async function crossrefRecords(dois: string[]) {
  const records = new Map<string, CrossrefRecord>();
  for (const chunk of chunks(dois, CROSSREF_CHUNK)) {
    const url = new URL('https://api.crossref.org/works');
    url.search = new URLSearchParams({
      filter: chunk.map(doi => `doi:${doi}`).join(','),
      select: 'DOI,type,abstract',
      rows: String(chunk.length),
      mailto: 'app@papertok.io',
    }).toString();
    const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 15_000);
    if (!response.ok) continue;
    const payload = await response.json<{ message?: { items?: Array<{ DOI?: unknown; type?: unknown; abstract?: unknown }> } }>();
    for (const work of payload?.message?.items || []) {
      const doi = normalizeDoi(work?.DOI);
      if (!chunk.includes(doi)) continue;
      const type = typeof work?.type === 'string' && /^[a-z-]+$/.test(work.type) ? work.type : undefined;
      const abstract = crossrefAbstractText(work?.abstract);
      records.set(doi, { type, abstract: hasUsableAIAbstract(abstract) ? abstract : undefined });
    }
  }
  return records;
}

/**
 * Semantic Scholar's abstracts for up to S2_RECOVERY_BATCH DOIs, in one batch
 * call within the `s2` allowance readers' related papers spend. A refused
 * reservation sends nothing; a refused or failed call recovers nothing.
 */
async function semanticScholarAbstracts(env: EnrichEnv, dois: string[]): Promise<Partial<Paper>[]> {
  const asked = dois.slice(0, S2_RECOVERY_BATCH);
  if (!(await reserveInternalCall('/enrich/s2', env))) return [];
  const response = await fetchWithDeadline('https://api.semanticscholar.org/graph/v1/paper/batch?fields=externalIds,abstract', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      ...(env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {}),
    },
    body: JSON.stringify({ ids: asked.map(doi => `DOI:${doi}`) }),
  }, 15_000);
  if (!response.ok) return [];
  const payload = await response.json<Array<{ externalIds?: { DOI?: unknown }; abstract?: unknown } | null>>();
  // An unknown id answers null; a record names the DOI it is for.
  return (Array.isArray(payload) ? payload : []).flatMap(record => {
    const doi = normalizeDoi(record?.externalIds?.DOI);
    if (!asked.includes(doi) || typeof record?.abstract !== 'string') return [];
    return [{ doi, abstract: record.abstract, sources: { primary: 'semanticscholar', enrichedBy: [] } }];
  });
}

interface PendingRow extends Row { refresh: boolean }

async function pendingRows(db: D1Database, limit: number, now: number): Promise<PendingRow[]> {
  const { results: fresh } = await db.prepare(`SELECT id, paper, enrich_misses FROM works
    WHERE enriched_at IS NULL ORDER BY published DESC LIMIT ?`).bind(limit).all<Row>();
  const rows: PendingRow[] = fresh.map(row => ({ ...row, refresh: false }));
  if (rows.length >= limit) return rows;
  // Each miss waits RETRY_DAYS_PER_MISS days longer than the one before.
  const { results: retries } = await db.prepare(`SELECT id, paper, enrich_misses, enriched_at FROM works
    WHERE enrich_misses BETWEEN 1 AND ? AND enriched_at < ? ORDER BY enriched_at LIMIT ?`)
    .bind(MAX_MISSES, new Date(now - RETRY_DAYS_PER_MISS * DAY_MS).toISOString(), limit * 4).all<Row & { enriched_at: string }>();
  rows.push(...retries
    .filter(row => Date.parse(row.enriched_at) <= now - row.enrich_misses * RETRY_DAYS_PER_MISS * DAY_MS)
    .slice(0, limit - rows.length)
    .map(({ id, paper, enrich_misses }) => ({ id, paper, enrich_misses, refresh: false })));
  if (rows.length >= limit) return rows;
  // Last, the counts that have aged: a paper's citations grow in its first months.
  const { results: stale } = await db.prepare(`SELECT id, paper, enrich_misses FROM works
    WHERE enrich_misses = 0 AND enriched_at < ? ORDER BY enriched_at LIMIT ?`)
    .bind(new Date(now - REFRESH_DAYS * DAY_MS).toISOString(), limit - rows.length).all<Row>();
  rows.push(...stale.map(row => ({ ...row, refresh: true })));
  return rows;
}

/**
 * Enriches up to `limit` stored papers, newest first: the ones never enriched,
 * then OpenAlex's misses whose wait is over, then counts older than
 * REFRESH_DAYS. Returns the processed works for immediate embedding, and
 * whether OpenAlex stopped the pass. A source that fails leaves its fields
 * unknown; a paper waiting for OpenAlex is not marked done without it.
 */
export async function enrichPending(env: EnrichEnv, limit: number, now = Date.now()) {
  const db = database(env);
  const rows = await pendingRows(db, limit, now);
  if (rows.length === 0) return { workIds: [], stop: true };
  const papers = rows.map(row => JSON.parse(row.paper) as Paper);
  const asksOpenAlex = rows.map((row, index) => (row.refresh || needsOpenAlexEnrichment(papers[index])) && Boolean(getOpenAlexEnrichmentId(papers[index])));
  // A paper asked by its arXiv id is also asked by its journal's DOI: OpenAlex
  // can hold the journal's article as a work of its own, without the arXiv
  // location, and only that work then says it is retracted. Only the
  // retraction is taken from it. One call per 50 such papers, in the same budget.
  const journalDois = papers.map((paper, index) => (asksOpenAlex[index] && !getOpenAlexEnrichmentId(paper).includes(':')
    ? normalizeEnrichmentDoi(paper.doi) : ''));

  let openAlex: Record<string, Partial<Paper>> = {};
  let openAlexAnswered = true;
  try {
    openAlex = await openAlexEnrichments(env, [...new Set([
      ...papers.filter((_, index) => asksOpenAlex[index]).map(getOpenAlexEnrichmentId),
      ...journalDois.filter(Boolean).map(doi => `doi:${doi}`),
    ])]);
  } catch (error) {
    if (!(error instanceof OpenAlexUnavailable)) throw error;
    console.warn('OpenAlex enrichment stopped for this run', error.message);
    openAlexAnswered = false;
  }
  const pmids = [...new Set(papers.map(paper => paper.pmid).filter(Boolean) as string[])];
  const [iCite, europePmc] = await Promise.all([
    pmids.length ? iCiteMetrics(env, pmids).catch(() => ({})) : {},
    pmids.length ? europePmcRecords(pmids).catch(() => new Map()) : new Map(),
  ]);
  let enriched = mergeOpenAlexEnrichment(papers, openAlex);
  // Set after the merge rather than merged as OpenAlex's record: a paper
  // OpenAlex does not know by its arXiv id has had no OpenAlex enrichment, so
  // it does not list OpenAlex in `sources.enrichedBy`, and it counts a miss.
  enriched = enriched.map((paper, index): Paper => (journalDois[index] && paper.publicationStatus !== 'retracted'
    && openAlex[`doi:${journalDois[index]}`]?.publicationStatus === 'retracted' ? { ...paper, publicationStatus: 'retracted' } : paper));
  enriched = mergeICiteEnrichment(enriched, iCite);
  enriched = mergeEuropePmcEnrichment(enriched, europePmc);
  // The abstract of an OpenAlex or PubMed paper listed without one, from the
  // first source that has it: arXiv's own text for an OpenAlex paper on arXiv,
  // INSPIRE's by DOI for an OpenAlex physics paper, then Crossref's publisher
  // record, which the type call below brings, and last Semantic Scholar's. Semantic Scholar is one
  // batch call a step: it shares a one-a-second allowance with readers'
  // related papers. A source that fails recovers nothing; the paper keeps no
  // abstract and the refresh asks again.
  const missingArxiv = getMissingArxivAbstractIds(enriched);
  const missingDois = getMissingAbstractDois(enriched);
  const recovered = [
    ...(missingArxiv.length ? await fetchArxivPapers(env, missingArxiv).catch(() => []) : []),
    ...(missingDois.length ? await fetchInspireAbstracts(missingDois).catch(() => []) : []),
  ];
  if (recovered.length) enriched = mergeFeedAbstracts(enriched, recovered);
  // Crossref is asked for every OpenAlex paper's type, and for the abstract of
  // any other paper that awaits one (a PubMed paper's); only an OpenAlex
  // paper takes the type.
  const crossrefDois = [...new Set([...enriched
    .filter(paper => paper.sources?.primary === 'openalex')
    .map(paper => normalizeDoi(paper.doi)), ...recoverableAbstractDois(enriched)]
    .filter(doi => doi && !doi.includes(',') && doi.length <= 240))];
  const crossref = crossrefDois.length ? await crossrefRecords(crossrefDois).catch(() => new Map<string, CrossrefRecord>()) : new Map<string, CrossrefRecord>();
  enriched = enriched.map(paper => withCrossrefType(paper, paper.sources?.primary === 'openalex' ? crossref.get(normalizeDoi(paper.doi))?.type : undefined));
  enriched = mergeFeedAbstracts(enriched, [...crossref].flatMap(([doi, { abstract }]) => (abstract ? [{ doi, abstract, sources: { primary: 'crossref', enrichedBy: [] } }] : [])));
  const stillMissing = recoverableAbstractDois(enriched);
  if (stillMissing.length) enriched = mergeFeedAbstracts(enriched, await semanticScholarAbstracts(env, stillMissing).catch(() => []));

  await rewriteWorks(env, rows.map((row, index) => ({ id: row.id, before: papers[index], after: enriched[index] })), now);
  // A paper OpenAlex should have known but did not counts a miss. One waiting
  // for an OpenAlex that did not answer is left for the next run.
  const marks = rows.flatMap((row, index) => {
    if (asksOpenAlex[index] && !openAlexAnswered) return [];
    const missed = !row.refresh && asksOpenAlex[index] && needsOpenAlexEnrichment(enriched[index]);
    return [{ id: row.id, misses: missed ? row.enrich_misses + 1 : 0 }];
  });
  if (marks.length) {
    await db.batch(chunks(marks, 200).map(chunk => db.prepare(`UPDATE works SET enriched_at = ?, enrich_misses = j.value ->> 'misses'
      FROM json_each(?) j WHERE works.id = j.value ->> 'id'`).bind(new Date(now).toISOString(), JSON.stringify(chunk))));
  }
  return { workIds: rows.map(row => row.id), stop: !openAlexAnswered };
}
