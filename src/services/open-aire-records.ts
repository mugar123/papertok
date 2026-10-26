interface OpenAirePayload { header?: { numFound?: unknown } | null; results?: unknown }
interface OpenAirePid { scheme?: unknown; value?: unknown }
export interface OpenAireProduct { pids?: OpenAirePid[] | null }

// OpenAIRE's Graph API V3, for the browser and the Worker alike. It replaces
// the Search API (`api.openaire.eu/search`), whose retirement OpenAIRE
// announced for 2026-05-31 (ENG-28).
export const OPENAIRE_GRAPH_URL = 'https://api.openaire.eu/graph/v3';

// Offset paging answers 400 once `page * pageSize` passes 10,000 (measured
// 2026-10-23).
export const OPENAIRE_OFFSET_LIMIT = 10_000;

/**
 * How `/projects` is asked for one project: by its OpenAIRE id, which names
 * one project, or by grant code and the funder's short name. A code alone is
 * not unique: 100010 is an NHMRC, an SNSF and a UKRI grant.
 */
export function openAireProjectParams(projectId: string, funder = ''): Record<string, string> {
  if (projectId.includes('::')) return { id: projectId };
  return funder ? { code: projectId, fundingShortName: funder } : { code: projectId };
}

/**
 * One page of a project's publications, newest first. `research-products`
 * also lists datasets and software, hence `type=publication`. Unsorted, the
 * first 30 of TAILOR's 1,428 publications were repository handles with no DOI
 * or arXiv id; newest first, 28 of 30 had one (2026-10-23).
 */
export function openAireProjectPublicationsUrl(projectId: string, { funder = '', page = 1, pageSize }: { funder?: string; page?: number; pageSize: number }) {
  const url = new URL(`${OPENAIRE_GRAPH_URL}/research-products`);
  if (projectId.includes('::')) url.searchParams.set('relProjectId', projectId);
  else {
    url.searchParams.set('relProjectCode', projectId);
    if (funder) url.searchParams.set('relProjectFundingShortName', funder);
  }
  url.searchParams.set('type', 'publication');
  url.searchParams.set('sortBy', 'publicationDate DESC');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  return url;
}

/**
 * The rows and total of a Graph list. A payload of any other shape throws:
 * read as an empty list, it would report a project with no publications.
 */
export function readOpenAirePage<Row>(payload: unknown) {
  const page: OpenAirePayload = typeof payload === 'object' && payload !== null ? payload : {};
  const total = page.header?.numFound;
  if (!Array.isArray(page.results) || typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new Error('Invalid OpenAIRE response');
  }
  return { results: page.results as Row[], total };
}

/** A research product's identifiers in one scheme, spelt as Graph spells it. */
export function openAirePids(product: OpenAireProduct | null | undefined, scheme: 'doi' | 'arXiv') {
  if (!Array.isArray(product?.pids)) return [];
  return product.pids.flatMap(pid => {
    const value = pid?.scheme === scheme && typeof pid.value === 'string' ? pid.value.trim() : '';
    return value ? [value] : [];
  });
}
