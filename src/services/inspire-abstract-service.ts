import type { Paper } from '../models/paper.ts';
import { normalizeDoi } from '../utils/public-navigation.ts';
import { normalizeScientificMarkup } from '../utils/latex.ts';
import { hasUsableAIAbstract } from '../utils/ai-explanation-access.ts';

const cache = new Map<string, { abstract: string; expiresAt: number }>();
let requests: Promise<void> = Promise.resolve();
let retryAt = 0;

interface InspireHit {
  metadata?: { dois?: Array<{ value?: unknown }>; abstracts?: Array<{ value?: unknown }> };
}

/** Public, keyless DOI lookup; never copy a result matched only by title. */
export async function fetchInspireAbstracts(values: string[]): Promise<Partial<Paper>[]> {
  const dois = [...new Set(values.map(normalizeDoi).filter(doi => doi && doi.length <= 240))].slice(0, 40);
  if (!dois.length) return [];
  const lookup = requests.then(async () => {
    // The deadline starts here, not at the call: time spent behind an earlier
    // lookup says nothing about INSPIRE, and must not set the 60 s pause below.
    const signal = AbortSignal.timeout(6_000);
    const missing = dois.filter(doi => !cache.has(doi) || cache.get(doi)!.expiresAt <= Date.now());
    for (let offset = 0; offset < missing.length; offset += 20) {
      signal.throwIfAborted();
      if (Date.now() < retryAt) return;
      const batch = missing.slice(offset, offset + 20);
      const url = new URL('https://inspirehep.net/api/literature');
      url.search = new URLSearchParams({
        q: batch.map(doi => `doi:"${doi.replace(/[\\"]/g, '\\$&')}"`).join(' OR '),
        size: '25', fields: 'dois,abstracts',
      }).toString();
      const response = await fetch(url, { signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        const value = response.headers.get('retry-after');
        const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value || '') - Date.now();
        retryAt = Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : 60_000);
        throw new Error(`INSPIRE abstract lookup failed (${response.status})`);
      }
      const payload = await response.json() as { hits?: { hits?: InspireHit[]; total?: number } };
      const hits = payload?.hits?.hits;
      if (!Array.isArray(hits) || !Number.isInteger(payload.hits?.total)
        || payload.hits!.total! < hits.length || hits.length > 25) {
        throw new Error('Invalid INSPIRE abstract metadata');
      }
      const abstracts = new Map<string, Set<string>>();
      for (const hit of hits) {
        if (!hit?.metadata || (hit.metadata.dois !== undefined && !Array.isArray(hit.metadata.dois))
          || (hit.metadata.abstracts !== undefined && !Array.isArray(hit.metadata.abstracts))) {
          throw new Error('Invalid INSPIRE abstract metadata');
        }
        if (!hit.metadata.dois || !hit.metadata.abstracts) continue;
        const abstract = hit.metadata.abstracts.find(item => typeof item?.value === 'string' && hasUsableAIAbstract(item.value))?.value;
        if (typeof abstract !== 'string') continue;
        const text = normalizeScientificMarkup(abstract);
        if (!hasUsableAIAbstract(text)) continue;
        for (const item of hit.metadata.dois) {
          const doi = normalizeDoi(item?.value);
          if (!batch.includes(doi)) continue;
          const texts = abstracts.get(doi) || new Set<string>();
          texts.add(text);
          abstracts.set(doi, texts);
        }
      }
      // A truncated or conflicting response cannot establish a unique match or absence.
      if (payload.hits!.total !== hits.length) continue;
      for (const doi of batch) {
        const texts = abstracts.get(doi);
        if (texts && texts.size > 1) continue;
        const abstract = texts?.values().next().value || '';
        cache.delete(doi);
        cache.set(doi, { abstract, expiresAt: Date.now() + (abstract ? 7 * 24 : 6) * 60 * 60 * 1000 });
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
      }
    }
  });
  requests = lookup.catch(() => { retryAt = Math.max(retryAt, Date.now() + 60_000); });
  await lookup;
  return dois.flatMap(doi => {
    const entry = cache.get(doi);
    return entry?.abstract && entry.expiresAt > Date.now()
      ? [{ doi, abstract: entry.abstract, sources: { primary: 'inspire', enrichedBy: [] } }]
      : [];
  });
}
