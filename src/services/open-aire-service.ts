import type { ProjectParticipant } from '../utils/entity-metadata.ts';
import type { OpenAireProduct } from './open-aire-records.ts';
interface GraphProject {
  id?: unknown; code?: unknown; title?: unknown; acronym?: unknown; summary?: unknown;
  startDate?: unknown; endDate?: unknown; callIdentifier?: unknown; websiteUrl?: unknown; subjects?: unknown;
  openAccessMandateForPublications?: unknown;
  fundings?: { shortName?: unknown; name?: unknown; fundingStream?: { description?: unknown } }[];
  granted?: { totalCost?: unknown; fundedAmount?: unknown; currency?: unknown };
  links?: { header?: { relationClass?: unknown }; legalname?: unknown; legalshortname?: unknown; country?: { label?: unknown } | null; websiteurl?: unknown }[];
}
interface GraphPublication extends OpenAireProduct {
  projects?: { id?: unknown; code?: unknown; acronym?: unknown; title?: unknown }[] | null;
  links?: {
    header?: { relationClass?: unknown; relatedIdentifier?: unknown };
    funding?: { funder?: { shortname?: unknown } | null; level0?: { name?: unknown } | null } | null;
  }[] | null;
}
export interface Project {
  id?: string; code?: string; openaireId?: string | null; title: string; acronym?: string | null;
  funder: string; fundingStream?: string; funderLevel?: string; summary?: string; startDate?: string; endDate?: string;
  budget?: number; fundedAmount?: number; currency?: string; callIdentifier?: string | null;
  websiteUrl?: string | null; subjects?: string[]; participants?: ProjectParticipant[];
  openAccess?: boolean;
}
// `total` is null for a page past Graph's window: the project's size is not known.
interface ProjectPapers { arxivIds: string[]; dois: string[]; total: number | null; }

import { deduplicateProjectParticipants } from '../utils/entity-metadata.ts';
import { withEnforcedDeadline } from '../utils/request-deadline.ts';
import { readSourceCache, writeSourceCache } from '../utils/source-cache.ts';
import { normalizeSearchText, scoreSearchMatch, withinOneEdit } from '../utils/search-relevance.ts';
import {
  OPENAIRE_GRAPH_URL,
  OPENAIRE_OFFSET_LIMIT,
  openAirePids,
  openAireProjectParams,
  openAireProjectPublicationsUrl,
  readOpenAirePage,
} from './open-aire-records.ts';

export const CACHE = new Map<string, { data: Project | ProjectPapers | null; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
const PROJECT_PAGE_SIZE = 30;

/**
 * The response is handed back unread, so the deadline has to outlive this
 * function — every `response.json()` below is the part that actually stalls.
 * The old timer was cleared the moment the headers landed, which left those
 * reads unbounded.
 *
 * Exported for its regression test, which needs a deadline short enough to wait
 * for: the real one is ten seconds.
 */
export function fetchWithTimeout(url: string | URL, timeout = 10000, { signal }: { signal?: AbortSignal | null } = {}) {
  return fetch(url, withEnforcedDeadline({ signal }, timeout));
}

function projectText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function projectAmount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The fields a project search row and the project page share. The budget is
 * the total cost, or the funded amount when the total is 0 (SNSF 100010
 * reports 0 and 90,593). A currency Graph leaves null stays unknown.
 */
function projectSummary(p: GraphProject) {
  const funding = Array.isArray(p.fundings) ? p.fundings[0] : undefined;
  const totalCost = projectAmount(p.granted?.totalCost);
  const currency = projectText(p.granted?.currency);
  return {
    code: projectText(p.code),
    title: projectText(p.title),
    acronym: projectText(p.acronym),
    funder: projectText(funding?.shortName) || projectText(funding?.name) || '',
    fundingStream: projectText(funding?.fundingStream?.description),
    budget: totalCost ? totalCost : projectAmount(p.granted?.fundedAmount),
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
  };
}

/** A project page's details: `id` is the grant code, `openaireId` the record's own id. */
function projectDetails(p: GraphProject): Project | null {
  const openaireId = projectText(p.id);
  const { code, title, ...summary } = projectSummary(p);
  if (!openaireId || !title) return null;
  const participants = (Array.isArray(p.links) ? p.links : [])
    .filter(link => link?.header?.relationClass === 'hasParticipant')
    .map(link => ({
      name: projectText(link.legalshortname) || projectText(link.legalname),
      searchName: projectText(link.legalname) || projectText(link.legalshortname) || null,
      country: projectText(link.country?.label) || null,
      website: projectText(link.websiteurl) || null,
    }));
  const subjects: string[] = Array.isArray(p.subjects) ? p.subjects.flatMap(subject => projectText(subject) ?? []) : [];
  return {
    ...summary,
    id: code,
    openaireId,
    title,
    summary: projectText(p.summary),
    startDate: projectText(p.startDate),
    endDate: projectText(p.endDate),
    fundedAmount: projectAmount(p.granted?.fundedAmount),
    callIdentifier: projectText(p.callIdentifier) || null,
    websiteUrl: projectText(p.websiteUrl) || null,
    subjects: [...new Set(subjects)],
    participants: deduplicateProjectParticipants(participants),
    openAccess: typeof p.openAccessMandateForPublications === 'boolean' ? p.openAccessMandateForPublications : undefined,
  };
}

export async function getProjectDetails(projectId: string | undefined, { funder = '' } = {}) {
  if (!projectId) return null;
  // A grant code alone is not unique across funders, so a bare code needs the
  // funder to land on the right project. An OpenAIRE id (the `::`-joined form)
  // is already unambiguous and takes the direct lookup instead.
  const isOpenAireId = projectId.includes('::');
  // The same 24 h cache the two lookups below keep. Without it this was the
  // only Explorer read that paid a full round trip on every return, with the
  // project's skeleton — the one that reserves worst — on screen for all of
  // it (2026-09-09). A miss is not cached: OpenAIRE indexes late. The funder
  // rides along in the key so two funders' answers for the same grant code
  // cannot overwrite each other.
  const cacheKey = `projectDetails_${projectId}_${isOpenAireId ? '' : funder}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey)!;
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data as Project | null;
  }
  const params = new URLSearchParams({ ...openAireProjectParams(projectId, funder), pageSize: '1' });
  try {
    const response = await fetchWithTimeout(`${OPENAIRE_GRAPH_URL}/projects?${params}`);
    if (!response.ok) return null;
    const [record] = readOpenAirePage<GraphProject>(await response.json()).results;
    const details = record ? projectDetails(record) : null;
    if (details) CACHE.set(cacheKey, { data: details, timestamp: Date.now() });
    return details;
  } catch (e) {
    console.error("Error fetching project details:", e);
    return null;
  }
}

/**
 * OpenAIRE files an arXiv record under its OAI identifier, and only without the
 * version suffix: `oai:arXiv.org:2208.08241` answers, `…v2` answers nothing
 * (Search API, 2026-09-24; Graph, 2026-10-17).
 */
function arxivOriginalId(arxivId: unknown) {
  const bare = String(arxivId).trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  return `oai:arXiv.org:${bare}`;
}

/** The first publication a lookup finds, and whether OpenAIRE answered at all. */
async function lookUpPublication(lookup: Record<string, string>) {
  const params = new URLSearchParams({ ...lookup, type: 'publication', pageSize: '1' });
  const response = await fetchWithTimeout(`${OPENAIRE_GRAPH_URL}/research-products?${params}`);
  if (!response.ok) return { answered: false, publication: null };
  const [publication] = readOpenAirePage<GraphPublication>(await response.json()).results;
  return { answered: true, publication: publication || null };
}

/**
 * Get project info from OpenAIRE using arXiv ID or DOI.
 *
 * Every answer is kept for the session, a miss or a failure included: the card
 * asks when it settles, and asking again on each render only paid the same
 * empty answer again.
 */
export async function getProjectForPaper(arxivId: string | undefined, doi: string | null | undefined) {
  if (!arxivId && !doi) return null;

  const cacheKey = `project_${arxivId || doi}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey)!;
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data as Project | null;
  }

  let project: Project | null = null;
  try {
    let lookup = doi ? await lookUpPublication({ pid: doi }) : null;
    // The arXiv record only when the DOI finds no publication at all. A
    // publication with no project is the usual answer, and its arXiv copy is
    // the same deduplicated record (10.1145/3555174 and 2203.10143 are one,
    // 2026-09-24), so asking again for it would only spend a request.
    if (arxivId && (!lookup || (lookup.answered && !lookup.publication))) {
      lookup = await lookUpPublication({ originalId: arxivOriginalId(arxivId) });
    }
    if (lookup?.publication) project = projectOfPublication(lookup.publication);
  } catch (err) {
    console.error("Error fetching OpenAIRE project:", err);
  }
  CACHE.set(cacheKey, { data: project, timestamp: Date.now() });
  return project;
}

/**
 * The first project a publication names. `projects[].funder` is the funder's
 * full name ("European Commission"); routes and follows carry its short name
 * ("EC"), which only the publication's `isProducedBy` link has.
 */
function projectOfPublication(publication: GraphPublication): Project | null {
  const links = Array.isArray(publication.links) ? publication.links : [];
  for (const project of Array.isArray(publication.projects) ? publication.projects : []) {
    const id = projectText(project?.id);
    const title = projectText(project?.title);
    if (!id || !title) continue;
    const funding = links.find(link => link?.header?.relationClass === 'isProducedBy' && link.header.relatedIdentifier === id)?.funding;
    const funder = projectText(funding?.funder?.shortname) || '';
    let funderLevel = projectText(funding?.level0?.name) || '';
    if (funderLevel.toLowerCase().includes('project') || funderLevel.toLowerCase() === 'programmes') funderLevel = funder;
    return {
      id,
      code: projectText(project.code),
      acronym: projectText(project.acronym) || (title.length > 50 ? title.substring(0, 47) + '...' : title),
      title,
      funder,
      funderLevel: funderLevel || funder,
    };
  }
  return null;
}

/**
 * Get papers (PIDs/DOIs) for a specific project
 */
export async function getPapersByProject(projectCode: string, page = 1, { funder = '' } = {}) {
  if (!projectCode) return { arxivIds: [], dois: [], total: 0 };
  // Graph refuses offsets past 10,000 with a 400; the list ends there. The
  // project's size is not known without asking, and 0 would claim it is empty.
  if (page * PROJECT_PAGE_SIZE > OPENAIRE_OFFSET_LIMIT) return { arxivIds: [], dois: [], total: null };

  // See getProjectDetails: a bare grant code needs the funder to disambiguate,
  // an OpenAIRE id already carries it. The cache key includes the funder for
  // the same reason — two funders sharing a grant code must not collide.
  const isOpenAireId = projectCode.includes('::');
  const cacheKey = `papers_proj_${projectCode}_${isOpenAireId ? '' : funder}_${page}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey)!;
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data as ProjectPapers;
  }

  try {
    const response = await fetchWithTimeout(openAireProjectPublicationsUrl(projectCode, { funder, page, pageSize: PROJECT_PAGE_SIZE }));
    if (!response.ok) throw new Error(`OpenAIRE API error: ${response.status}`);
    const { results, total } = readOpenAirePage<GraphPublication>(await response.json());

    // One identifier a publication, its arXiv id first.
    const arxivIds: string[] = [];
    const dois: string[] = [];
    for (const publication of results) {
      const [arxivId] = openAirePids(publication, 'arXiv');
      const [doi] = openAirePids(publication, 'doi');
      if (arxivId) arxivIds.push(arxivId);
      else if (doi) dois.push(doi);
    }

    const resultData = { arxivIds, dois, total };
    CACHE.set(cacheKey, { data: resultData, timestamp: Date.now() });
    return resultData;

  } catch (e) {
    console.error("Error fetching OpenAIRE papers for project:", e);
    throw e;
  }
}

async function projectCandidates(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = readSourceCache<{ projects: Project[]; total: number }>(url, CACHE_TTL);
  if (cached) return cached;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OpenAIRE search error: ${response.status}`);

  const { results, total } = readOpenAirePage<GraphProject>(await response.json());
  const projects: Project[] = results.flatMap(p => {
    const id = projectText(p?.id);
    const { title, ...summary } = projectSummary(p ?? {});
    return id && title ? [{ ...summary, id, title }] : [];
  });
  if (results.length && !projects.length) throw new Error('OpenAIRE projects are missing identities or titles');
  if (projects.length < results.length) console.warn(`Skipped ${results.length - projects.length} incomplete OpenAIRE projects`);
  const result = { projects, total };
  if (projects.length) writeSourceCache(url, result);
  return result;
}

function projectMatchScore(query: string, project: Project) {
  let exact = scoreSearchMatch(query, [project.acronym, project.title]);
  const normalized = normalizeSearchText(query);
  const acronym = normalizeSearchText(project.acronym);
  if (normalized.replace(/[^0-9]/g, '') === acronym.replace(/[^0-9]/g, '')
    && withinOneEdit(normalized, acronym, 5, true)) exact = Math.max(exact, 87);
  const words = normalized.split(' ');
  const title = normalizeSearchText(project.title).split(' ');
  if (words.length < 2 || words.some(word => !/^[a-z]+$/.test(word))) return exact;
  const similar = title.some((_, start) => {
    const candidate = title.slice(start, start + words.length);
    return candidate.length === words.length
      && words.every((word, index) => withinOneEdit(word, candidate[index], 3))
      && words.filter((word, index) => word !== candidate[index]).length <= 1;
  });
  return similar ? Math.max(exact, 82 + 5 * words.length / title.length) : exact;
}

/** Recover only after successful misses, within one shared provider deadline. */
export async function searchProjects(query: string, page = 1, options: { signal?: AbortSignal | null; throwOnError?: boolean } = {}) {
  const compact = query.trim().replace(/\s+/g, ' ');
  const term = /^(?:[A-Za-z] ){1,7}[A-Za-z]$/.test(compact) ? compact.replace(/ /g, '').toLowerCase() : compact.toLowerCase();
  if (!term) return { projects: [], total: 0 };
  const singleWord = /^[\p{L}\p{N}._+-]+$/u.test(term);
  const field = singleWord ? 'acronym' : 'search';
  const literal = JSON.stringify(term);
  const words = term.split(' ');
  let recovery: string | undefined;
  if (singleWord) recovery = literal;
  else if (words.length >= 2 && words.every(word => /^[a-z]+$/.test(word)) && words.some(word => word.length >= 3)) {
    // A phrase prefix retains relevance when the last word has a typo. Other
    // clauses keep an intact part of the name; Graph allows four operators.
    const last = words.at(-1)!;
    const prefix = [...words.slice(0, -1), last.slice(0, Math.max(2, Math.floor(last.length / 2)))].join(' ');
    const fragments = [JSON.stringify(prefix)];
    if (words.length === 3) {
      fragments.push(JSON.stringify(words.slice(0, 2).join(' ')), JSON.stringify(words.slice(1).join(' ')));
      fragments.push(`(${JSON.stringify(words[0])} AND ${JSON.stringify(words[2])})`);
    } else {
      const middle = Math.ceil(words.length / 2);
      fragments.push(JSON.stringify(words.slice(0, middle).join(' ')), JSON.stringify(words.slice(middle).join(' ')));
    }
    recovery = [...new Set(fragments)].join(' OR ');
  }
  const urlFor = (key: string, value: string) => `${OPENAIRE_GRAPH_URL}/projects?${new URLSearchParams({ pageSize: '50', page: String(page), [key]: value })}`;
  const rank = (projects: Project[], minimum = 55) => projects
    .map(project => ({ project, score: projectMatchScore(term, project) }))
    .filter(match => match.score >= minimum)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(match => match.project);
  try {
    // All requests, including their bodies, share one five-second budget.
    const { signal } = withEnforcedDeadline({ signal: options.signal }, 5000);
    const first = await projectCandidates(urlFor(field, literal), signal);
    const projects = rank(first.projects);
    if (projects.length || !recovery) return { ...first, projects };
    const second = await projectCandidates(urlFor('title', recovery), signal);
    const recovered = rank(second.projects, singleWord ? 55 : 80);
    if (recovered.length || !singleWord || !/^[a-z0-9]{5,}$/.test(term)) return { ...second, projects: recovered };
    const middle = Math.ceil(term.length / 2);
    // Short acronyms may not match provider fragments at all. Enumerating their
    // adjacent letter swaps fits Graph's five-clause limit without changing digits.
    const fragments = term.length <= 6
      ? Array.from({ length: term.length - 1 }, (_, index) => /^[a-z]{2}$/.test(term.slice(index, index + 2))
        ? term.slice(0, index) + term[index + 1] + term[index] + term.slice(index + 2) : '')
      : [term.slice(0, middle), term.slice(middle)];
    const candidates = [...new Set(fragments.filter(part => part.length >= 3 && part !== term))];
    if (!candidates.length) return { ...second, projects: recovered };
    const third = await projectCandidates(urlFor('acronym', candidates.map(part => JSON.stringify(part)).join(' OR ')), signal);
    return { ...third, projects: rank(third.projects, 80) };
  } catch (e) {
    if (!options.signal?.aborted) console.error('Error searching OpenAIRE projects:', e);
    if (options.throwOnError) throw e;
    return { projects: [], total: 0 };
  }
}
