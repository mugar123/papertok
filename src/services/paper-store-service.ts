import type { Paper } from '../models/paper.ts';
import type { FollowEntity } from '../utils/following.ts';
import type { InterestGroup } from '../utils/interest-memory.ts';

import { authenticatedWorkerFetch, sourceResponseError, workerSourceUrl } from './worker-api-client.ts';
import { SEMANTIC_PROFILE_POSITIVE_CAP } from '../utils/feed-interactions.ts';
import { feedSeenFilter } from '../utils/seen-paper-filter.ts';
import { servedFollows } from '../utils/follow-lanes.ts';

// Counted from the moment the ID token is in hand (authenticatedWorkerFetch),
// so a token refresh does not spend it. The exploration and follows requests
// also have render budgets, counted from the start of the load
// (awaitScreenSources in src/context/feed-corpus-requests.ts), and give no
// papers when those run out.
const STORE_TIMEOUT_MS = 3_500;
// The requests of a list's first screen (`firstScreen`). After the 2026-10-28
// fixes every feed failure was that page timing out at 3.5 s, mostly on a
// session's first load; in most sessions the automatic retry, 2.5 s later,
// showed papers 7-9 s after the feed opened. A token the Worker has not
// verified in the last minute waits up to 4 s for Google
// (worker/firebase-auth.ts) before the D1 reads and ranking, and the Worker's
// hourly p90 wall time, all routes, reached 3.6 s. A first screen that times
// out here, while the session's one automatic retry is unused, retries once, at
// once and with STORE_TIMEOUT_MS, then shows its error; one that fails for
// another reason retries after a pause with this deadline again (automaticRetry
// in src/context/feed-load-failure.ts, ENG-116). The retry is armed again only
// by a load that succeeds: Try again after an error waits this deadline once
// and then shows the error, about 10 s after the token.
const FIRST_SCREEN_TIMEOUT_MS = 10_000;

/** A requested follow whose lane has not finished its first harvest, as the request named it. */
export interface LoadingFollow { type: string; canonicalId: string }

export interface CorpusPageRequest {
  categories?: string[];
  /** Whole areas of the app's taxonomy, each served as its own lane. */
  areas?: string[];
  /**
   * Serve exactly the lanes named, with the reader's liked and rejected papers
   * left on the page: a custom feed. Its answer says which follows are still
   * loading. A request that names nothing servable is refused (LANES_REQUIRED).
   */
  exact?: boolean;
  /**
   * The reader's interest groups (planInterestGroups), each ranked by its own
   * examples. With them, `categories` is their union and `positiveIds` names
   * only the examples of no group.
   */
  groups?: InterestGroup[];
  follows?: FollowEntity[];
  positiveIds?: string[];
  /** Local evidence for the reason on a For You card. Only the IDs travel to the Worker. */
  exampleKindsById?: ReadonlyMap<string, NonNullable<Paper['_semanticExampleKinds']>>;
  negativeIds?: string[];
  excludedIds?: string[];
  page: number;
  pageSize: number;
  /** `recent` unless named; a custom feed asks for `daily` or `relevance` (corpusRequestOf). */
  order?: string;
  // The papers the reader has seen (`feedSeenIds`), sent with `skipsSeen`: a
  // Worker that skips them answers with the next papers of the reader's
  // ranking they have not seen, whatever `page` says, and says `skipsSeen`
  // too. With it, how many notable papers of its categories the page may add
  // after its own: only unseen ones, for the app to place (placeNotableCards).
  seen?: Iterable<string>;
  notable?: number;
  // With `seen`, a first page goes on with the walk of the order the Worker
  // kept for the same request (continuesWalk in src/context/feed-pagination.ts).
  continues?: boolean;
  // With `seen`, the run a page belongs to (RecentRun's `walk`): a Worker that
  // reads it keeps a walk of the daily order for each run. Others ignore it.
  walk?: string;
  /**
   * Rank by the likes only once the corpus has fetched and embedded the ones
   * it lacks, which can take seconds: for More like this, never a feed page.
   */
  waitForLikes?: boolean;
  /**
   * A request of a load that fills a list with no cards shown, which the
   * reader waits for (waitsAsFirstScreen in src/context/feed-corpus-requests.ts): it may take
   * FIRST_SCREEN_TIMEOUT_MS instead of STORE_TIMEOUT_MS. Not sent.
   */
  firstScreen?: boolean;
}

interface StoreOptions {
  onVersion?: (version: string | null) => void;
  fetchWorker?: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
  apiBase?: string;
}

// fetch, and reading its body, reject with a TypeError when the connection
// fails. Marked where the transfer fails, so a TypeError from code is not taken for it.
function markUnreachable(error: unknown): never {
  if (error instanceof TypeError) throw Object.assign(new Error('The paper store could not be reached', { cause: error }), { code: 'STORE_UNREACHABLE' });
  throw error;
}

async function askStore(body: unknown, { fetchWorker = authenticatedWorkerFetch, apiBase, onVersion }: StoreOptions, timeoutMs = STORE_TIMEOUT_MS) {
  const response = await fetchWorker(workerSourceUrl('/store/papers', {}, apiBase), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs).catch(markUnreachable);
  onVersion?.(response.headers.get('x-papertok-worker-version'));
  if (!response.ok) {
    // The Worker's `code` says why it refused (worker/router.ts); a body that
    // is not JSON, such as a gateway's page, leaves the status alone.
    const refusal = await response.json().catch(() => null) as { code?: unknown } | null;
    throw sourceResponseError('/store/papers', response.status, refusal);
  }
  const answer = await response.json().catch(markUnreachable) as { papers?: Paper[]; skipsSeen?: unknown; loading?: unknown; more?: unknown; seedsScored?: unknown } | null;
  // The Worker always answers a list, empty when nothing matches.
  const papers = answer?.papers;
  if (!Array.isArray(papers)) throw Object.assign(new Error('/store/papers answered without a papers list'), { code: 'STORE_RESPONSE_INVALID' });
  const more = typeof answer?.more === 'boolean' ? answer.more : undefined;
  // Even a pre-versioning corpus response owns its conference field. A later
  // versioned snapshot can supersede it after either library copy is reloaded.
  const snapshots = papers.map(paper => paper.corpusUpdatedAt === undefined ? { ...paper, corpusUpdatedAt: 0 } : paper);
  return { papers: snapshots, skipsSeen: answer?.skipsSeen === true, loading: loadingFollowsOf(answer?.loading), more, seedsScored: answer?.seedsScored === true };
}

/** The follows an exact answer says are still loading; a Worker that does not say any answers none. */
function loadingFollowsOf(value: unknown): LoadingFollow[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    const { type, canonicalId } = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return typeof type === 'string' && typeof canonicalId === 'string' ? [{ type, canonicalId }] : [];
  });
}

/**
 * The groups' examples, then the ones of no group, as one request ranks by
 * them: what a Worker that reads no groups ranks by.
 */
/**
 * Every example of a grouped request, each once. With `isExample`, the
 * reader's own examples come before the rest (their publications, ENG-251),
 * so the Worker's lookup of examples it lacks, which reads the first ten,
 * reaches a like before a publication.
 */
export function corpusPositiveIds(groups: InterestGroup[], positiveIds: string[], isExample?: (id: string) => boolean) {
  const ids = [...new Set([...groups.flatMap(group => group.positiveIds), ...positiveIds])];
  const ordered = isExample ? [...ids.filter(isExample), ...ids.filter(id => !isExample(id))] : ids;
  return ordered.slice(0, SEMANTIC_PROFILE_POSITIVE_CAP);
}

// The copy a request too long drops first: the oldest example the group
// holding the most shares with another group, which keeps it; none when no
// two groups share one.
function sharedCopy(groups: Array<{ positiveIds: string[] }>) {
  const holders = new Map<string, number>();
  for (const group of groups) for (const id of new Set(group.positiveIds)) holders.set(id, (holders.get(id) ?? 0) + 1);
  const shared = (id: string) => holders.get(id)! > 1;
  const holding = groups.filter(group => group.positiveIds.some(shared));
  if (holding.length === 0) return null;
  const group = holding.reduce((most, next) => (next.positiveIds.length > most.positiveIds.length ? next : most));
  return { group, id: group.positiveIds.findLast(shared)! };
}

/**
 * A follow's string as the Worker reads it (`text` in src/utils/follow-lanes.ts:
 * whitespace collapsed, trimmed), cut to `max`. The Worker then cuts a query to
 * 120 characters and a funder to 80 after trimming, so those are sent one
 * character longer: a cut ending in a space would be trimmed and file the
 * follow under another lane. Anything but a string passes as stored.
 */
function cutFollowText<T>(value: T, max: number): T {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) as T : value;
}

/**
 * A page of the paper corpus (worker/paper-store.ts): every source the feed
 * reads, harvested, merged and enriched once a day in the Worker, here ranked
 * by the reader's examples (likes, saves and long reads) per interest group.
 * Categories are the app's; the follows the Worker reads are sent as they are
 * stored, and the Worker decides how each is served.
 * Each paper says which asked categories (`_fetchedFor`) and follows
 * (`_followedEntityMatches`) it was found under, and a notable one `_notable`.
 * `skipsSeen` says the Worker passed over the papers in `seen`; Workers
 * before it page by number. A request asks for it explicitly, so a Worker
 * that skips seen papers pages by number for bundles that send `seen` only
 * for notable papers.
 * An `exact` request's answer says which of its follows are still `loading`,
 * a Worker that does not say, none; and whether the Worker's ranking holds
 * papers after this page (`more`), left unset unless the Worker sends a boolean.
 */
export function fetchCorpusPage(request: CorpusPageRequest & { exact: true }, options?: StoreOptions): Promise<{ papers: Paper[]; skipsSeen: boolean; loading: LoadingFollow[]; more?: boolean }>;
export function fetchCorpusPage(request: CorpusPageRequest, options?: StoreOptions): Promise<{ papers: Paper[]; skipsSeen: boolean }>;
export function fetchCorpusPage({ categories = [], areas = [], exact = false, groups, follows = [], positiveIds = [], exampleKindsById, negativeIds = [], excludedIds = [], page, pageSize, order = 'recent', seen, notable = 0, continues = false, walk, waitForLikes = false, firstScreen = false }: CorpusPageRequest, options: StoreOptions = {}) {
  const read = servedFollows(follows).map(({ follow }) => follow);
  // The reader's own examples have a kind; their publications (ENG-251) have none.
  const isExample = exampleKindsById && ((id: string) => exampleKindsById.has(id));
  const body = {
    categories: groups ? [...new Set(groups.flatMap(group => group.categories))] : categories,
    ...(areas.length ? { areas } : {}),
    ...(exact ? { exact } : {}),
    // Only the follows the Worker reads travel (`servedFollows`): the first
    // MAX_FOLLOWED_JOURNALS journals and FEED_MAX_FOLLOWS other follows with a
    // lane. The app requests a followed leaf by category alone. When no
    // follow has a lane, the first still travels, so the request stays the follows'
    // page: the Worker reads no area lane for it, and answers it with no
    // papers when it has no categories either (`handleCorpusFeed`).
    // A string is cut as the Worker reads it (`cutFollowText`), so the lane it
    // files the follow under is the one the uncut follow has.
    follows: (read.length ? read : follows.slice(0, 1)).map(({ type, canonicalId, displayName, metadata }) => ({
      type,
      canonicalId,
      displayName: cutFollowText(displayName, 200),
      metadata: { query: cutFollowText(metadata?.query, 121), funder: cutFollowText(metadata?.funder, 81) },
    })),
    positiveIds: groups ? corpusPositiveIds(groups, positiveIds, isExample) : positiveIds,
    // Copies: the examples below may be trimmed, and the plan is the feed's.
    ...(groups ? { groups: groups.map(group => ({ ...group, positiveIds: [...group.positiveIds] })) } : {}),
    ...(negativeIds.length ? { negativeIds: negativeIds.slice(0, 24) } : {}),
    excludedIds: [...new Set(excludedIds)].slice(0, 200),
    page,
    pageSize,
    order,
    ...(seen ? { seen: feedSeenFilter(seen), skipsSeen: true, ...(notable > 0 ? { notable } : {}), ...(continues ? { continues } : {}), ...(walk ? { walk } : {}) } : {}),
    ...(waitForLikes ? { waitForLikes } : {}),
  };
  while (body.excludedIds.length && new TextEncoder().encode(JSON.stringify(body.excludedIds)).byteLength > 6_000) body.excludedIds.pop();
  // Trim new signals before they can push the existing request over 16 KiB.
  // First the copies of an example several groups hold, while one group keeps
  // it (`sharedCopy`): every established group holds the likes of the areas
  // the reader never picked (planInterestGroups), so with ten areas and long
  // ids their copies alone would leave no room for rejections or exclusions.
  // Then rejections, so the exclusion snapshot stays stable as they change.
  // A grouped request carries each example twice, so with long ids it can
  // still be over. Then examples go: first those of no group, then the oldest
  // of the group holding the most, so each group keeps its newest longest.
  // An example leaves the flat list and every group together, so both rank by
  // the same ones.
  // `page`, and with `seen` also `notable` and `continues`, can change
  // between the pages reading one kept order, so they count at their longest:
  // pages that differ only in them trim the same signals, and a later page,
  // or a first page that `continues`, is served from the order the first one
  // kept instead of ranking again. A page whose fields are a few bytes longer
  // would otherwise drop one more signal than the first. A custom feed's
  // refresh walks with `seen` and, once none is left unseen, asks by number
  // without it (ENG-197); the two keep their orders under different keys, so
  // they may trim different signals.
  const pageFields = { page: Number.MAX_SAFE_INTEGER, ...(seen ? { notable: 99, continues: true } : {}) };
  while (new TextEncoder().encode(JSON.stringify({ ...body, ...pageFields })).byteLength > 16_000) {
    const copy = body.groups ? sharedCopy(body.groups) : null;
    if (copy) copy.group.positiveIds = copy.group.positiveIds.filter(id => id !== copy.id);
    else if (body.negativeIds?.length) body.negativeIds.pop();
    else if (body.excludedIds.length) body.excludedIds.pop();
    else if (body.groups && body.positiveIds.length) {
      const grouped = new Set(body.groups.flatMap(group => group.positiveIds));
      const largest = body.groups.reduce((most, group) => (group.positiveIds.length > most.positiveIds.length ? group : most));
      // A publication goes before any of the reader's own examples.
      const dropped = (isExample && body.positiveIds.findLast(id => !isExample(id)))
        || (body.positiveIds.findLast(id => !grouped.has(id)) ?? largest.positiveIds.at(-1));
      body.positiveIds = body.positiveIds.filter(id => id !== dropped);
      for (const group of body.groups) group.positiveIds = group.positiveIds.filter(id => id !== dropped);
    } else if (body.follows.length > 1) {
      // Last, so a reader's examples and exclusions are kept first: the follows
      // are in the order the Worker serves them, other follows after the
      // journals, and the last goes (ENG-182). The first stays: it keeps the
      // request the follows' page.
      body.follows.pop();
    } else break;
  }
  // Which examples are the reader's publications (ENG-251), so the Worker
  // says which papers one of them scored best: added after the trimming, so
  // they take nothing from the ranking inputs' 16,000 bytes. At most 10 ids
  // the Worker can look up (about 2.6 KB) fit in the room the Worker leaves
  // above that (MAX_BODY_BYTES in worker/paper-feed.ts).
  const seedIds = isExample ? body.positiveIds.filter(id => !isExample(id)) : [];
  const answer = askStore({ ...body, ...(body.excludedIds.length ? {} : { excludedIds: undefined }), ...(seedIds.length ? { seedIds } : {}) }, options, firstScreen ? FIRST_SCREEN_TIMEOUT_MS : STORE_TIMEOUT_MS);
  if (exact) return answer;
  // The size limit may have removed examples from the plan. Keep only the
  // kinds actually sent with this page, alongside its semantic scores.
  // The Worker's walkNamed fallback can return a kept rank scored against
  // earlier examples. Only the Worker can identify which examples scored it.
  // A page ranked by the reader's publications too (ENG-251) names the
  // examples only on the papers the Worker scored closest to one of the
  // reader's own (`_semanticFromSeed` unset). A Worker that does not say
  // (`seedsScored`) leaves every paper of such a page without them: a paper
  // close to a publication alone would otherwise read as similar to a like.
  const kinds = exampleKindsById && [...new Set(body.positiveIds.flatMap(id => exampleKindsById.get(id) ?? []))];
  const ranksBySeeds = seedIds.length > 0;
  return answer.then(({ papers, skipsSeen, seedsScored }) => {
    if (kinds?.length && (!ranksBySeeds || seedsScored)) {
      for (const paper of papers) if (!paper._semanticFromSeed) paper._semanticExampleKinds = kinds;
    }
    return { papers, skipsSeen };
  });
}

/**
 * The corpus's copies of these papers, by the ids the app holds for them,
 * with what the corpus's enrichment added. A paper the corpus lacks is fetched
 * into it when its id names a source it can ask; otherwise it is left out.
 */
export async function fetchCorpusPapers(ids: string[], options: StoreOptions = {}) {
  return (await askStore({ ids }, options)).papers;
}
