import type { ProjectParticipant } from '../utils/entity-metadata.ts';
interface XmlField { $?: string; '@class'?: string; '@type'?: string; '@classname'?: string; '@id'?: string; '@score'?: string; '@count'?: string; }
interface FundingTree { funder?: { shortname?: XmlField; name?: XmlField }; funding_level_0?: { name?: XmlField }; }
interface OpenAireRelation {
  to?: XmlField; legalshortname?: XmlField; legalname?: XmlField; country?: XmlField; websiteurl?: XmlField;
  title?: XmlField; acronym?: XmlField; code?: XmlField;
  funding?: { funder?: { '@shortname'?: string; '@name'?: string }; funding_level_0?: { '@name'?: string } };
}
type OpenAireProject = Partial<Record<'code' | 'title' | 'acronym' | 'totalcost' | 'fundedamount' | 'summary' | 'startdate' | 'enddate' | 'currency' | 'callidentifier' | 'contracttype' | 'websiteurl' | 'oamandatepublications', XmlField>> & {
  fundingtree?: FundingTree | FundingTree[]; subject?: XmlField | XmlField[];
  rels?: { rel?: OpenAireRelation | OpenAireRelation[] }; measure?: XmlField | XmlField[];
};
interface OpenAireResult {
  header?: { 'dri:objIdentifier'?: XmlField };
  metadata?: { 'oaf:entity'?: { 'oaf:project'?: OpenAireProject; 'oaf:result'?: { rels?: { rel?: OpenAireRelation | OpenAireRelation[] }; pid?: XmlField | XmlField[] } } };
}
interface OpenAireResponse { response?: { results?: { result?: OpenAireResult | OpenAireResult[] }; header?: { total?: XmlField } }; }
export interface Project {
  id?: string; code?: string; openaireId?: string | null; title: string; acronym?: string | null;
  funder: string; fundingStream?: string; funderLevel?: string; summary?: string; startDate?: string; endDate?: string;
  budget?: number; fundedAmount?: number; currency?: string; callIdentifier?: string | null; contractType?: string | null;
  websiteUrl?: string | null; subjects?: string[]; participants?: ProjectParticipant[];
  measures?: { citations?: number; downloads?: number; views?: number; influentialResults?: number }; openAccess?: boolean;
}
interface ProjectPapers { arxivIds: string[]; dois: string[]; total: number; }

import { deduplicateProjectParticipants } from '../utils/entity-metadata.ts';
import { withEnforcedDeadline } from '../utils/request-deadline.ts';
import { readSourceCache, writeSourceCache } from '../utils/source-cache.ts';
import { normalizeSearchText, scoreSearchMatch, withinOneEdit } from '../utils/search-relevance.ts';

export const CACHE = new Map<string, { data: Project | ProjectPapers | null; timestamp: number }>();
const CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

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

/** Validate that a string is a plausible 3-letter ISO 4217 currency code */
function validCurrency(code: unknown) {
  if (!code || typeof code !== 'string') return 'EUR';
  const upper = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : 'EUR';
}

/**
 * Extract funder info from the fundingtree structure.
 * fundingtree can be an array of objects or a single object,
 * and funder shortname/name use the {"$": "value"} pattern.
 */
function extractFunder(p: OpenAireProject) {
  let funderName = "Funder desconocido";
  let fundingStream = "";
  
  let tree = p.fundingtree;
  if (!tree) return { funderName, fundingStream };
  
  // Normalize to array
  if (!Array.isArray(tree)) tree = [tree];
  
  const first = tree[0];
  if (!first?.funder) return { funderName, fundingStream };
  
  const funder = first.funder;
  if (funder.shortname?.["$"]) funderName = funder.shortname["$"];
  else if (funder.name?.["$"]) funderName = funder.name["$"];
  
  if (first.funding_level_0?.name?.["$"]) fundingStream = first.funding_level_0.name["$"];
  
  return { funderName, fundingStream };
}

export async function getProjectDetails(projectId: string | undefined, { funder = '' } = {}) {
  if (!projectId) return null;
  // A grant code alone is not unique across funders (grantID=100010 answers
  // for NHMRC, SNSF, and UKRI alike), so a bare code needs the funder to land
  // on the right project. An OpenAIRE id (the `::`-joined form) is already
  // unambiguous and takes the direct lookup instead.
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
  const lookup = isOpenAireId
    ? `openaireProjectID=${encodeURIComponent(projectId)}`
    : `grantID=${encodeURIComponent(projectId)}${funder ? `&funder=${encodeURIComponent(funder)}` : ''}`;
  const url = `https://api.openaire.eu/search/projects?format=json&size=1&${lookup}`;
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const data = await response.json() as OpenAireResponse;
    if (!data?.response?.results?.result) return null;
    
    let res = data.response.results.result;
    if (Array.isArray(res)) res = res[0];
    
    const p = res?.metadata?.["oaf:entity"]?.["oaf:project"];
    if (!p) return null;
    
    const { funderName, fundingStream } = extractFunder(p);

    // Use fundedamount as fallback when totalcost is 0
    const totalCost = parseFloat(p.totalcost?.["$"] as string) || 0;
    const fundedAmount = parseFloat(p.fundedamount?.["$"] as string) || 0;
    const budget = totalCost > 0 ? totalCost : fundedAmount;

    // Extract subjects/topics
    let subjects: string[] = [];
    if (p.subject) {
      const subArr = Array.isArray(p.subject) ? p.subject : [p.subject];
      subjects = [...new Set(subArr.map(s => s["$"]).filter(Boolean))] as string[];
    }

    // Extract participant organizations
    let participants: ProjectParticipant[] = [];
    if (p.rels?.rel) {
      const rels = Array.isArray(p.rels.rel) ? p.rels.rel : [p.rels.rel];
      participants = deduplicateProjectParticipants(rels
        .filter(r => r.to?.["@class"] === "hasParticipant")
        .map(r => ({
          name: r.legalshortname?.["$"] || r.legalname?.["$"] || "Unknown",
          searchName: r.legalname?.["$"] || r.legalshortname?.["$"] || null,
          country: r.country?.["@classname"] || null,
          website: r.websiteurl?.["$"] || null,
        })));
    }

    // Extract impact measures
    const measures: NonNullable<Project['measures']> = {};
    if (p.measure) {
      const mArr = Array.isArray(p.measure) ? p.measure : [p.measure];
      for (const m of mArr) {
        if (m["@id"] === "totalCitationCount") measures.citations = parseInt(m["@score"]!) || 0;
        if (m["@id"] === "downloads") measures.downloads = parseInt(m["@count"]!) || 0;
        if (m["@id"] === "views") measures.views = parseInt(m["@count"]!) || 0;
        if (m["@id"] === "numOfInfluentialResults") measures.influentialResults = parseInt(m["@score"]!) || 0;
      }
    }

    const details: Project = {
      id: p.code?.["$"],
      openaireId: res?.header?.["dri:objIdentifier"]?.["$"] || null,
      title: p.title?.["$"] || "Unknown Project",
      acronym: p.acronym?.["$"] || null,
      funder: funderName,
      fundingStream,
      summary: p.summary?.["$"],
      startDate: p.startdate?.["$"],
      endDate: p.enddate?.["$"],
      budget,
      fundedAmount,
      currency: validCurrency(p.currency?.["$"]),
      callIdentifier: p.callidentifier?.["$"] || null,
      contractType: p.contracttype?.["@classname"] || null,
      websiteUrl: p.websiteurl?.["$"] || null,
      subjects,
      participants,
      measures,
      openAccess: String(p.oamandatepublications?.["$"]).toLowerCase() === 'true',
    };
    CACHE.set(cacheKey, { data: details, timestamp: Date.now() });
    return details;
  } catch (e) {
    console.error("Error fetching project details:", e);
    return null;
  }
}

/**
 * OpenAIRE files an arXiv record under its OAI identifier, and only without the
 * version suffix: `oai:arXiv.org:2208.08241` answers, `…v2` answers nothing.
 * There is no `pid` parameter at all — it is a 400 «Parameter pid is not
 * supported» (measured 2026-09-24).
 */
function arxivOriginalId(arxivId: unknown) {
  const bare = String(arxivId).trim().replace(/^arxiv:/i, '').replace(/v\d+$/i, '');
  return `oai:arXiv.org:${bare}`;
}

const PUBLICATION_LOOKUP = 'https://api.openaire.eu/search/publications?format=json&size=1';

/** The first publication a lookup finds, and whether OpenAIRE answered at all. */
async function lookUpPublication(lookup: string) {
  const response = await fetchWithTimeout(`${PUBLICATION_LOOKUP}&${lookup}`);
  if (!response.ok) return { answered: false, publication: null };
  const data = await response.json() as OpenAireResponse;
  const result = data?.response?.results?.result;
  return { answered: true, publication: (Array.isArray(result) ? result[0] : result) || null };
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
    let lookup = doi ? await lookUpPublication(`doi=${encodeURIComponent(doi)}`) : null;
    // The arXiv record only when the DOI finds no publication at all. A
    // publication with no project is the usual answer, and its arXiv copy is
    // the same deduplicated record (10.1145/3555174 and 2203.10143 are one,
    // 2026-09-24), so asking again for it would only spend a request.
    if (arxivId && (!lookup || (lookup.answered && !lookup.publication))) {
      lookup = await lookUpPublication(`originalId=${encodeURIComponent(arxivOriginalId(arxivId))}`);
    }
    if (lookup?.publication) project = parseProjectFromResult(lookup.publication);
  } catch (err) {
    console.error("Error fetching OpenAIRE project:", err);
  }
  CACHE.set(cacheKey, { data: project, timestamp: Date.now() });
  return project;
}

function parseProjectFromResult(result: OpenAireResult): Project | null {
  try {
    let rels = result?.metadata?.["oaf:entity"]?.["oaf:result"]?.rels?.rel;
    if (!rels) return null;
    
    if (!Array.isArray(rels)) rels = [rels];
    
    for (const rel of rels) {
      if (rel?.to?.["@type"] === "project") {
        const funding = rel.funding;
        let funderName = "Unknown Funder";
        if (funding?.funder?.["@shortname"]) {
            funderName = funding.funder["@shortname"];
        } else if (funding?.funder?.["@name"]) {
            funderName = funding.funder["@name"];
        }
        
        let funderLevel = "";
        if (funding?.funding_level_0?.["@name"]) {
            funderLevel = funding.funding_level_0["@name"];
            if (funderLevel.toLowerCase().includes('project') || funderLevel.toLowerCase() === 'programmes') {
                funderLevel = funderName;
            }
        }

        const title = rel.title?.["$"] || "Unknown Project Title";
        let acronym = rel.acronym?.["$"];
        
        if (!acronym) {
            acronym = title.length > 50 ? title.substring(0, 47) + '...' : title;
        }

        return {
          id: rel.to["$"],
          code: rel.code?.["$"],
          acronym: acronym,
          title: title,
          funder: funderName,
          funderLevel: funderLevel || funderName
        };
      }
    }
  } catch (e) {
    console.error("Error parsing OpenAIRE project", e);
  }
  return null;
}

/**
 * Get papers (PIDs/DOIs) for a specific project
 */
export async function getPapersByProject(projectCode: string, page = 1, { funder = '' } = {}) {
  if (!projectCode) return { arxivIds: [], dois: [], total: 0 };

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
    const paramName = isOpenAireId ? 'openaireProjectID' : 'projectID';
    const funderParam = !isOpenAireId && funder ? `&funder=${encodeURIComponent(funder)}` : '';
    const url = `https://api.openaire.eu/search/publications?format=json&size=30&page=${page}&${paramName}=${encodeURIComponent(projectCode)}${funderParam}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) throw new Error(`OpenAIRE API error: ${response.status}`);

    const data = await response.json() as OpenAireResponse;
    if (!data?.response?.results?.result) return { arxivIds: [], dois: [], total: 0 };

    let results = data.response.results.result;
    if (!Array.isArray(results)) results = [results];

    const arxivIds: string[] = [];
    const dois: string[] = [];
    
    const total = data.response.header?.total?.["$"] ? parseInt(data.response.header.total["$"]) : 0;

    results.forEach(res => {
      let pids = res?.metadata?.["oaf:entity"]?.["oaf:result"]?.pid;
      if (!pids) return;
      if (!Array.isArray(pids)) pids = [pids];

      let foundArxiv = null;
      let foundDoi = null;

      for (const pid of pids) {
        const type = pid["@classname"]?.toLowerCase();
        if (type === "digital object identifier" || type === "doi") {
          foundDoi = pid["$"];
        }
      }

      for (const pid of pids) {
        const type = pid["@classname"]?.toLowerCase();
        // Sometimes arxiv IDs are under "arxiv" classname, sometimes in handling. We just look for "arxiv"
        if (type === "arxiv") {
          if (foundDoi && typeof foundDoi === 'string' && foundDoi.includes('arxiv.')) {
            foundArxiv = foundDoi.split('arxiv.')[1];
          } else {
            foundArxiv = String(pid["$"]);
          }
          break;
        }
      }
      
      if (foundArxiv) {
        arxivIds.push(foundArxiv);
      } else if (foundDoi) {
        dois.push(foundDoi);
      }
    });

    const resultData = { arxivIds, dois, total };
    CACHE.set(cacheKey, { data: resultData, timestamp: Date.now() });
    return resultData;

  } catch (e) {
    console.error("Error fetching OpenAIRE papers for project:", e);
    throw e;
  }
}

interface GraphProject {
  id?: unknown; code?: unknown; title?: unknown; acronym?: unknown;
  fundings?: { shortName?: unknown; name?: unknown; fundingStream?: { description?: unknown } }[];
  granted?: { totalCost?: unknown; fundedAmount?: unknown; currency?: unknown };
}

function projectText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

async function projectCandidates(url: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const cached = readSourceCache<{ projects: Project[]; total: number }>(url, CACHE_TTL);
  if (cached) return cached;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`OpenAIRE search error: ${response.status}`);

  const data = await response.json() as { header?: { numFound?: unknown }; results?: GraphProject[] };
  if (!Array.isArray(data?.results) || typeof data.header?.numFound !== 'number'
    || !Number.isFinite(data.header.numFound) || data.header.numFound < 0) {
    throw new Error('Invalid OpenAIRE project search response');
  }
  const projects: Project[] = data.results.flatMap(p => {
    const id = projectText(p?.id);
    const title = projectText(p?.title);
    if (!id || !title) return [];
    const funding = Array.isArray(p.fundings) ? p.fundings[0] : undefined;
    const totalCost = p.granted?.totalCost;
    const fundedAmount = p.granted?.fundedAmount;
    const budget = typeof totalCost === 'number' && Number.isFinite(totalCost) && totalCost > 0 ? totalCost
      : typeof fundedAmount === 'number' && Number.isFinite(fundedAmount) && fundedAmount >= 0 ? fundedAmount : undefined;
    const currency = projectText(p.granted?.currency);
    return [{
      id,
      code: projectText(p.code),
      title,
      acronym: projectText(p.acronym),
      funder: projectText(funding?.shortName) || projectText(funding?.name) || '',
      fundingStream: projectText(funding?.fundingStream?.description),
      budget,
      currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    }];
  });
  if (data.results.length && !projects.length) throw new Error('OpenAIRE projects are missing identities or titles');
  if (projects.length < data.results.length) console.warn(`Skipped ${data.results.length - projects.length} incomplete OpenAIRE projects`);
  const result = { projects, total: data.header.numFound };
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
  const urlFor = (key: string, value: string) => `https://api.openaire.eu/graph/v3/projects?${new URLSearchParams({ pageSize: '50', page: String(page), [key]: value })}`;
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
