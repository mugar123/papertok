const API_BASE = 'https://api.ror.org/v2/organizations';
const CACHE_PREFIX = 'papertok_ror_v2_';
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
const MEMORY_CACHE = new Map();

export function normalizeRorId(value) {
  const match = String(value || '').trim().match(/(?:ror\.org\/)?(0[a-hj-km-np-tv-z0-9]{6}[0-9]{2})/i);
  return match?.[1]?.toLowerCase() || '';
}

function getPreferredName(names = []) {
  return names.find(name => name?.types?.includes('ror_display'))?.value
    || names.find(name => name?.types?.includes('label'))?.value
    || names.find(name => name?.value)?.value
    || '';
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeRorInstitution(record) {
  const rorId = normalizeRorId(record?.id);
  if (!rorId) return null;
  const names = record.names || [];
  const displayName = getPreferredName(names);
  if (!displayName) return null;
  const location = record.locations?.[0]?.geonames_details || {};
  const links = record.links || [];
  const rorUrl = `https://ror.org/${rorId}`;

  return {
    id: rorUrl,
    ror: rorUrl,
    display_name: displayName,
    aliases: uniqueStrings(names.filter(name => !name.types?.includes('ror_display')).map(name => name.value)),
    acronyms: uniqueStrings(names.filter(name => name.types?.includes('acronym')).map(name => name.value)),
    country_code: location.country_code || '',
    type: record.types?.[0] || 'other',
    types: record.types || [],
    geo: {
      city: location.name || '',
      country: location.country_name || '',
      country_code: location.country_code || '',
      latitude: Number.isFinite(location.lat) ? location.lat : null,
      longitude: Number.isFinite(location.lng) ? location.lng : null,
    },
    domains: record.domains || [],
    established: Number(record.established) || null,
    homepage_url: safeHttpUrl(links.find(link => link.type === 'website')?.value),
    wikipedia_url: safeHttpUrl(links.find(link => link.type === 'wikipedia')?.value),
    relationships: (record.relationships || []).map(relationship => ({
      id: relationship.id,
      rorId: normalizeRorId(relationship.id),
      label: relationship.label,
      type: relationship.type,
    })).filter(relationship => relationship.rorId && relationship.label),
    status: record.status || 'active',
    works_count: null,
    cited_by_count: null,
    summary_stats: null,
    rorVerified: true,
    _metadataSource: 'ror',
    _rorId: rorId,
  };
}

export function mergeInstitutionWithRor(openAlexInstitution, rorInstitution) {
  if (!rorInstitution) return openAlexInstitution || null;
  if (!openAlexInstitution) return rorInstitution;

  return {
    ...rorInstitution,
    ...openAlexInstitution,
    id: openAlexInstitution.id || rorInstitution.id,
    ror: rorInstitution.ror,
    display_name: rorInstitution.display_name || openAlexInstitution.display_name,
    aliases: uniqueStrings([...(openAlexInstitution.aliases || []), ...(rorInstitution.aliases || [])]),
    country_code: rorInstitution.country_code || openAlexInstitution.country_code || '',
    type: rorInstitution.type || openAlexInstitution.type,
    types: rorInstitution.types,
    geo: {
      ...(openAlexInstitution.geo || {}),
      ...(rorInstitution.geo || {}),
    },
    domains: rorInstitution.domains,
    established: rorInstitution.established,
    homepage_url: rorInstitution.homepage_url || openAlexInstitution.homepage_url,
    wikipedia_url: rorInstitution.wikipedia_url,
    relationships: rorInstitution.relationships,
    rorVerified: true,
    _metadataSource: 'openalex+ror',
    _rorId: rorInstitution._rorId,
  };
}

function readCache(rorId) {
  const memory = MEMORY_CACHE.get(rorId);
  if (memory && Date.now() - memory.timestamp < CACHE_TTL) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${rorId}`));
    if (stored && Date.now() - stored.timestamp < CACHE_TTL) {
      MEMORY_CACHE.set(rorId, stored);
      return stored.value;
    }
  } catch { /* Cache is optional. */ }
  return undefined;
}

function writeCache(rorId, value) {
  const entry = { value, timestamp: Date.now() };
  MEMORY_CACHE.set(rorId, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${CACHE_PREFIX}${rorId}`, JSON.stringify(entry)); } catch { /* Cache is optional. */ }
  }
}

async function fetchJson(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`ROR Error: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRorInstitution(value) {
  const rorId = normalizeRorId(value);
  if (!rorId) return null;
  const cached = readCache(rorId);
  if (cached !== undefined) return cached;
  const record = await fetchJson(`${API_BASE}/${encodeURIComponent(rorId)}`);
  const institution = normalizeRorInstitution(record);
  writeCache(rorId, institution);
  return institution;
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export async function searchRorInstitutions(query, limit = 8) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];
  const url = new URL(API_BASE);
  url.searchParams.set('query', cleanQuery);
  const payload = await fetchJson(url);
  return (payload?.items || [])
    .map(normalizeRorInstitution)
    .filter(Boolean)
    .slice(0, limit);
}

export async function resolveRorInstitution({ ror, name, domain } = {}) {
  if (ror) {
    const direct = await getRorInstitution(ror).catch(() => null);
    if (direct) return direct;
  }
  const candidates = await searchRorInstitutions(name || domain || '', 12).catch(() => []);
  if (candidates.length === 0) return null;
  const normalizedDomain = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (normalizedDomain) {
    const domainMatch = candidates.find(candidate => candidate.domains.some(candidateDomain => candidateDomain.toLowerCase().replace(/^www\./, '') === normalizedDomain));
    if (domainMatch) return domainMatch;
  }
  const normalizedName = normalizeName(name);
  return candidates.find(candidate => (
    normalizeName(candidate.display_name) === normalizedName
    || candidate.aliases.some(alias => normalizeName(alias) === normalizedName)
  )) || candidates[0];
}
