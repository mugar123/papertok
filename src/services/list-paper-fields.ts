import type { Paper } from '../models/paper.ts';

import { readArxivId, storedClassification } from '../models/paper.ts';
import { copyHoldsField } from '../utils/list-paper-copies.ts';
import { fieldAnswered } from '../utils/profile-session-caches.ts';
import { getOpenAlexEnrichmentId } from '../utils/feed-enrichment.ts';
import { arxivKey, readArxivPapers } from './liked-paper-records.ts';

/** OpenAlex's answer for some ids, and the requests that got none. */
type OpenAlexWorksAnswer = {
  works: Record<string, Pick<Paper, 'primaryTopic'>>;
  failures: { ids: string[]; error: unknown }[];
};

// Reached lazily, so a unit test of this module never loads the OpenAlex client.
const readOpenAlexWorks = async (ids: string[]): Promise<OpenAlexWorksAnswer> => {
  const { enrichPapersBatch } = await import('./open-alex-service.ts');
  const failures: OpenAlexWorksAnswer['failures'] = [];
  const works = await enrichPapersBatch(ids, { onRequestFailed: (failedIds, error) => { failures.push({ ids: failedIds, error }); } });
  return { works, failures };
};

// The wait a failure asked for: a 429's retry-after, or what is left of the
// arXiv lane's cooldown.
function retryAfterOf(error: unknown) {
  const wait = (error as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? wait : null;
}

/** The field a provider gives a paper: arXiv's categories, or OpenAlex's topic. */
export type PaperField = Partial<ReturnType<typeof storedClassification>>;

// arXiv answers at most this many ids in one request (`fetchPapersByIds`).
const ARXIV_BATCH = 50;

/**
 * The provider that can name a list paper's field, and the id to ask it by:
 * arXiv for a paper with an arXiv id, OpenAlex for another with a work id or
 * a publisher's DOI. Null for a paper with none of them.
 */
export function fieldRequestFor(paperId: string, paper: Partial<Paper>) {
  const arxivId = (readArxivId(paper.arxivId) || readArxivId(paperId)).replace(/v\d+$/i, '');
  if (arxivId) return { provider: 'arxiv' as const, id: arxivId };
  // A paper stored under its DOI may keep it nowhere else.
  const openAlexId = getOpenAlexEnrichmentId({ ...paper, id: paperId, doi: paper.doi || paperId.replace(/^doi:/i, '') });
  return /^(?:openalex|doi):/.test(openAlexId) ? { provider: 'openalex' as const, id: openAlexId } : null;
}

// Requests one paper may cost in one opening of its list. arXiv is free and
// its lane refuses locally during a cooldown: the first and two retries.
// OpenAlex bills each call, and its client does not repeat a refused or
// timed-out one (`open-alex-client.ts`), so the list does not either.
const REQUESTS_PER_OPENING = { arxiv: 3, openalex: 1 } as const;
// Papers asked in one round; rounds run one at a time.
const ROUND_SIZE = 60;
// The waits after a failure that did not say how long: about 5 s after a
// paper's first request, outlasting the arXiv lane's default 4 s cooldown,
// and about 10 s after any later one.
const RETRY_BACKOFF_MS = [5_000, 10_000];
// The longest the list keeps a row waiting for one retry. A failure that asks
// for longer is left for the next opening rather than retried early.
const MAX_RETRY_WAIT_MS = 60_000;

/** Requests a paper may cost in one opening; zero when no provider can be asked. */
function requestsAllowed(paperId: string, paper: Partial<Paper>) {
  const request = fieldRequestFor(paperId, paper);
  return request ? REQUESTS_PER_OPENING[request.provider] : 0;
}

/**
 * The papers of the open list still waiting for a field in this opening, in
 * list order and not capped: the saved-document read has answered
 * (`savedAnswers`, including confirmed absence), no provider has answered
 * this session, the copy holds no field, a provider can be asked, and the
 * paper has requests left. `attempts` counts the requests of this opening.
 */
export function listPapersAwaitingField(
  uid: string,
  papers: Record<string, Partial<Paper>>,
  { savedAnswers, attempts }: { savedAnswers: ReadonlySet<string> | undefined; attempts: ReadonlyMap<string, number> },
) {
  return Object.fromEntries(Object.entries(papers).filter(([id, paper]) => (
    Boolean(savedAnswers?.has(id)) && !fieldAnswered(uid, id) && !copyHoldsField(paper)
    && (attempts.get(id) ?? 0) < requestsAllowed(id, paper)
  )));
}

/** The next round: the first papers still waiting, at most sixty. */
export function nextListFieldRound(awaiting: Record<string, Partial<Paper>>) {
  return Object.fromEntries(Object.entries(awaiting).slice(0, ROUND_SIZE));
}

/** The wait after a failed round: its `retry-after`, or a backoff by the requests made. */
function retryDelayMs(attempt: number, retryAfterMs: number | null) {
  const backoff = RETRY_BACKOFF_MS[Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1];
  return Math.min(retryAfterMs ?? backoff, MAX_RETRY_WAIT_MS);
}

/**
 * Counts one request for each paper of a round and says what its answer
 * settled. A paper with a field is answered even if it is also among the
 * failures, which happens when one work is saved under two ids.
 *
 * `waitMs` holds the next round after any failure, whatever that round asks,
 * so the next papers are not sent into the same refusal; zero when nothing
 * failed. A failure whose `retry-after` is longer than the list waits spends
 * its papers' requests: asking sooner would only be refused again.
 */
export function settleFieldRound(
  attempts: ReadonlyMap<string, number>,
  round: Record<string, Partial<Paper>>,
  { fields, failed, retryAfterMs }: { fields: Record<string, PaperField>; failed: string[]; retryAfterMs: number | null },
) {
  const askedIds = Object.keys(round);
  const unanswered = askedIds.filter(paperId => failed.includes(paperId) && !(paperId in fields));
  const next = new Map(attempts);
  askedIds.forEach((paperId) => { next.set(paperId, (next.get(paperId) ?? 0) + 1); });
  if (retryAfterMs !== null && retryAfterMs > MAX_RETRY_WAIT_MS) {
    unanswered.forEach((paperId) => { next.set(paperId, requestsAllowed(paperId, round[paperId])); });
  }
  return {
    answered: askedIds.filter(paperId => !unanswered.includes(paperId)),
    attempts: next,
    waitMs: unanswered.length > 0
      ? retryDelayMs(Math.max(...unanswered.map(paperId => attempts.get(paperId) ?? 0)) + 1, retryAfterMs)
      : 0,
  };
}

/**
 * The field of papers the lists hold with none, keyed by the id the list
 * stores them under.
 *
 * A `savedPapers` document written before 2026-10-21 (PAP-60) kept the one
 * category its card showed, which was often the category the feed had asked
 * for, so it is not read as the paper's field and the row had no field's ink.
 * A paper the provider does not name stays without a field.
 *
 * `failed` lists the papers whose request did not answer, from arXiv or
 * OpenAlex, so the caller can ask again; a paper a provider answered without
 * naming is not among them. `retryAfterMs` is the longest wait any of those
 * failures asked for, or null when none said.
 */
export async function readPaperFields(
  papers: Record<string, Partial<Paper>>,
  { fetchArxivPapers = readArxivPapers, fetchOpenAlexWorks = readOpenAlexWorks } = {},
) {
  const fields: Record<string, PaperField> = {};
  const failed: string[] = [];
  const waits: number[] = [];
  const fail = (paperIds: string[], error: unknown) => {
    failed.push(...paperIds);
    const wait = retryAfterOf(error);
    if (wait !== null) waits.push(wait);
  };
  // The papers asked by each id; an arXiv id is matched without its case.
  const asked = { arxiv: new Map<string, string[]>(), openalex: new Map<string, string[]>() };
  const arxivIds: string[] = [];
  Object.entries(papers).forEach(([paperId, paper]) => {
    const request = fieldRequestFor(paperId, paper);
    if (!request) return;
    const key = request.provider === 'arxiv' ? arxivKey(request.id) : request.id;
    if (request.provider === 'arxiv' && !asked.arxiv.has(key)) arxivIds.push(request.id);
    asked[request.provider].set(key, [...(asked[request.provider].get(key) ?? []), paperId]);
  });
  const papersAsked = (provider: keyof typeof asked, key: string) => asked[provider].get(key) ?? [];

  for (let start = 0; start < arxivIds.length; start += ARXIV_BATCH) {
    const batch = arxivIds.slice(start, start + ARXIV_BATCH);
    try {
      (await fetchArxivPapers(batch)).forEach((paper) => {
        const field = storedClassification(paper);
        if (!copyHoldsField(field)) return;
        new Set([paper.arxivId, paper.id].map(arxivKey)).forEach((key) => {
          papersAsked('arxiv', key).forEach((paperId) => { fields[paperId] = field; });
        });
      });
    } catch (error) {
      fail(batch.flatMap(id => papersAsked('arxiv', arxivKey(id))), error);
    }
  }

  if (asked.openalex.size > 0) {
    const ids = [...asked.openalex.keys()];
    let answer: OpenAlexWorksAnswer;
    try {
      answer = await fetchOpenAlexWorks(ids);
    } catch (error) {
      answer = { works: {}, failures: [{ ids, error }] };
    }
    answer.failures.forEach(({ ids: failedIds, error }) => fail(failedIds.flatMap(id => papersAsked('openalex', id)), error));
    asked.openalex.forEach((paperIds, id) => {
      const { primaryTopic } = storedClassification({ primaryTopic: answer.works[id]?.primaryTopic });
      if (primaryTopic) paperIds.forEach((paperId) => { fields[paperId] = { primaryTopic }; });
    });
  }

  return { fields, failed, retryAfterMs: waits.length > 0 ? Math.max(...waits) : null };
}
