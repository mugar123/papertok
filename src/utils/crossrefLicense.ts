/**
 * Whether Crossref says the published version of a paper is openly licensed
 * today. Shared by the Worker's `/oa` fallback and the Crossref institution
 * fallback, so the two cannot read the same record two ways.
 *
 * Crossref carries the licence from the minute a DOI is registered, which is
 * what makes it worth asking: for a paper a day old, Unpaywall and OpenAlex are
 * blind together (measured 2026-09-23: of 33 fresh CC-licensed PubMed records,
 * the same 11 were unknown to both). Reading it takes three rules, and the
 * records break each one:
 *
 * 1. Only Creative Commons. Elsevier lists its text-mining licence first
 *    (`elsevier.com/tdm/userlicense/1.0/`) and adds STM article-sharing
 *    policies (`doi.org/10.15223/policy-*`); none of them lets anyone read.
 * 2. Only the version of record (`vor`, or `unspecified`). A CC licence on the
 *    accepted manuscript alone is what a rights-retention subscription article
 *    carries, and Springer Nature also deposits its gold papers that way; the
 *    first would be a false "open", so both wait for Unpaywall.
 * 3. In force now: `start` no later than today. Not `delay-in-days`, which is
 *    counted from `issued`, so an issue dated January makes a paper that went
 *    online open in September look 252 days late.
 */

const READABLE_VERSIONS = new Set(['vor', 'unspecified']);

/** `cc-by`, `cc-by-nc-nd`, `cc0`, `public-domain`, or null for anything else. */
export function licenseSlugFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (!/^(?:www\.)?creativecommons\.org$/i.test(url.hostname)) return null;
  const path = url.pathname.toLowerCase();
  const licence = path.match(/^\/licenses\/(by(?:-(?:nc|nd|sa))*)(?:\/|$)/);
  if (licence) return `cc-${licence[1]}`;
  if (/^\/publicdomain\/zero(?:\/|$)/.test(path)) return 'cc0';
  if (/^\/publicdomain\/mark(?:\/|$)/.test(path)) return 'public-domain';
  return null;
}

function licenceStart(entry) {
  const dateTime = entry?.start?.['date-time'];
  const parsed = Date.parse(dateTime || '');
  if (Number.isFinite(parsed)) return { ms: parsed, iso: dateTime };
  const [year, month = 1, day = 1] = entry?.start?.['date-parts']?.[0] || [];
  if (!year) return null;
  const ms = Date.UTC(year, month - 1, day);
  return { ms, iso: new Date(ms).toISOString() };
}

/**
 * The first licence that opens the version of record today, as
 * `{ url, slug, start }`, or null. `now` is injectable for the embargo case.
 */
export function openLicenseFromCrossref(work, { now = Date.now() } = {}) {
  const entries = Array.isArray(work?.license) ? work.license : [];
  for (const entry of entries) {
    const version = String(entry?.['content-version'] || 'unspecified').toLowerCase();
    if (!READABLE_VERSIONS.has(version)) continue;
    const slug = licenseSlugFromUrl(entry?.URL);
    if (!slug) continue;
    const start = licenceStart(entry);
    // No start at all is rare; then the delay is the only word on an embargo.
    if (start ? start.ms > now : Number(entry?.['delay-in-days']) > 0) continue;
    return { url: entry.URL, slug, start: start?.iso || null };
  }
  return null;
}
