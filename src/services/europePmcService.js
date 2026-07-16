const API_BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const CACHE_PREFIX = 'papertok_epmc_';
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
const MEMORY_CACHE = new Map();

function isYes(value) {
  return String(value || '').toUpperCase() === 'Y';
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
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
    .filter(value => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getMeshTerms(result) {
  const headings = result?.meshHeadingList?.meshHeading || [];
  return headings.flatMap(heading => {
    const descriptor = typeof heading?.descriptorName === 'string'
      ? heading.descriptorName
      : heading?.descriptorName?.$ || heading?.descriptorName?.value;
    return descriptor ? [descriptor] : [];
  });
}

export function mapEuropePmcResult(result) {
  const pmid = String(result?.pmid || result?.id || '').trim();
  if (!pmid) return null;

  const urls = result?.fullTextUrlList?.fullTextUrl || [];
  const openUrls = urls.filter(item => item?.availabilityCode === 'OA' || /open access/i.test(item?.availability || ''));
  const htmlUrl = safeHttpUrl(openUrls.find(item => item?.documentStyle === 'html')?.url);
  const pdfUrl = safeHttpUrl(openUrls.find(item => item?.documentStyle === 'pdf')?.url);
  const pmcid = String(result?.pmcid || '').trim();
  const europePmcUrl = htmlUrl || (pmcid ? `https://europepmc.org/articles/${encodeURIComponent(pmcid)}` : '');
  const keywords = result?.keywordList?.keyword || [];
  const biomedicalTerms = uniqueTerms([...getMeshTerms(result), ...keywords]);
  const openAccess = isYes(result?.isOpenAccess) || openUrls.length > 0;

  return {
    pmid,
    pmcid: pmcid || undefined,
    abstract: stripMarkup(result?.abstractText),
    biomedicalTerms,
    concepts: biomedicalTerms.map((name, index) => ({
      id: `epmc:${pmid}:${index}`,
      display_name: name,
      level: 2,
    })),
    citationCount: Number(result?.citedByCount) || 0,
    openAccess,
    landingPageUrl: openAccess ? (europePmcUrl || undefined) : undefined,
    openAccessPdfUrl: pdfUrl || undefined,
    europePmcUrl: europePmcUrl || undefined,
    license: result?.license || undefined,
    hasReferences: isYes(result?.hasReferences),
    hasData: isYes(result?.hasData),
    hasSupplement: isYes(result?.hasSuppl),
    accessSource: openAccess ? 'europepmc' : undefined,
  };
}

function readCache(pmid) {
  const memory = MEMORY_CACHE.get(pmid);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${pmid}`));
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(pmid, stored);
      return stored.value;
    }
  } catch { /* Cache is optional. */ }
  return undefined;
}

function writeCache(pmid, value) {
  const entry = { value, timestamp: Date.now(), ttl: value ? POSITIVE_TTL : NEGATIVE_TTL };
  MEMORY_CACHE.set(pmid, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${CACHE_PREFIX}${pmid}`, JSON.stringify(entry)); } catch { /* Cache is optional. */ }
  }
}

export async function enrichPubmedIds(rawPmids) {
  const pmids = [...new Set((rawPmids || []).map(value => String(value || '').trim()).filter(Boolean))];
  const results = new Map();
  const missing = [];

  pmids.forEach(pmid => {
    const cached = readCache(pmid);
    if (cached === undefined) missing.push(pmid);
    else if (cached) results.set(pmid, cached);
  });

  if (missing.length === 0) return results;

  const query = missing.map(pmid => `EXT_ID:${pmid}`).join(' OR ');
  const url = new URL(API_BASE);
  url.searchParams.set('query', `SRC:MED AND (${query})`);
  url.searchParams.set('resultType', 'core');
  url.searchParams.set('format', 'json');
  url.searchParams.set('pageSize', String(missing.length));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Europe PMC Error: ${response.status}`);
    const payload = await response.json();
    const mappedById = new Map(
      (payload?.resultList?.result || [])
        .map(mapEuropePmcResult)
        .filter(Boolean)
        .map(item => [item.pmid, item])
    );

    missing.forEach(pmid => {
      const value = mappedById.get(pmid) || null;
      writeCache(pmid, value);
      if (value) results.set(pmid, value);
    });
  } finally {
    clearTimeout(timeout);
  }

  return results;
}
