import type { Paper } from '../models/paper.ts';
import type { PositiveExample } from './interaction-profile.ts';

import { areaKeyForCategory, areaKeyForOpenAlexTopic, leavesForOpenAlexTopic } from './area-accent.ts';
import { doiPathId } from './open-alex-work.ts';
import { canonicalArxivIdOf, canonicalDoiOf } from './paper-canonical-key.ts';
import { OWN_WORK_KEYS_MAX, PUBLICATION_SEEDS_MAX } from './publication-seed-limits.ts';

/**
 * For you learns from the reader's own publications once ORCID is connected
 * (ENG-251). The newest of them are examples the feed ranks by, as likes are,
 * but weaker: they only fill the room the reader's own examples leave, fewer
 * of them the more the reader has shown the app (publicationSeedAllowance),
 * and they never name a reason on a card. The reader's works themselves never
 * appear in For you (isOwnWork).
 *
 * The account keeps them in users/{uid}/orcid/works, next to the decisions
 * about its works (src/services/orcid-feed-seeds-service.ts), so they go with
 * the ORCID connection: the Worker deletes that document when ORCID is
 * disconnected or connected again, and with the account.
 */

export { OWN_WORK_KEYS_MAX, PUBLICATION_SEEDS_MAX };
/** The reader's own examples after which the publications no longer rank: the plan's whole room. */
export const PUBLICATION_SEEDS_FADE_EXAMPLES = 24;
/** How long the kept publications stand before the feed reads the reader's works again. */
export const PUBLICATION_SEEDS_STALE_MS = 30 * 24 * 60 * 60 * 1000;

const OPENALEX_WORK = /^(?:openalex:|https?:\/\/openalex\.org\/)?(W\d+)$/i;
// The ids the Worker can look up when its corpus lacks the paper (paperIdLookup in worker/paper-sources.ts).
const LOOKUP_ID = /^(?:openalex:W\d+|pmid:\d{1,12}|\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/\d{7}(?:v\d+)?)$/i;
const LOOKUP_DOI = /^(?:doi:)?(10\.\d{4,9}\/\S+)$/i;

/** Whether the Worker can look the paper named `id` up: the forms paperIdLookup reads, a DOI within the relay's path limit. */
export function workerCanLookUp(id: string) {
  if (LOOKUP_ID.test(id)) return true;
  const doi = LOOKUP_DOI.exec(id)?.[1];
  return Boolean(doi && doiPathId(doi));
}

function openAlexWorkKey(id: unknown) {
  const match = typeof id === 'string' ? OPENALEX_WORK.exec(id.trim()) : null;
  return match ? `openalex:${match[1].toUpperCase()}` : null;
}

/**
 * The names a paper is matched by against the reader's works: its DOI, its
 * arXiv id (from `arxivId`, or an id that is one) and its OpenAlex work id,
 * each spelled one way whatever provider the paper came from.
 */
export function paperMatchKeys(paper: Pick<Partial<Paper>, 'id' | 'doi' | 'arxivId'>) {
  const doi = canonicalDoiOf(paper);
  const arxiv = canonicalArxivIdOf(paper) ?? canonicalArxivIdOf(paper.id);
  const openAlex = openAlexWorkKey(paper.id);
  return [doi && `doi:${doi}`, arxiv && `arxiv:${arxiv}`, openAlex].filter((key): key is string => Boolean(key));
}

/** Whether `paper` is one of the reader's works, by the names the account keeps (`ownKeys`). */
export function isOwnWork(paper: Pick<Partial<Paper>, 'id' | 'doi' | 'arxivId'>, ownKeys: ReadonlySet<string>) {
  return ownKeys.size > 0 && paperMatchKeys(paper).some(key => ownKeys.has(key));
}

/**
 * The category a publication ranks under: the one leaf its main OpenAlex
 * topic maps to, else that topic's area, else the paper's own primary
 * category. '' when none is known: such an example ranks no group of its own.
 */
export function publicationCategory(paper: Pick<Partial<Paper>, 'primaryTopic' | 'topics' | 'primaryCategory'>) {
  for (const topic of [paper.primaryTopic, ...(paper.topics ?? [])]) {
    if (!topic) continue;
    const leaves = leavesForOpenAlexTopic(topic, true);
    if (leaves.length === 1) return leaves[0];
    const area = areaKeyForOpenAlexTopic(topic);
    if (area) return area;
  }
  const primary = typeof paper.primaryCategory === 'string' ? paper.primaryCategory.trim() : '';
  return areaKeyForCategory(primary) ? primary : '';
}

/**
 * The publications the feed ranks by and the names of every work it leaves
 * out, from the reader's papers newest first (readerPapers in
 * orcid-service.ts) and the names of their works OpenAlex has no paper for
 * (`unmatchedKeys`), which ORCID still lists. A publication needs an id the
 * Worker can look up.
 */
export function feedSeedsFrom(papers: ReadonlyArray<Partial<Paper>>, unmatchedKeys: ReadonlyArray<string> = []) {
  const seeds: PositiveExample[] = [];
  const keys = new Set<string>();
  const addKeys = (names: string[]) => {
    const fresh = names.filter(key => !keys.has(key));
    if (keys.size + fresh.length <= OWN_WORK_KEYS_MAX) fresh.forEach(key => keys.add(key));
  };
  for (const paper of papers) {
    const id = typeof paper.id === 'string' ? paper.id.trim() : '';
    addKeys(paperMatchKeys(paper));
    if (seeds.length < PUBLICATION_SEEDS_MAX && workerCanLookUp(id) && !seeds.some(seed => seed.id === id)) {
      seeds.push({ id, category: publicationCategory(paper) });
    }
  }
  for (const key of unmatchedKeys) addKeys([key]);
  return { seeds, keys: [...keys] };
}

/**
 * How many publications a plan ranks by: all of them before the reader's
 * first example, none once their examples fill the plan's room.
 */
export function publicationSeedAllowance(ownExamples: number, max = PUBLICATION_SEEDS_MAX) {
  const shown = Math.min(1, Math.max(0, ownExamples) / PUBLICATION_SEEDS_FADE_EXAMPLES);
  return Math.max(0, Math.round(max * (1 - shown)));
}

/** Whether two sets of kept publications and names are the same, so nothing needs writing. */
export function sameFeedSeeds(
  a: { seeds: PositiveExample[]; keys: string[] },
  b: { seeds: PositiveExample[]; keys: string[] },
) {
  return a.seeds.length === b.seeds.length
    && a.seeds.every((seed, index) => seed.id === b.seeds[index].id && seed.category === b.seeds[index].category)
    && a.keys.length === b.keys.length
    && a.keys.every((key, index) => key === b.keys[index]);
}

/** Whether publications kept at `keptAt` (ms, null when never) should be read again. */
export function feedSeedsStale(keptAt: number | null, now = Date.now()) {
  return keptAt === null || !Number.isFinite(keptAt) || now - keptAt > PUBLICATION_SEEDS_STALE_MS || keptAt > now + 60_000;
}
