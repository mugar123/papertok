import type { Paper } from '../src/models/paper.ts';
import type { OpenAlexWork } from '../src/services/adapters/open-alex-types.ts';
import type { EuropePmcRecord } from '../src/utils/europe-pmc-record.ts';
import type { WorkerEnv } from './env.ts';
import type { StoreEnv } from './paper-store.ts';

import { getMissingAbstractDois, getMissingArxivAbstractIds, getOpenAlexEnrichmentId, mergeFeedAbstracts, mergeOpenAlexEnrichment, needsOpenAlexEnrichment, normalizeEnrichmentDoi, recoverableAbstractDois } from '../src/utils/feed-enrichment.ts';
import { hasUsableAIAbstract } from '../src/utils/ai-explanation-access.ts';
import { fetchInspireAbstracts } from '../src/services/inspire-abstract-service.ts';
import { normalizeScientificMarkup } from '../src/utils/latex.ts';
import { typeHasAbstract } from '../src/utils/open-alex-abstract.ts';
import { OPENALEX_ENRICHMENT_SELECT, mapOpenAlexEnrichmentWork } from '../src/utils/open-alex-work.ts';
import { mapICitePublication, mergeICiteEnrichment } from '../src/services/i-cite-records.ts';
import { mapEuropePmcResult, mergeEuropePmcEnrichment } from '../src/services/europe-pmc-records.ts';
import { withCrossrefType } from '../src/services/feed-publication-rules.ts';
import { normalizeDoi } from '../src/utils/public-navigation.ts';
import { OPENALEX_PARAM_MAX_LENGTH, handleHarvestOpenAlex } from './openalex-api.ts';
import { handleICite } from './source-api.ts';
import { fetchWithDeadline, reserveInternalCall } from './provider-runtime.ts';
import { database, rewriteWorks } from './paper-store.ts';
import { fetchArxivPapers } from './paper-sources.ts';

// What the feed used to add to every page it showed, added once to each stored
// paper instead: OpenAlex's citations, topics, authors and access; iCite's and
// Europe PMC's for PubMed papers; Crossref's type for OpenAlex's own records,
// which drops books; the abstracts the sources' records lack, asked again
// while a paper is young. The same mappers and merges the browser ran.

const USER_AGENT = 'PaperTok/1.0 (mailto:app@papertok.io)';
const DAY_MS = 86_400_000;
// OpenAlex lists a new arXiv paper days after arXiv does. A paper it did not
// know yet is asked again after this many days per miss, three times at most.
const RETRY_DAYS_PER_MISS = 3;
const MAX_MISSES = 3;
// A paper enriched this long ago is asked again for its counts, after the rest.
const REFRESH_DAYS = 14;
// A paper stored without an abstract is asked again each time it passes one of
// these ages, in days from its date, after its last enrichment: about five
// asks in its first two and a half weeks, while OpenAlex, PubMed and Semantic
// Scholar can still add an abstract their first records lacked. After the
// last, only the refresh asks again.
const ABSTRACT_RETRY_DAYS = [1, 2, 4, 8, 16];
// `enrich_misses` of a paper no enrichment of which has been counted: a failed
// source cut short its first enrichment, and every one since. It is no miss of
// OpenAlex's; the column holds it so that the paper's enrichment date can say
// when it was last asked. The next enrichment no source interrupts sets 0.
const UNCOUNTED = -1;
// The OpenAlex calls one harvest run's abstract retries may make, out of the
// run's share (paper-harvest.ts): about 15,000 papers asked by their OpenAlex
// ids. Each step's retries are counted as if they were asked apart. Every full
// run starts with them, a second one on the same UTC day too.
const ABSTRACT_RETRY_UNITS = 300;
// 25 arXiv ids are 50 landing-page values, the most one OpenAlex filter takes.
const ARXIV_CHUNK = 25;
const ID_CHUNK = 50;
const ICITE_CHUNK = 200;
const EUROPE_PMC_CHUNK = 100;
const CROSSREF_CHUNK = 20;
// The most ids Semantic Scholar's batch endpoint takes in one call.
const S2_RECOVERY_BATCH = 500;

type EnrichEnv = StoreEnv & WorkerEnv;
interface Row { id: number; paper: string; enrich_misses: number; published: string; enriched_at: string | null }

const chunks = <T>(values: T[], size: number) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));

// Filters on `key`, each with at most `perFilter` of the values and no longer
// than the relay forwards: it drops a longer filter, and the request would go
// out unfiltered and find none of the papers. 50 DOIs of 50 characters are
// already too long for one. A value too long for a filter of its own is not asked.
function openAlexFilters(key: string, values: string[], perFilter: number) {
  const filters: string[] = [];
  let count = 0;
  for (const value of values) {
    const alone = `${key}:${value}`;
    if (alone.length > OPENALEX_PARAM_MAX_LENGTH) continue;
    const joined = `${filters.at(-1)}|${value}`;
    if (count > 0 && count < perFilter && joined.length <= OPENALEX_PARAM_MAX_LENGTH) {
      filters[filters.length - 1] = joined;
      count += 1;
    } else {
      filters.push(alone);
      count = 1;
    }
  }
  return filters;
}

// OpenAlex will not answer this run: its day (or the harvest's share of it) is
// spent, or it is failing. The papers still waiting for it wait for the next run.
class OpenAlexUnavailable extends Error {}

async function openAlexChunk(env: EnrichEnv, filter: string) {
  const url = new URL('https://papertok.internal/openalex/works');
  url.searchParams.set('filter', filter);
  // Twice the values a filter holds: OpenAlex can answer one value with two
  // works (an eprint beside the journal's article, a duplicate DOI record), and
  // a full page would leave the last papers' works, retractions included, out.
  url.searchParams.set('per_page', '100');
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

/** The filters OpenAlex is asked for these ids, as `getOpenAlexEnrichmentId` names them: one call each. */
function openAlexRequests(ids: string[]) {
  const arxivIds = ids.filter(id => !id.startsWith('doi:') && !id.startsWith('openalex:'));
  const dois = ids.filter(id => id.startsWith('doi:')).map(id => id.slice(4));
  const openAlexIds = ids.filter(id => id.startsWith('openalex:')).map(id => id.slice('openalex:'.length));
  return [
    ...openAlexFilters('locations.landing_page_url', arxivIds.map(id => `http://arxiv.org/abs/${id}|https://arxiv.org/abs/${id}`), ARXIV_CHUNK),
    ...openAlexFilters('doi', dois, ID_CHUNK),
    ...openAlexFilters('openalex', openAlexIds, ID_CHUNK),
  ];
}

/** OpenAlex's enrichment of each paper, keyed as `getOpenAlexEnrichmentId` names it. */
async function openAlexEnrichments(env: EnrichEnv, ids: string[]) {
  const byId: Record<string, Partial<Paper>> = {};
  for (const filter of openAlexRequests(ids)) {
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

/** Europe PMC's record of each PubMed id, and the ids it did not answer. */
async function europePmcRecords(pmids: string[]) {
  const records = new Map<string, NonNullable<ReturnType<typeof mapEuropePmcResult>>>();
  const failed = new Set<string>();
  const searches = chunks(pmids, EUROPE_PMC_CHUNK);
  for (const [index, chunk] of searches.entries()) {
    const url = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    url.searchParams.set('query', `SRC:MED AND (${chunk.map(pmid => `EXT_ID:${pmid}`).join(' OR ')})`);
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('format', 'json');
    url.searchParams.set('pageSize', String(chunk.length));
    try {
      const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 15_000);
      if (!response.ok) {
        // A refusal costs only its own ids.
        for (const pmid of chunk) failed.add(pmid);
        continue;
      }
      const payload = await response.json<{ resultList?: { result?: EuropePmcRecord[] } }>();
      for (const record of (payload?.resultList?.result || []).map(mapEuropePmcResult)) if (record) records.set(record.pmid, record);
    } catch {
      // A search that fails or times out ends Europe PMC for the step: in an
      // outage each later search would wait out its own deadline too. The
      // records already found are kept; its ids and those of the searches not
      // sent count as unanswered.
      for (const pmid of searches.slice(index).flat()) failed.add(pmid);
      break;
    }
  }
  return { records, failed };
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

/** Crossref's type of each work, and its abstract when Crossref has a usable one, by DOI, and the DOIs it did not answer. */
async function crossrefRecords(dois: string[]) {
  const records = new Map<string, CrossrefRecord>();
  const failed = new Set<string>();
  const calls = chunks(dois, CROSSREF_CHUNK);
  for (const [index, chunk] of calls.entries()) {
    const url = new URL('https://api.crossref.org/works');
    url.search = new URLSearchParams({
      filter: chunk.map(doi => `doi:${doi}`).join(','),
      select: 'DOI,type,abstract',
      rows: String(chunk.length),
      mailto: 'app@papertok.io',
    }).toString();
    try {
      const response = await fetchWithDeadline(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 15_000);
      if (!response.ok) {
        // A refusal costs only its own DOIs.
        for (const doi of chunk) failed.add(doi);
        continue;
      }
      const payload = await response.json<{ message?: { items?: Array<{ DOI?: unknown; type?: unknown; abstract?: unknown }> } }>();
      for (const work of payload?.message?.items || []) {
        const doi = normalizeDoi(work?.DOI);
        if (!chunk.includes(doi)) continue;
        const type = typeof work?.type === 'string' && /^[a-z-]+$/.test(work.type) ? work.type : undefined;
        const abstract = crossrefAbstractText(work?.abstract);
        records.set(doi, { type, abstract: hasUsableAIAbstract(abstract) ? abstract : undefined });
      }
    } catch {
      // A call that fails or times out ends Crossref for the step: in an
      // outage each later call would wait out its own deadline too. The
      // answers the calls before it brought are kept; its DOIs and those of
      // the calls not sent count as unanswered.
      for (const doi of calls.slice(index).flat()) failed.add(doi);
      break;
    }
  }
  return { records, failed };
}

/**
 * Semantic Scholar's abstracts for up to S2_RECOVERY_BATCH DOIs, in one batch
 * call within the `s2` allowance readers' related papers spend, or null when
 * it did not answer. A refused reservation sends nothing.
 */
async function semanticScholarAbstracts(env: EnrichEnv, asked: string[]): Promise<Partial<Paper>[] | null> {
  if (!(await reserveInternalCall('/enrich/s2', env))) return null;
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
  if (!response.ok) return null;
  const payload = await response.json<Array<{ externalIds?: { DOI?: unknown }; abstract?: unknown } | null>>();
  // An unknown id answers null; a record names the DOI it is for.
  return (Array.isArray(payload) ? payload : []).flatMap(record => {
    const doi = normalizeDoi(record?.externalIds?.DOI);
    if (!asked.includes(doi) || typeof record?.abstract !== 'string') return [];
    return [{ doi, abstract: record.abstract, sources: { primary: 'semanticscholar', enrichedBy: [] } }];
  });
}

// A paper asked by its arXiv id is also asked by its journal's DOI: OpenAlex
// can hold the journal's article as a work of its own, without the arXiv
// location, and only that work then says it is retracted. Only the
// retraction is taken from it. Up to 50 such papers a call, fewer when their
// DOIs are long (`openAlexFilters`), in the same budget.
const journalDoiOf = (paper: Paper) => (getOpenAlexEnrichmentId(paper).includes(':') ? '' : normalizeEnrichmentDoi(paper.doi));
const openAlexIdsOf = (paper: Paper) => {
  const journalDoi = journalDoiOf(paper);
  return [getOpenAlexEnrichmentId(paper), journalDoi ? `doi:${journalDoi}` : ''].filter(Boolean);
};

/**
 * What a harvest run's abstract retries may still do: the OpenAlex calls left
 * to them, none once every paper due has been asked, and the last paper asked
 * (its `published` and id), after which a later step of the run goes on, so
 * no paper is retried twice in one run. A young paper whose first
 * enrichment a failed source interrupted can still be asked twice in that run,
 * within the run's units: it records its own date as its enrichment date,
 * so from a day old it is due at once, and a later step's retries take it.
 * A retry that a failed source interrupts records the time it asked, as any
 * retry does, so the paper waits for its next age.
 */
export interface AbstractRetries { units: number; after: { published: string; id: number } | null }

// new: never enriched; missed: an OpenAlex miss whose wait is over; retry:
// still without an abstract at one of ABSTRACT_RETRY_DAYS; refresh: counts
// older than REFRESH_DAYS.
interface PendingRow extends Row { kind: 'new' | 'missed' | 'retry' | 'refresh' }

// Whether an enrichment of the paper has been counted (`enrichPending`).
const counted = (row: Row) => row.enrich_misses !== UNCOUNTED;

/**
 * The papers due an abstract retry, newest first after `retries.after`, and as
 * many as the run's OpenAlex units allow. Due: no abstract, by the SQL test
 * of `harvestLane`'s renewal (paper-sources.ts), since the mappers'
 * placeholder is shorter than the 40 characters of `isPlausibleAbstract`; an
 * enrichment dated in the last REFRESH_DAYS (counted or not), since an older
 * one is the refresh's; and one of ABSTRACT_RETRY_DAYS passed since then. A
 * paper whose type has no abstract (`typeHasAbstract`) is passed over.
 */
async function abstractRetries(db: D1Database, limit: number, now: number, { units, after }: AbstractRetries) {
  const daysAgo = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const [before, beforeId] = after ? [after.published, after.id] : [daysAgo(ABSTRACT_RETRY_DAYS[0]), Number.MAX_SAFE_INTEGER];
  const { results } = await db.prepare(`SELECT id, paper, enrich_misses, published, enriched_at FROM works
    WHERE published > ? AND published <= ? AND (published < ? OR id < ?)
      AND enrich_misses <= 0 AND enriched_at > ?
      AND LENGTH(COALESCE(paper ->> '$.abstract', '')) < 40
      AND EXISTS (SELECT 1 FROM json_each(?) age WHERE julianday(enriched_at) < julianday(published) + age.value
        AND julianday(published) + age.value <= julianday(?))
    ORDER BY published DESC, id DESC LIMIT ?`)
    .bind(daysAgo(REFRESH_DAYS + ABSTRACT_RETRY_DAYS.at(-1)!), before, before, beforeId, daysAgo(REFRESH_DAYS),
      JSON.stringify(ABSTRACT_RETRY_DAYS), new Date(now).toISOString(), limit).all<Row>();
  const due = results.filter(row => typeHasAbstract((JSON.parse(row.paper) as Paper).publicationType));
  const ids = due.map(row => openAlexIdsOf(JSON.parse(row.paper) as Paper));
  const calls = (count: number) => openAlexRequests([...new Set(ids.slice(0, count).flat())]).length;
  // The most papers whose calls fit in the units left: a paper more never takes fewer calls.
  let taken = due.length;
  if (calls(taken) > units) {
    let low = 0;
    let high = taken - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (calls(middle) <= units) low = middle;
      else high = middle - 1;
    }
    taken = low;
  }
  const spent = calls(taken);
  const last = results.at(-1);
  return {
    rows: due.slice(0, taken).map((row): PendingRow => ({ ...row, kind: 'retry' })),
    spent,
    retries: {
      units: results.length < limit || taken < due.length ? 0 : units - spent,
      after: last ? { published: last.published, id: last.id } : after,
    },
  };
}

async function pendingRows(db: D1Database, limit: number, now: number, retries: AbstractRetries) {
  const { results: fresh } = await db.prepare(`SELECT id, paper, enrich_misses, published, enriched_at FROM works
    WHERE enriched_at IS NULL ORDER BY published DESC LIMIT ?`).bind(limit).all<Row>();
  const rows: PendingRow[] = fresh.map(row => ({ ...row, kind: 'new' }));
  if (rows.length >= limit) return { rows, retries, spent: 0 };
  // Each miss waits RETRY_DAYS_PER_MISS days longer than the one before.
  const { results: misses } = await db.prepare(`SELECT id, paper, enrich_misses, published, enriched_at FROM works
    WHERE enrich_misses BETWEEN 1 AND ? AND enriched_at < ? ORDER BY enriched_at LIMIT ?`)
    .bind(MAX_MISSES, new Date(now - RETRY_DAYS_PER_MISS * DAY_MS).toISOString(), limit * 4).all<Row & { enriched_at: string }>();
  rows.push(...misses
    .filter(row => Date.parse(row.enriched_at) <= now - row.enrich_misses * RETRY_DAYS_PER_MISS * DAY_MS)
    .slice(0, limit - rows.length)
    .map((row): PendingRow => ({ ...row, kind: 'missed' })));
  if (rows.length >= limit) return { rows, retries, spent: 0 };
  // Then the papers still without an abstract, within the run's units.
  let next = retries;
  let spent = 0;
  if (retries.units > 0) {
    const due = await abstractRetries(db, limit - rows.length, now, retries);
    rows.push(...due.rows);
    ({ retries: next, spent } = due);
  }
  if (rows.length >= limit) return { rows, retries: next, spent };
  // Last, the counts that have aged: a paper's citations grow in its first months.
  const { results: stale } = await db.prepare(`SELECT id, paper, enrich_misses, published, enriched_at FROM works
    WHERE enrich_misses <= 0 AND enriched_at < ? ORDER BY enriched_at LIMIT ?`)
    .bind(new Date(now - REFRESH_DAYS * DAY_MS).toISOString(), limit - rows.length).all<Row>();
  rows.push(...stale.map((row): PendingRow => ({ ...row, kind: 'refresh' })));
  return { rows, retries: next, spent };
}

/**
 * Enriches up to `limit` stored papers, newest first: the ones never enriched,
 * then OpenAlex's misses whose wait is over, then the papers still without an
 * abstract that are due a retry, within the run's `retries`, then counts
 * older than REFRESH_DAYS. Returns the processed works for immediate
 * embedding, whether OpenAlex stopped the pass, and what the run's retries
 * may still do. A source that fails leaves its fields unknown; a paper waiting
 * for OpenAlex is not marked done without it, a retry included, so the next
 * run asks it again. A young paper whose first enrichment a failed source
 * interrupted is asked again the next night, or by a later step of the same
 * run (`AbstractRetries`); a retry a failed source interrupts waits for the
 * paper's next age, so a failed source adds no retries.
 */
export async function enrichPending(env: EnrichEnv, limit: number, now = Date.now(), retries: AbstractRetries = { units: ABSTRACT_RETRY_UNITS, after: null }) {
  const db = database(env);
  const pending = await pendingRows(db, limit, now, retries);
  const { rows } = pending;
  if (rows.length === 0) return { workIds: [], stop: true, retries: pending.retries };
  const retried = rows.filter(row => row.kind === 'retry').length;
  if (retried) console.log('Abstract retries', JSON.stringify({ papers: retried, openAlexCalls: pending.spent }));
  const papers = rows.map(row => JSON.parse(row.paper) as Paper);
  // A retry asks OpenAlex as the refresh does, for OpenAlex's own records too:
  // OpenAlex can add an abstract after it first lists a paper.
  const asksOpenAlex = rows.map((row, index) => (row.kind === 'retry' || row.kind === 'refresh' || needsOpenAlexEnrichment(papers[index]))
    && Boolean(getOpenAlexEnrichmentId(papers[index])));
  const journalDois = papers.map((paper, index) => (asksOpenAlex[index] ? journalDoiOf(paper) : ''));

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
  let enriched = mergeOpenAlexEnrichment(papers, openAlex);
  // Set after the merge rather than merged as OpenAlex's record: a paper
  // OpenAlex does not know by its arXiv id has had no OpenAlex enrichment, so
  // it does not list OpenAlex in `sources.enrichedBy`, and it counts a miss.
  enriched = enriched.map((paper, index): Paper => (journalDois[index] && paper.publicationStatus !== 'retracted'
    && openAlex[`doi:${journalDois[index]}`]?.publicationStatus === 'retracted' ? { ...paper, publicationStatus: 'retracted' } : paper));
  // iCite is asked by the PubMed ids the papers were stored with; Europe PMC
  // also by the ones OpenAlex has just given, so their abstracts come in this pass.
  const pmids = [...new Set(papers.map(paper => paper.pmid).filter(Boolean) as string[])];
  const europePmcIds = [...new Set(enriched.map(paper => paper.pmid).filter(Boolean) as string[])];
  const [iCite, europePmc] = await Promise.all([
    pmids.length ? iCiteMetrics(env, pmids).catch(() => ({})) : {},
    europePmcRecords(europePmcIds),
  ]);
  enriched = mergeICiteEnrichment(enriched, iCite);
  enriched = mergeEuropePmcEnrichment(enriched, europePmc.records);
  // The abstract of a paper listed without one, from the first source that
  // has it: arXiv's own text for an OpenAlex paper on arXiv, INSPIRE's by DOI
  // for an OpenAlex physics paper, then Crossref's publisher record, which the
  // type call below brings, and last Semantic Scholar's. Semantic Scholar is
  // one batch call a step: it shares a one-a-second allowance with readers'
  // related papers. A source that fails recovers nothing, and the paper keeps
  // no abstract (`interrupted` below).
  const missingArxiv = getMissingArxivAbstractIds(enriched);
  const missingDois = getMissingAbstractDois(enriched);
  const recovered = [
    ...(missingArxiv.length ? await fetchArxivPapers(env, missingArxiv).catch(() => []) : []),
    ...(missingDois.length ? await fetchInspireAbstracts(missingDois).catch(() => []) : []),
  ];
  if (recovered.length) enriched = mergeFeedAbstracts(enriched, recovered);
  // Crossref is asked for every OpenAlex paper's type, and for the abstract of
  // any other paper that awaits one (a PubMed paper's); only an OpenAlex
  // paper takes the type. A retry after a counted enrichment asks it for
  // neither: that enrichment brought Crossref's type and abstract.
  const asksCrossref = rows.map(row => row.kind !== 'retry' || !counted(row));
  const crossrefDois = [...new Set([...enriched
    .filter((paper, index) => asksCrossref[index] && paper.sources?.primary === 'openalex')
    .map(paper => normalizeDoi(paper.doi)), ...recoverableAbstractDois(enriched.filter((_, index) => asksCrossref[index]))]
    .filter(doi => doi && !doi.includes(',') && doi.length <= 240))];
  const crossref = await crossrefRecords(crossrefDois);
  enriched = enriched.map(paper => withCrossrefType(paper, paper.sources?.primary === 'openalex' ? crossref.records.get(normalizeDoi(paper.doi))?.type : undefined));
  enriched = mergeFeedAbstracts(enriched, [...crossref.records].flatMap(([doi, { abstract }]) => (abstract ? [{ doi, abstract, sources: { primary: 'crossref', enrichedBy: [] } }] : [])));
  const semanticScholarDois = recoverableAbstractDois(enriched).slice(0, S2_RECOVERY_BATCH);
  const semanticScholar = semanticScholarDois.length ? await semanticScholarAbstracts(env, semanticScholarDois).catch(() => null) : [];
  if (semanticScholar?.length) enriched = mergeFeedAbstracts(enriched, semanticScholar);
  // A paper still without an abstract that a source which failed was asked for.
  const failedDois = new Set([...crossref.failed, ...(semanticScholar ? [] : semanticScholarDois)]);
  const interrupted = enriched.map(paper => !hasUsableAIAbstract(paper.abstract) && typeHasAbstract(paper.publicationType)
    && (failedDois.has(normalizeDoi(paper.doi)) || europePmc.failed.has(paper.pmid || '')));

  await rewriteWorks(env, rows.map((row, index) => ({ id: row.id, before: papers[index], after: enriched[index] })), now);
  // A paper OpenAlex should have known but did not counts a miss. One waiting
  // for an OpenAlex that did not answer is left for the next run. A first
  // enrichment that a failed source interrupted is not counted when the paper
  // is younger than REFRESH_DAYS: the paper takes its own date as its
  // enrichment date, so the retries ask it again from a day old, a later step
  // of the same run included, and UNCOUNTED, so its retries ask Crossref
  // too. An older one's enrichment is counted, and it waits for its next age
  // or its refresh. A retry that a failed source interrupted is dated like any
  // other, so the paper waits for its next age, and after the last age for
  // its refresh: a source that keeps failing gets no more asks than the
  // schedule's. Such a retry counts nothing, so an uncounted paper stays so.
  const at = new Date(now).toISOString();
  const young = new Date(now - REFRESH_DAYS * DAY_MS).toISOString();
  const marks = rows.flatMap((row, index) => {
    if (asksOpenAlex[index] && !openAlexAnswered) return [];
    if ((row.kind === 'new' || row.kind === 'missed') && asksOpenAlex[index] && needsOpenAlexEnrichment(enriched[index])) {
      return [{ id: row.id, misses: row.enrich_misses + 1, at }];
    }
    if (!interrupted[index]) return [{ id: row.id, misses: 0, at }];
    if (row.kind === 'retry') return [{ id: row.id, misses: row.enrich_misses, at }];
    return [row.published > young ? { id: row.id, misses: UNCOUNTED, at: row.published } : { id: row.id, misses: 0, at }];
  });
  if (marks.length) {
    await db.batch(chunks(marks, 200).map(chunk => db.prepare(`UPDATE works SET enriched_at = j.value ->> 'at', enrich_misses = j.value ->> 'misses'
      FROM json_each(?) j WHERE works.id = j.value ->> 'id'`).bind(JSON.stringify(chunk))));
  }
  return { workIds: rows.map(row => row.id), stop: !openAlexAnswered, retries: pending.retries };
}
