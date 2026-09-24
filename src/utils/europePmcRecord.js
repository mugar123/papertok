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
import { orderMeshDescriptors } from './meshCheckTags.js';

// `OA` is open access; `F` is free full text. Both mean the reader can open it,
// which is the only question either caller is asking.
const OPEN_AVAILABILITY_CODES = new Set(['OA', 'F']);

function isYes(value) {
  return String(value || '').toUpperCase() === 'Y';
}

// Europe PMC writes a structured abstract's section headings as <h4> and does
// NOT escape a comparison sign, so only these tags are markup. Deleting
// anything from "<" to the next ">" erased "< .001) compared with PNI and
// GPS." from PMID 42629277 and glued the next heading on to the text
// (audit 2026-09-23). Block tags part the text; inline tags only lose their
// brackets. Entities are decoded afterwards, so an escaped `&lt;i&gt;` stays
// the text it was written as.
const HEADING_TAG = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|section|title)\b[^>]*>/gi;
const INLINE_TAG = /<\/?(?:i|b|em|strong|sup|sub|span|a|u|small|abbr|italic|bold|sc)\b[^>]*>/gi;

function headingLabel(_match, _level, text) {
  const label = String(text || '').replace(INLINE_TAG, '').replace(/\s+/g, ' ').trim();
  if (!label) return ' ';
  return /[:.]$/.test(label) ? ` ${label} ` : ` ${label}: `;
}

function stripMarkup(value) {
  return String(value || '')
    .replace(HEADING_TAG, headingLabel)
    .replace(BLOCK_TAG, ' ')
    .replace(INLINE_TAG, '')
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
// Major topics first and without check tags ("Humans", "Mice"), as the
// PubMed reader orders them (utils/meshCheckTags.js).
function meshDescriptors(raw) {
  const headings = raw?.meshHeadingList?.meshHeading || [];
  return orderMeshDescriptors(headings.flatMap((heading) => {
    const descriptor = typeof heading?.descriptorName === 'string'
      ? heading.descriptorName
      : heading?.descriptorName?.$ || heading?.descriptorName?.value;
    if (!descriptor) return [];
    const qualifiers = heading?.meshQualifierList?.meshQualifier || [];
    return [{
      name: descriptor,
      major: isYes(heading?.majorTopic_YN) || qualifiers.some(qualifier => isYes(qualifier?.majorTopic_YN)),
    }];
  }));
}

// The core record names each author in full, with an ORCID and affiliations
// when it has them; `name` stays Europe PMC's own "Surname INITIALS", which is
// what the card has always shown.
function recordAuthors(raw) {
  const authors = raw?.authorList?.author || [];
  return authors.flatMap((author) => {
    const collective = stripMarkup(author?.collectiveName);
    const name = collective || stripMarkup(author?.fullName);
    if (!name) return [];
    const fullName = collective || [stripMarkup(author?.firstName), stripMarkup(author?.lastName)].filter(Boolean).join(' ') || name;
    const orcid = String(author?.authorId?.type || '').toUpperCase() === 'ORCID'
      ? String(author.authorId.value || '').trim().match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/i)?.[1]?.toUpperCase()
      : '';
    const affiliation = stripMarkup(author?.authorAffiliationDetailsList?.authorAffiliation?.[0]?.affiliation || author?.affiliation);
    return [{
      name,
      fullName,
      ...(orcid ? { orcid } : {}),
      ...(affiliation ? { affiliation } : {}),
    }];
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
    authors: recordAuthors(raw),
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
