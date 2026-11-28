interface OrcidValue { value?: string }
interface OrcidAffiliation {
  organization?: { name?: string; 'disambiguated-organization'?: { 'disambiguation-source'?: string; 'disambiguated-organization-identifier'?: string } };
  'role-title'?: string; 'start-date'?: { year?: OrcidValue }; 'end-date'?: { year?: OrcidValue };
}
interface OrcidAffiliationRecord {
  organization?: string; ror?: string | null; role?: string; startDate?: string; endDate?: string;
}
interface OrcidAffiliationGroup {
  summaries?: OrcidAffiliationGroup[];
  'employment-summary'?: OrcidAffiliation;
  'education-summary'?: OrcidAffiliation;
}
interface OrcidPayload {
  person?: {
    name?: { 'given-names'?: OrcidValue; 'family-name'?: OrcidValue };
    biography?: { content?: string };
    'researcher-urls'?: { 'researcher-url'?: Array<{ 'url-name'?: string; url?: OrcidValue }> };
  };
  'activities-summary'?: {
    employments?: { 'affiliation-group'?: OrcidAffiliationGroup[] };
    educations?: { 'affiliation-group'?: OrcidAffiliationGroup[] };
    works?: { group?: Array<{ 'work-summary'?: Array<{
      title?: { title?: OrcidValue }; 'publication-date'?: { year?: OrcidValue }; type?: string;
      'external-ids'?: { 'external-id'?: Array<{ 'external-id-type'?: string; 'external-id-value'?: string }> };
    }> }> };
  };
}
export type OrcidRecord = ReturnType<typeof formatOrcidData>;
interface OrcidExternalId {
  'external-id-type'?: string; 'external-id-value'?: string; 'external-id-relationship'?: string;
}
interface OrcidWorkSummary {
  'put-code'?: number | string; 'display-index'?: number | string; type?: string;
  title?: { title?: OrcidValue | null } | null;
  'publication-date'?: { year?: OrcidValue | null } | null;
  'external-ids'?: { 'external-id'?: OrcidExternalId[] | null } | null;
}
interface OrcidWorksPayload {
  group?: Array<{ 'external-ids'?: { 'external-id'?: OrcidExternalId[] | null } | null; 'work-summary'?: OrcidWorkSummary[] }>;
}
/** One work of an ORCID record, with only what ORCID says about it; anything it leaves out is null. */
export interface OrcidWork {
  putCode: string | null;
  title: string | null;
  year: number | null;
  /** ORCID's work type, such as `journal-article` or `preprint`. */
  type: string | null;
  doi: string | null;
  /** The identifiers of the work itself (relationship `self`), the DOI among them. */
  externalIds: Array<{ type: string; value: string }>;
}
/** A work of the reader's record, with its paper when OpenAlex knows it. */
export interface OrcidPublication { work: OrcidWork; paper: Paper | null }

/**
 * ORCID API Service
 * Fetches data from the ORCID Public API (v3.0)
 */

import type { Paper } from '../models/paper.ts';
import type { OrcidHost } from '../utils/orcid-id.ts';
import type { OrcidWorkDecision, OrcidWorkDecisions } from './orcid-work-decisions-service.ts';
import type { CitingWork } from './open-alex-service.ts';
import { withRequestDeadline } from '../utils/request-deadline.ts';
import { isValidOrcidId } from '../utils/orcid-id.ts';
import { sameFullName } from '../utils/author-name-match.ts';
import { canonicalArxivIdOf, canonicalDoiOf } from '../utils/paper-canonical-key.ts';
import { CITING_WORKS_MAX_CITED, fetchPapersByDois, fetchPapersByOpenAlexIds, getWorksByOrcid, openAlexAuthorId } from './open-alex-service.ts';

/**
 * One deadline covering the headers and the body. This used to clear its own
 * timer before returning, and it hands the response back unread — so every
 * `response.json()` below happened with no deadline on it at all.
 *
 * Exported for its regression test, which needs a deadline short enough to wait
 * for: the real one is eight seconds.
 */
export const fetchWithTimeout = (url: string, options: RequestInit = {}, timeout = 8000) => (
  fetch(url, withRequestDeadline(options, timeout))
);

/**
 * Validates and extracts a clean ORCID ID from a string or URL.
 * @param {string} input 
 * @returns {string|null} Clean ORCID or null if invalid
 */
export function extractOrcid(input: string): string|null {
  if (!input) return null;
  const match = input.match(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Fetch full ORCID record (biography, employments, education, works)
 * @param {string} orcidId 
 * @returns {Promise<Object|null>}
 */
export async function getOrcidRecord(orcidId: string): Promise<OrcidRecord | null> {
  const cleanOrcid = extractOrcid(orcidId);
  if (!cleanOrcid) return null;

  const url = `https://pub.orcid.org/v3.0/${cleanOrcid}/record`;
  
  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json' }
    });
    
    if (!response.ok) {
      console.warn(`ORCID fetch failed for ${cleanOrcid}: ${response.status}`);
      return null;
    }
    
    const data = await response.json() as OrcidPayload;
    return formatOrcidData(data, cleanOrcid);
  } catch (err) {
    console.error("ORCID fetch exception", err);
    return null;
  }
}

/**
 * Transforms the raw ORCID API response into a more usable format for the UI
 */
function formatOrcidData(data: OrcidPayload, orcidId: string) {
  const person = data.person || {};
  const activities = data['activities-summary'] || {};

  // Name
  const nameObj = person.name || {};
  const firstName = nameObj['given-names']?.value || '';
  const lastName = nameObj['family-name']?.value || '';
  const displayName = `${firstName} ${lastName}`.trim();

  // Biography
  const biography = person.biography?.content || null;

  // External URLs
  const researcherUrls = person['researcher-urls']?.['researcher-url']?.map(u => ({
    name: u['url-name'],
    url: u.url?.value
  })) || [];

  // Employments — ORCID v3 uses group.summaries[0]['employment-summary']
  const employments = activities.employments?.['affiliation-group']?.flatMap(group => {
    const items = group['summaries'] || [group]; // v3 uses 'summaries', fallback for older shape
    return items.map(item => {
      const summary = item['employment-summary'];
      if (!summary) return null;
      const org = summary.organization || {};
      const ror = org['disambiguated-organization']?.['disambiguation-source'] === 'ROR'
        ? org['disambiguated-organization']['disambiguated-organization-identifier']
        : null;
      return {
        organization: org.name,
        ror,
        role: summary['role-title'],
        startDate: summary['start-date']?.year?.value,
        endDate: summary['end-date']?.year?.value
      };
    });
  }).filter(Boolean) as OrcidAffiliationRecord[] || [];

  // Educations — same structure change
  const educations = activities.educations?.['affiliation-group']?.flatMap(group => {
    const items = group['summaries'] || [group];
    return items.map(item => {
      const summary = item['education-summary'];
      if (!summary) return null;
      const org = summary.organization || {};
      const ror = org['disambiguated-organization']?.['disambiguation-source'] === 'ROR'
        ? org['disambiguated-organization']['disambiguated-organization-identifier']
        : null;
      return {
        organization: org.name,
        ror,
        role: summary['role-title'],
        startDate: summary['start-date']?.year?.value,
        endDate: summary['end-date']?.year?.value
      };
    });
  }).filter(Boolean) as OrcidAffiliationRecord[] || [];

  // Top Works (just getting titles and years of a few recent works to show activity)
  const worksGroups = activities.works?.group || [];
  const works = worksGroups.map(group => {
    const summary = group['work-summary']?.[0];
    if (!summary) return null;
    return {
      title: summary.title?.title?.value,
      year: summary['publication-date']?.year?.value,
      type: summary.type,
      doi: summary['external-ids']?.['external-id']?.find(id => id['external-id-type'] === 'doi')?.['external-id-value']
    };
  }).filter(Boolean).sort((a, b) => ((b!.year || 0) as number) - ((a!.year || 0) as number)).slice(0, 5);

  return {
    orcid: orcidId,
    displayName,
    biography,
    researcherUrls,
    employments,
    educations,
    works
  };
}

// ORCID sends a whole record in one response, several megabytes for a large
// one, so it gets twenty seconds; past that the reader is offered to try again.
const WORKS_TIMEOUT_MS = 20_000;
/** The most works of a record the page lists, newest first; it says when a record has more. */
export const ORCID_LISTED_WORKS_MAX = 300;

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** An OpenAlex work id in its short form (`W123`), from the id or its address. */
function openAlexWorkId(value: unknown) {
  return cleanText(value).match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i)?.[1].toUpperCase() ?? null;
}

/** The identifiers of the work itself, not of what it is part of or a version of; a DOI in its canonical spelling. */
function selfIds(list: OrcidExternalId[] | null | undefined) {
  return (Array.isArray(list) ? list : []).flatMap((entry) => {
    const relationship = entry?.['external-id-relationship'];
    if (relationship && relationship !== 'self') return [];
    const type = cleanText(entry?.['external-id-type']).toLowerCase();
    const value = type === 'doi' ? canonicalDoiOf(entry?.['external-id-value']) : cleanText(entry?.['external-id-value']);
    return type && value ? [{ type, value }] : [];
  });
}

/**
 * ORCID groups the versions of one work that share an identifier. Each group
 * is one work here, described by its preferred version, the one with the
 * highest display index, and identified by every version's own identifiers.
 */
function formatOrcidWork(group: NonNullable<OrcidWorksPayload['group']>[number]): OrcidWork | null {
  const summaries = Array.isArray(group?.['work-summary']) ? group['work-summary'] : [];
  if (summaries.length === 0) return null;
  const preferred = summaries.reduce((best, summary) => (
    Number(summary?.['display-index']) > Number(best?.['display-index']) ? summary : best
  ), summaries[0]);
  const own = selfIds(preferred?.['external-ids']?.['external-id']);
  const externalIds: OrcidWork['externalIds'] = [];
  for (const id of [...own, ...selfIds(group?.['external-ids']?.['external-id'])]) {
    if (!externalIds.some(kept => kept.type === id.type && kept.value.toLowerCase() === id.value.toLowerCase())) externalIds.push(id);
  }
  const year = cleanText(preferred?.['publication-date']?.year?.value);
  const putCode = preferred?.['put-code'];
  return {
    putCode: putCode === undefined || putCode === null ? null : String(putCode),
    title: cleanText(preferred?.title?.title?.value) || null,
    year: /^\d{4}$/.test(year) ? Number(year) : null,
    type: cleanText(preferred?.type) || null,
    doi: externalIds.find(id => id.type === 'doi')?.value ?? null,
    externalIds,
  };
}

/**
 * Every public work of an ORCID record, newest first, from ORCID's public API
 * on `host` (production or the sandbox). Throws when ORCID does not answer, so
 * the caller can offer to try again.
 */
export async function getOrcidWorks(orcidId: string, host: OrcidHost = 'orcid.org'): Promise<OrcidWork[]> {
  if (!isValidOrcidId(orcidId)) throw new Error('ORCID_INVALID_ID');
  const response = await fetchWithTimeout(`https://pub.${host}/v3.0/${orcidId}/works`, {
    headers: { Accept: 'application/json' },
  }, WORKS_TIMEOUT_MS);
  if (!response.ok) throw new Error(`ORCID works answered ${response.status}`);
  const payload = await response.json() as OrcidWorksPayload | null;
  const works = (Array.isArray(payload?.group) ? payload.group : []).map(formatOrcidWork).filter((work): work is OrcidWork => work !== null);
  // Stable, so works of the same year, and those with no year at the end, keep ORCID's order.
  return works.sort((a, b) => (b.year ?? -Infinity) - (a.year ?? -Infinity));
}

/** The DOI arXiv gives each preprint, `10.48550/arxiv.<id>` once canonical. */
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/;

/**
 * `arxiv:<id>` for each arXiv id, and for each arXiv DOI among `dois`, so a
 * work one side knows by its arXiv id and the other by arXiv's DOI still
 * matches. Only for matching: no decision is kept under these names.
 */
function arxivKeys(arxivIds: unknown[], dois: string[]) {
  const ids = [...arxivIds, ...dois.map(doi => ARXIV_DOI.exec(doi)?.[1])]
    .map(canonicalArxivIdOf)
    .filter((id): id is string => id !== null);
  return [...new Set(ids)].map(id => `arxiv:${id}`);
}

/**
 * The names a paper is matched by: `doi:<DOI>` (case-insensitive, as
 * canonicalDoiOf spells it) and `openalex:<work id>`, then its arXiv names
 * (arxivKeys). The first one is the name the reader's decision about it is
 * kept under; a paper with neither a DOI nor an OpenAlex id has no names.
 */
export function orcidWorkKeys(paper: Partial<Paper>) {
  const doi = canonicalDoiOf(paper);
  const id = openAlexWorkId(paper.id);
  const names = [doi ? `doi:${doi}` : null, id ? `openalex:${id}` : null].filter((key): key is string => key !== null);
  return names.length > 0 ? [...names, ...arxivKeys([paper.arxivId], doi ? [doi] : [])] : [];
}

/**
 * The names an ORCID work is matched by: every DOI its versions list (a
 * preprint's and the journal's), every OpenAlex id, and its arXiv names.
 */
function recordWorkKeys(work: OrcidWork) {
  const idsOf = (type: string) => work.externalIds.filter(id => id.type === type).map(id => id.value);
  const dois = idsOf('doi');
  const openAlexIds = idsOf('openalex').map(openAlexWorkId).filter((id): id is string => id !== null);
  return [...new Set([
    ...dois.map(doi => `doi:${doi}`),
    ...openAlexIds.map(id => `openalex:${id}`),
    ...arxivKeys(idsOf('arxiv'), dois),
  ])];
}

function papersByKey(papers: Paper[]) {
  const byKey = new Map<string, Paper>();
  for (const paper of papers) {
    for (const key of orcidWorkKeys(paper)) if (!byKey.has(key)) byKey.set(key, paper);
  }
  return byKey;
}

/**
 * Everything My profile shows about the reader's works, read when it opens:
 * the newest ORCID_LISTED_WORKS_MAX works of their ORCID record, each with its
 * OpenAlex paper when OpenAlex knows it; the works OpenAlex attributes to the
 * iD (getWorksByOrcid in open-alex-service.ts); and the reader's decisions
 * about those (`decisionsRead`). A paper attributed to the iD serves the
 * record's work with the same DOI, OpenAlex id or arXiv id, so only the other works are
 * looked up by DOI, with the works the reader added that the attributed list
 * no longer holds. `details` is 'failed' when some of those lookups did not
 * answer: the papers that did answer are kept. Rejects when ORCID or the
 * decisions cannot be read.
 */
export async function loadOrcidPublications(orcidId: string, host: OrcidHost, decisionsRead: Promise<OrcidWorkDecisions>) {
  const [works, attributed, decisions] = await Promise.all([
    getOrcidWorks(orcidId, host),
    // OpenAlex knows production iDs only: a sandbox iD may name someone else there.
    (host === 'orcid.org' ? getWorksByOrcid(orcidId) : Promise.resolve({ papers: [] as Paper[], total: 0, complete: true, authorIds: [] as string[] })).then(
      result => ({ ...result, failed: false }),
      (error: unknown) => {
        console.warn('OpenAlex did not list the works of the ORCID iD', error);
        return { papers: [] as Paper[], total: 0, complete: false, failed: true, authorIds: [] as string[] };
      },
    ),
    decisionsRead,
  ]);
  const listed = works.slice(0, ORCID_LISTED_WORKS_MAX);
  const recordKeys = new Set(works.flatMap(recordWorkKeys));
  const known = papersByKey(attributed.papers);

  const dois = listed.flatMap(work => (work.doi && !recordWorkKeys(work).some(key => known.has(key)) ? [work.doi] : []));
  const addedMissing = decisions.mine.filter(key => !recordKeys.has(key) && !known.has(key));
  const addedDois = addedMissing.filter(key => key.startsWith('doi:')).map(key => key.slice('doi:'.length));
  const addedIds = addedMissing.filter(key => key.startsWith('openalex:')).map(key => key.slice('openalex:'.length));
  const unanswered: string[] = [];
  const onRequestFailed = (ids: string[], error: unknown) => {
    console.warn(`OpenAlex details for ${ids.length} works could not be loaded`, error);
    unanswered.push(...ids);
  };
  const options = { onRequestFailed, includeTopics: true };
  const [byDoi, byId] = await Promise.all([
    fetchPapersByDois([...new Set([...dois, ...addedDois])], options),
    fetchPapersByOpenAlexIds(addedIds, options),
  ]);
  const looked = papersByKey([...byDoi, ...byId]);
  const paperFor = (keys: string[]) => keys.map(key => known.get(key) ?? looked.get(key)).find(paper => paper !== undefined) ?? null;

  return {
    publications: listed.map((work): OrcidPublication => ({ work, paper: paperFor(recordWorkKeys(work)) })),
    /** How many works the record has; more than are listed when it has over ORCID_LISTED_WORKS_MAX. */
    totalWorks: works.length,
    details: unanswered.length > 0 ? 'failed' as const : 'complete' as const,
    recordKeys,
    attributed,
    /** Papers of works the reader added that the attributed list does not hold, found by their identifiers. */
    addedPapers: addedMissing.map(key => looked.get(key)).filter((paper): paper is Paper => paper !== undefined),
    decisions,
  };
}

export type OrcidPublicationsLoad = Awaited<ReturnType<typeof loadOrcidPublications>>;

/** A row of the reader's publications: a work of their ORCID record, or a work they added themselves. */
export type OrcidListedWork =
  | { kind: 'record'; work: OrcidWork; paper: Paper | null }
  | { kind: 'added'; key: string; paper: Paper | null };

/** A work OpenAlex attributes to the iD that the ORCID record does not list, with the reader's decision about it. */
export interface OrcidCandidate { key: string; paper: Paper; decision: OrcidWorkDecision | null }

/**
 * The reader's publications and the candidates for "Might also be yours",
 * from what loadOrcidPublications read and the decisions as they stand now.
 * The publications are the record's listed works and the works the reader
 * added, newest first; a work the record lists is never also an added one.
 * The candidates are the attributed works the record does not list, newest
 * first, each once.
 */
export function arrangeOrcidWorks(loaded: OrcidPublicationsLoad, decisions: OrcidWorkDecisions) {
  const mine = new Set(decisions.mine);
  const notMine = new Set(decisions.notMine);
  const seen = new Set<string>();
  const candidates: OrcidCandidate[] = [];
  for (const paper of loaded.attributed.papers) {
    const keys = orcidWorkKeys(paper);
    // The arXiv names match a work against the record only: two works OpenAlex
    // keeps for one arXiv paper stay two candidates, each with its own decision.
    const names = keys.filter(key => !key.startsWith('arxiv:'));
    if (names.length === 0 || keys.some(key => loaded.recordKeys.has(key)) || names.some(key => seen.has(key))) continue;
    names.forEach(key => seen.add(key));
    const decision = keys.some(key => mine.has(key)) ? 'mine' : keys.some(key => notMine.has(key)) ? 'notMine' : null;
    candidates.push({ key: keys[0], paper, decision });
  }

  const addedByKey = papersByKey([
    ...candidates.filter(candidate => candidate.decision === 'mine').map(candidate => candidate.paper),
    ...loaded.addedPapers,
  ]);
  const added: OrcidListedWork[] = [];
  const shown = new Set<Paper>();
  for (const key of new Set(decisions.mine)) {
    if (loaded.recordKeys.has(key)) continue;
    const paper = addedByKey.get(key) ?? null;
    if (paper && (shown.has(paper) || orcidWorkKeys(paper).some(other => loaded.recordKeys.has(other)))) continue;
    if (paper) shown.add(paper);
    added.push({ kind: 'added', key, paper });
  }

  const yearOf = (item: OrcidListedWork) => (item.kind === 'record' ? item.work.year : item.paper?.year) ?? -Infinity;
  const publications = [
    ...loaded.publications.map((publication): OrcidListedWork => ({ kind: 'record', ...publication })),
    ...added,
  ].sort((a, b) => yearOf(b) - yearOf(a));
  return { publications, candidates };
}

/**
 * The papers of the reader's publications (`arrangeOrcidWorks`), in their
 * order, newest first, each once: the record's works OpenAlex describes and
 * the works the reader added, never one they marked "Not mine". A journal
 * article and its preprint, which OpenAlex keeps as two works under one arXiv
 * paper, are both kept: each has citations of its own.
 */
export function readerPapers(publications: OrcidListedWork[], decisions: OrcidWorkDecisions) {
  const notMine = new Set(decisions.notMine);
  const papers: Paper[] = [];
  const seen = new Set<string>();
  for (const { paper } of publications) {
    if (!paper) continue;
    const keys = orcidWorkKeys(paper);
    const names = keys.filter(key => !key.startsWith('arxiv:'));
    if (keys.some(key => notMine.has(key)) || names.some(key => seen.has(key))) continue;
    names.forEach(key => seen.add(key));
    papers.push(paper);
  }
  return papers;
}

/**
 * The names of the reader's publications OpenAlex has no paper for: a work
 * of their ORCID record by its identifiers, and a work they added by the name
 * they added it under. For you leaves these out too (ENG-251).
 */
export function unmatchedWorkKeys(publications: OrcidListedWork[]) {
  return [...new Set(publications.flatMap((item) => {
    if (item.paper) return [];
    return item.kind === 'record' ? recordWorkKeys(item.work) : [item.key];
  }))];
}

/** The OpenAlex work ids (`W123`) of `papers`, in their order, each once. */
export function readerWorkIds(papers: Paper[]) {
  return [...new Set(papers.map(paper => openAlexWorkId(paper.id)).filter((id): id is string => id !== null))];
}

/** The work ids a citing-works request names: the newest CITING_WORKS_MAX_CITED. */
export function citedWorkIds(papers: Paper[]) {
  return readerWorkIds(papers).slice(0, CITING_WORKS_MAX_CITED);
}

/**
 * What the papers citing the reader's works can be asked for with: 'known'
 * when some of `papers` have an OpenAlex work id; 'failed' when none has one
 * and a lookup of their details (`lookupFailed`) did not answer, so their ids
 * are missing rather than unknown to OpenAlex; 'unknown' otherwise.
 */
export function citedWorksState(papers: Paper[], lookupFailed: boolean) {
  if (citedWorkIds(papers).length > 0) return 'known' as const;
  return lookupFailed ? 'failed' as const : 'unknown' as const;
}

/**
 * The papers citing the reader's works that are not their own: a work with an
 * author whose ORCID iD is `orcidId`, or that is itself one of the reader's
 * works (`readerIds`), is left out. Each keeps, in its reference order, the
 * reader's works it cites.
 */
export function othersCitations(works: CitingWork[], orcidId: string, readerIds: string[]) {
  const reader = orcidId.toUpperCase();
  const ids = new Set(readerIds);
  return works
    .filter(work => !work.orcids.includes(reader) && !ids.has(openAlexWorkId(work.paper.id) ?? ''))
    .map(work => ({ paper: work.paper, cites: [...new Set(work.references.filter(id => ids.has(id)))] }));
}

/** A paper with more authors than this is a large collaboration; its authors are not counted as coauthors. */
export const COAUTHORS_MAX_AUTHORS = 30;
/** How many coauthors My profile shows, and how many works they must share with the reader. */
export const COAUTHORS_SHOWN = 8;
export const COAUTHORS_MIN_SHARED = 2;

export interface Coauthor { id: string; name: string; sharedWorks: number; latestYear: number | null }

/**
 * The reader's frequent coauthors, from the authors of `papers` (readerPapers)
 * known by an OpenAlex author id: those sharing COAUTHORS_MIN_SHARED works or
 * more, by shared works, then the most recent shared year, then name, at most
 * COAUTHORS_SHOWN. A paper of more than COAUTHORS_MAX_AUTHORS authors is
 * skipped, and so is a version of a paper already counted: a work sharing a
 * DOI, OpenAlex id or arXiv paper with an earlier one. The reader is left out:
 * their author ids (`readerAuthorIds`, the ids that carry their iD on
 * OpenAlex), and an author with exactly their name when it is known
 * (`readerName`), for a work OpenAlex files under another id of theirs. Until
 * one of those finds them, an author on every counted paper is taken for the
 * reader too, once there are two counted papers or more.
 */
export function frequentCoauthors(papers: Paper[], { readerAuthorIds, readerName = null }: { readerAuthorIds: string[]; readerName?: string | null }) {
  const reader = new Set(readerAuthorIds.map(openAlexAuthorId).filter((id): id is string => id !== null));
  const found = new Map<string, { name: string; works: Set<number>; latestYear: number | null }>();
  const seen = new Set<string>();
  let counted = 0;
  let foundByName = false;
  papers.forEach((paper, index) => {
    const authors = Array.isArray(paper.authors) ? paper.authors : [];
    const keys = orcidWorkKeys(paper);
    if (authors.length > COAUTHORS_MAX_AUTHORS || keys.some(key => seen.has(key))) return;
    keys.forEach(key => seen.add(key));
    counted += 1;
    for (const author of authors) {
      if (typeof author === 'string') continue;
      const id = openAlexAuthorId(author.id);
      if (!id || reader.has(id)) continue;
      if (sameFullName(readerName, author.name)) {
        foundByName = true;
        continue;
      }
      const entry = found.get(id) ?? { name: cleanText(author.name), works: new Set<number>(), latestYear: null };
      entry.works.add(index);
      if (paper.year && (entry.latestYear === null || paper.year > entry.latestYear)) entry.latestYear = paper.year;
      found.set(id, entry);
    }
  });
  const unresolved = reader.size === 0 && !foundByName && counted >= 2;
  return [...found]
    .map(([id, { name, works, latestYear }]): Coauthor => ({ id, name, sharedWorks: works.size, latestYear }))
    .filter(coauthor => coauthor.sharedWorks >= COAUTHORS_MIN_SHARED && coauthor.name)
    .filter(coauthor => !unresolved || coauthor.sharedWorks < counted)
    .sort((a, b) => b.sharedWorks - a.sharedWorks || (b.latestYear ?? -Infinity) - (a.latestYear ?? -Infinity) || a.name.localeCompare(b.name))
    .slice(0, COAUTHORS_SHOWN);
}
