import type { Paper } from '../models/paper.ts';

import { readArxivId, storedClassification } from '../models/paper.ts';
import { copyHoldsField } from '../utils/list-paper-copies.ts';
import { savedAnswered, fieldAnswered } from '../utils/profile-session-caches.ts';
import { getOpenAlexEnrichmentId } from '../utils/feed-enrichment.ts';
import { arxivKey, readArxivPapers } from './liked-paper-records.ts';

// Reached lazily, so a unit test of this module never loads the OpenAlex client.
const readOpenAlexWorks = async (ids: string[]): Promise<Record<string, Pick<Paper, 'primaryTopic'>>> => {
  const { enrichPapersBatch } = await import('./open-alex-service.ts');
  return enrichPapersBatch(ids);
};

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

/** A settled stored copy still needs a provider when it holds no classification. */
function listPaperNeedsFieldRecovery(uid: string, paperId: string, paper: Partial<Paper> | undefined) {
  return savedAnswered(uid, paperId) && !fieldAnswered(uid, paperId)
    && Boolean(paper && !copyHoldsField(paper) && fieldRequestFor(paperId, paper));
}

/** Keep each round bounded; the caller carries attempts across rounds of one opening. */
export function nextListFieldRound(uid: string, papers: Record<string, Partial<Paper>>, attempted: ReadonlySet<string>) {
  return Object.fromEntries(Object.entries(papers)
    .filter(([id, paper]) => !attempted.has(id) && listPaperNeedsFieldRecovery(uid, id, paper))
    .slice(0, 60));
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
 * `failed` lists the papers of an arXiv request that did not answer, so the
 * caller can ask again. OpenAlex's client reports a failed request as an
 * empty answer, so a paper it did not name may be one it could not be asked.
 */
export async function readPaperFields(
  papers: Record<string, Partial<Paper>>,
  { fetchArxivPapers = readArxivPapers, fetchOpenAlexWorks = readOpenAlexWorks } = {},
) {
  const fields: Record<string, PaperField> = {};
  const failed: string[] = [];
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
    } catch {
      failed.push(...batch.flatMap(id => papersAsked('arxiv', arxivKey(id))));
    }
  }

  if (asked.openalex.size > 0) {
    const works = await fetchOpenAlexWorks([...asked.openalex.keys()]);
    asked.openalex.forEach((paperIds, id) => {
      const { primaryTopic } = storedClassification({ primaryTopic: works[id]?.primaryTopic });
      if (primaryTopic) paperIds.forEach((paperId) => { fields[paperId] = { primaryTopic }; });
    });
  }

  return { fields, failed };
}
