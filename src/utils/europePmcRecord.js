/**
 * Europe PMC answers two different questions in this app -- "enrich this PMID"
 * (`europePmcService`) and "give me papers for these categories"
 * (`domainSourceService`) -- and each grew its own reader of the same payload.
 * The two had already drifted apart in four measurable places: what counts as
 * open access (`OA` only, against `OA` or `F` plus the `isOpenAccess` flag),
 * whether HTML entities in the abstract get decoded, whether terms dedupe
 * case-insensitively, and which shapes of `descriptorName` the MeSH list is
 * read from. That is the same debt as the `openalex:` filter that answered 400
 * for years and the inverted index rebuilt four times over, so -- as with
 * `reconstructOpenAlexAbstract` and `buildOpenAlexIdFilter` -- there is one
 * reader now.
 *
 * It returns the normalized record and nothing else: each caller keeps its own
 * output shape, because a Paper and an enrichment patch are not the same thing.
 * Where the two readings disagreed the union wins -- a record either side
 * called open is open, a term either side kept is kept.
 */

import { safeCatalogUrl } from './externalUrl.js';

// `OA` is open access; `F` is free full text. Both mean the reader can open it,
// which is the only question either caller is asking.
const OPEN_AVAILABILITY_CODES = new Set(['OA', 'F']);

function isYes(value) {
  return String(value || '').toUpperCase() === 'Y';
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueTerms(values) {
  const seen = new Set();
  return values
    .map(stripMarkup)
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// The MeSH descriptor arrives as a string from the JSON API and as `{ $ }` or
// `{ value }` from the payloads converted out of XML. Each caller supported a
// different subset, which is exactly how the same article ended up with terms
// in one view and none in the other.
function meshDescriptors(raw) {
  const headings = raw?.meshHeadingList?.meshHeading || [];
  return headings.flatMap((heading) => {
    const descriptor = typeof heading?.descriptorName === 'string'
      ? heading.descriptorName
      : heading?.descriptorName?.$ || heading?.descriptorName?.value;
    return descriptor ? [descriptor] : [];
  });
}

function isOpenFullTextUrl(item) {
  return OPEN_AVAILABILITY_CODES.has(String(item?.availabilityCode || '').toUpperCase())
    || /open access/i.test(String(item?.availability || ''));
}

export function mapEuropePmcRecord(raw) {
  const declaredOpen = isYes(raw?.isOpenAccess);
  const urls = raw?.fullTextUrlList?.fullTextUrl || [];
  const openUrls = urls.filter(item => declaredOpen || isOpenFullTextUrl(item));
  const htmlUrl = safeCatalogUrl(openUrls.find(item => item?.documentStyle === 'html')?.url);
  const pdfUrl = safeCatalogUrl(openUrls.find(item => item?.documentStyle === 'pdf')?.url);
  const pmcid = String(raw?.pmcid || '').trim();
  const terms = uniqueTerms([...meshDescriptors(raw), ...(raw?.keywordList?.keyword || [])]);

  return {
    pmid: String(raw?.pmid || '').trim(),
    providerId: String(raw?.id || '').trim(),
    pmcid,
    abstract: stripMarkup(raw?.abstractText),
    terms,
    openAccess: declaredOpen || openUrls.length > 0,
    htmlUrl,
    pdfUrl,
    europePmcUrl: htmlUrl || (pmcid ? `https://europepmc.org/articles/${encodeURIComponent(pmcid)}` : ''),
    citationCount: Number(raw?.citedByCount) || 0,
    license: raw?.license || undefined,
    hasReferences: isYes(raw?.hasReferences),
    hasData: isYes(raw?.hasData),
    hasSupplement: isYes(raw?.hasSuppl),
  };
}
