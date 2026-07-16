import { normalizeDoi } from './unpaywallService.js';

const API_BASE = 'https://api.datacite.org/dois';
const CACHE_PREFIX = 'papertok_datacite_';
const POSITIVE_TTL = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 24 * 60 * 60 * 1000;
const MEMORY_CACHE = new Map();
const MAX_RESOURCES = 8;

const RESOURCE_TYPES = Object.freeze({
  dataset: new Set(['dataset']),
  software: new Set(['software', 'workflow', 'computationalnotebook']),
  material: new Set(['collection', 'physicalobject', 'image', 'audiovisual', 'interactiveresource', 'model', 'instrument']),
});

const VERSION_RELATIONS = new Set([
  'HasVersion', 'IsVersionOf', 'IsNewVersionOf', 'IsPreviousVersionOf', 'IsIdenticalTo',
]);

const DIRECT_RELATIONS = new Set([
  ...VERSION_RELATIONS,
  'HasPart', 'IsPartOf', 'IsSupplementTo', 'IsSupplementedBy', 'IsDocumentedBy',
  'Documents', 'IsSourceOf', 'IsDerivedFrom', 'IsMetadataFor', 'HasMetadata',
]);

const TITLE_STOP_WORDS = new Set([
  'about', 'associated', 'data', 'dataset', 'datos', 'from', 'para', 'paper', 'related',
  'sobre', 'supplement', 'supplementary', 'the', 'with', 'this', 'that', 'using',
]);

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}

function getResourceKind(resourceTypeGeneral, relationType) {
  const normalizedType = String(resourceTypeGeneral || '').toLowerCase().replace(/[^a-z]/g, '');
  if (VERSION_RELATIONS.has(relationType)) return 'version';
  return Object.entries(RESOURCE_TYPES).find(([, values]) => values.has(normalizedType))?.[0] || null;
}

function getResourceUrl(identifier, identifierType) {
  if (String(identifierType || '').toUpperCase() === 'DOI') {
    const doi = normalizeDoi(identifier);
    return doi ? `https://doi.org/${doi}` : '';
  }
  return safeHttpUrl(identifier);
}

function getTitle(attributes, kind) {
  return attributes?.titles?.find(title => title?.title)?.title
    || ({ dataset: 'Dataset asociado', software: 'Software asociado', material: 'Material asociado', version: 'Versión relacionada' }[kind]);
}

function getMeaningfulTitleTokens(value) {
  return new Set(String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 5 && !TITLE_STOP_WORDS.has(token)));
}

function hasMeaningfulTitleOverlap(paperTitle, resourceTitle) {
  if (!paperTitle) return true;
  const paperTokens = getMeaningfulTitleTokens(paperTitle);
  const resourceTokens = getMeaningfulTitleTokens(resourceTitle);
  const shared = [...paperTokens].filter(token => resourceTokens.has(token));
  return shared.length >= 2 || shared.some(token => token.length >= 12);
}

export function mapDataCiteRecord(record, targetDoi, targetTitle = '') {
  const attributes = record?.attributes;
  const doi = normalizeDoi(attributes?.doi || record?.id);
  const normalizedTarget = normalizeDoi(targetDoi);
  if (!attributes || !doi || doi === normalizedTarget) return null;

  const matchingRelation = (attributes.relatedIdentifiers || []).find(relation => (
    normalizeDoi(relation?.relatedIdentifier) === normalizedTarget
  ));
  if (!matchingRelation || !DIRECT_RELATIONS.has(matchingRelation.relationType)) return null;

  const kind = getResourceKind(attributes.types?.resourceTypeGeneral, matchingRelation.relationType);
  if (!kind) return null;
  const title = getTitle(attributes, kind);
  if (!hasMeaningfulTitleOverlap(targetTitle, title)) return null;

  const url = safeHttpUrl(attributes.url) || `https://doi.org/${doi}`;
  return {
    id: doi,
    doi,
    kind,
    title,
    relationType: matchingRelation.relationType || '',
    resourceType: attributes.types?.resourceType || attributes.types?.resourceTypeGeneral || '',
    publisher: typeof attributes.publisher === 'string' ? attributes.publisher : attributes.publisher?.name || '',
    year: Number(attributes.publicationYear) || null,
    url,
    viewCount: Number(attributes.viewCount) || 0,
    downloadCount: Number(attributes.downloadCount) || 0,
    citationCount: Number(attributes.citationCount) || 0,
  };
}

export function mapDataCiteDirectRelations(record, targetDoi) {
  const attributes = record?.attributes;
  if (!attributes) return [];

  return (attributes.relatedIdentifiers || []).flatMap(relation => {
    if (!DIRECT_RELATIONS.has(relation?.relationType)) return [];
    const kind = getResourceKind(relation.resourceTypeGeneral, relation.relationType);
    if (!kind) return [];
    const url = getResourceUrl(relation.relatedIdentifier, relation.relatedIdentifierType);
    if (!url) return [];
    const relatedDoi = String(relation.relatedIdentifierType || '').toUpperCase() === 'DOI'
      ? normalizeDoi(relation.relatedIdentifier)
      : '';
    if (relatedDoi && relatedDoi === normalizeDoi(targetDoi)) return [];
    return [{
      id: relatedDoi || url,
      doi: relatedDoi || undefined,
      kind,
      title: ({ dataset: 'Dataset asociado', software: 'Software asociado', material: 'Material asociado', version: 'Versión relacionada' }[kind]),
      relationType: relation.relationType,
      resourceType: relation.resourceTypeGeneral || '',
      publisher: '',
      year: null,
      url,
      viewCount: 0,
      downloadCount: 0,
      citationCount: 0,
    }];
  });
}

function readCache(doi) {
  const memory = MEMORY_CACHE.get(doi);
  if (memory && Date.now() - memory.timestamp < memory.ttl) return memory.value;
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const stored = JSON.parse(localStorage.getItem(`${CACHE_PREFIX}${doi}`));
    if (stored && Date.now() - stored.timestamp < stored.ttl) {
      MEMORY_CACHE.set(doi, stored);
      return stored.value;
    }
  } catch { /* Cache is optional. */ }
  return undefined;
}

function writeCache(doi, value) {
  const entry = { value, timestamp: Date.now(), ttl: value.length > 0 ? POSITIVE_TTL : NEGATIVE_TTL };
  MEMORY_CACHE.set(doi, entry);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(`${CACHE_PREFIX}${doi}`, JSON.stringify(entry)); } catch { /* Cache is optional. */ }
  }
}

async function fetchJson(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/vnd.api+json' } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`DataCite Error: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function deduplicateResources(resources) {
  const seen = new Set();
  const priority = { dataset: 0, software: 1, material: 2, version: 3 };
  return resources
    .filter(resource => {
      const key = resource.doi || resource.url;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (
      (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9)
      || (b.downloadCount + b.viewCount + b.citationCount) - (a.downloadCount + a.viewCount + a.citationCount)
    ))
    .slice(0, MAX_RESOURCES);
}

export async function getRelatedResearchResources(rawDoi, { title = '' } = {}) {
  const doi = normalizeDoi(rawDoi);
  if (!doi || !doi.startsWith('10.')) return [];
  const cached = readCache(doi);
  if (cached !== undefined) return cached;

  const reverseUrl = new URL(API_BASE);
  reverseUrl.searchParams.set('query', `relatedIdentifiers.relatedIdentifier:"${doi}" AND relatedIdentifiers.relationType:(HasVersion OR IsVersionOf OR IsNewVersionOf OR IsPreviousVersionOf OR IsIdenticalTo OR HasPart OR IsPartOf OR IsSupplementTo OR IsSupplementedBy OR IsDocumentedBy OR Documents OR IsSourceOf OR IsDerivedFrom OR IsMetadataFor OR HasMetadata) AND types.resourceTypeGeneral:(Dataset OR Software OR Workflow OR ComputationalNotebook OR Collection OR PhysicalObject OR Image OR Audiovisual OR InteractiveResource OR Model OR Instrument)`);
  reverseUrl.searchParams.set('page[size]', '20');

  const [directResult, reverseResult] = await Promise.allSettled([
    fetchJson(`${API_BASE}/${encodeURIComponent(doi)}`),
    fetchJson(reverseUrl),
  ]);
  const directResources = directResult.status === 'fulfilled' && directResult.value
    ? mapDataCiteDirectRelations(directResult.value.data, doi)
    : [];
  const reverseResources = reverseResult.status === 'fulfilled'
    ? (reverseResult.value?.data || []).map(record => mapDataCiteRecord(record, doi, title)).filter(Boolean)
    : [];
  const resources = deduplicateResources([...reverseResources, ...directResources]);
  writeCache(doi, resources);
  return resources;
}
