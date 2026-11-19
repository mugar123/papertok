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
/** A work of the reader's record, with its paper when OpenAlex knows its DOI. */
export interface OrcidPublication { work: OrcidWork; paper: Paper | null }

/**
 * ORCID API Service
 * Fetches data from the ORCID Public API (v3.0)
 */

import type { Paper } from '../models/paper.ts';
import type { OrcidHost } from '../utils/orcid-id.ts';
import { withRequestDeadline } from '../utils/request-deadline.ts';
import { isValidOrcidId } from '../utils/orcid-id.ts';
import { canonicalDoiOf } from '../utils/paper-canonical-key.ts';
import { fetchPapersByDois } from './open-alex-service.ts';

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

const WORKS_TIMEOUT_MS = 10_000;

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
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

/**
 * The works of the reader's ORCID record, each with its OpenAlex paper when
 * OpenAlex has its DOI. `details` is 'failed' when OpenAlex did not answer:
 * the works are still listed, with only what ORCID gives.
 */
export async function loadOrcidPublications(orcidId: string, host: OrcidHost) {
  const works = await getOrcidWorks(orcidId, host);
  const dois = [...new Set(works.map(work => work.doi).filter((doi): doi is string => Boolean(doi)))];
  let papers: Paper[] = [];
  let details: 'complete' | 'failed' = 'complete';
  try {
    papers = dois.length > 0 ? await fetchPapersByDois(dois, { strict: true }) : [];
  } catch (error) {
    console.warn('OpenAlex details for the ORCID works could not be loaded', error);
    details = 'failed';
  }
  const byDoi = new Map(papers.map(paper => [canonicalDoiOf(paper), paper]));
  const publications: OrcidPublication[] = works.map(work => ({ work, paper: (work.doi && byDoi.get(work.doi)) || null }));
  return { publications, details };
}
