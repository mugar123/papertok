import type { WorkerEnv } from './env.ts';
import type { UpstreamError } from './provider-runtime.ts';

import { openLicenseFromCrossref } from '../src/utils/crossref-license.ts';
import { allowedOrigins, corsHeaders, json } from './http.ts';
import { cacheResponse, fetchJsonUpstream, fetchJsonWithTimeout, SOURCE_UPSTREAM_TIMEOUT_MS } from './provider-runtime.ts';

const OA_CACHE_SECONDS = 7 * 24 * 60 * 60;
// A DOI neither Unpaywall nor Crossref can speak for yet. Uncached, every card
// that showed it asked again on every visit; a week would hide the paper's
// access for days after Unpaywall indexes it, which is usually within one or two.
const OA_UNRESOLVED_CACHE_SECONDS = 6 * 60 * 60;
// The misses one caller may send in a UTC minute. The route has no shared
// ceiling: Unpaywall and Crossref are free, but both throttle by our contact
// address, so one script could close them for every reader. A feed card asks
// once per DOI and the browser keeps the answer, so a reader scrolling fast or
// opening a citation graph stays well under it.
const OA_CALLER_MINUTE = Object.freeze({ namespace: 'oa', limit: 120 });

/** Unpaywall's record of a DOI, as `/oa` asks for it and `/access` reads it for SFX libraries. */
export function unpaywallUrl(doi: string, env: WorkerEnv) {
  return `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(env.UNPAYWALL_EMAIL || 'app@papertok.io')}`;
}

export async function handleOpenAccess(request: Request, env: WorkerEnv) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin') || '';
  if (origin && !allowedOrigins(env).has(origin)) return json({ error: 'Origin not allowed' }, 403);
  const doi = (requestUrl.searchParams.get('doi') || '').trim().toLowerCase();
  if (!/^10\.\d{4,9}\/.+/.test(doi) || doi.length > 300) {
    return json({ error: 'Invalid DOI' }, 400, corsHeaders(origin, env));
  }
  const ttl = (payload: { source?: string } | null) => (payload?.source === 'unresolved' ? OA_UNRESOLVED_CACHE_SECONDS : OA_CACHE_SECONDS);
  return cacheResponse(request, origin, env, ttl, async () => {
    try {
      return await fetchJsonWithTimeout<{ source?: string }>(unpaywallUrl(doi, env), {
        headers: { accept: 'application/json' },
      }, SOURCE_UPSTREAM_TIMEOUT_MS);
    } catch (error) {
      // Only "Unpaywall has not indexed this DOI" goes on to Crossref. It used
      // to leave as a 502 that nothing cached, for every paper a day old; an
      // outage still does, because caching "no copy" for it would be wrong for
      // a week.
      if ((error as UpstreamError)?.status !== 404) throw error;
    }
    return openAccessFromCrossref(doi);
  }, { canonicalParams: { doi }, callerMinute: OA_CALLER_MINUTE });
}

// Unpaywall's shape, so every client already reads it: a Crossref licence on
// the version of record is a copy at the publisher. No PDF link, because
// Crossref's are text-mining links that often need a token to open.
async function openAccessFromCrossref(doi: string) {
  let work = null;
  try {
    const payload = await fetchJsonUpstream<{ message?: Parameters<typeof openLicenseFromCrossref>[0] }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=app@papertok.io`);
    work = payload?.message || null;
  } catch (error) {
    // A DOI registered with DataCite or mEDRA is simply not in Crossref.
    if ((error as UpstreamError)?.status !== 404) throw error;
  }
  const doiUrl = `https://doi.org/${doi}`;
  const license = openLicenseFromCrossref(work);
  if (!license) {
    return { doi, doi_url: doiUrl, is_oa: null, best_oa_location: null, oa_locations: [], source: 'unresolved' };
  }
  const location = {
    host_type: 'publisher',
    version: 'publishedVersion',
    license: license.slug,
    url: doiUrl,
    url_for_landing_page: doiUrl,
    url_for_pdf: null,
    evidence: 'crossref license',
    is_best: true,
  };
  return { doi, doi_url: doiUrl, is_oa: true, best_oa_location: location, oa_locations: [location], source: 'crossref' };
}
