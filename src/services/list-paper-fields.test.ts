import test from 'node:test';
import assert from 'node:assert/strict';
import type { Paper } from '../models/paper.ts';
import { paperLegacyAdapter } from '../models/paper.ts';
import { areaLabelForPaper } from '../utils/area-accent.ts';
import type { PaperField } from './list-paper-fields.ts';
import { fieldRequestFor, readPaperFields } from './list-paper-fields.ts';
import { forgetListPapers, rememberFieldAnswers } from '../utils/profile-session-caches.ts';

// The lists ask a provider the field of saved papers stored with none (`readPaperFields`).

const arxivPaper = (id: string, categories: string[]) => ({ id, arxivId: id, title: 'From arXiv', primaryCategory: categories[0], categories }) as Paper;
const topic = { id: 'https://openalex.org/T10020', display_name: 'Quantum Information', field: { id: 'https://openalex.org/fields/31', display_name: 'Physics and Astronomy' } };
// The row's paper after the answer, as the list reads a stored copy.
const areaWith = (paperId: string, stored: Partial<Paper>, field: Partial<Paper> | undefined) => areaLabelForPaper(paperLegacyAdapter({ id: paperId, title: 'Stored', ...stored, ...field }));

test('each paper is asked of the provider that can name its field, under the id the list holds', async () => {
  const arxivAsked: string[][] = [];
  const openAlexAsked: string[][] = [];
  const papers: Record<string, Partial<Paper>> = {
    '2505.06123': { primaryCategory: undefined },
    // Saved from an INSPIRE card: another provider's id, with the arXiv id beside it.
    'inspire:2920001': { arxivId: '2511.00001v2' },
    'ads:2025a': { doi: 'https://doi.org/10.1103/PhysRevB.42.892' },
    'ads:2025b': { doi: '10.5555/unknown' },
    'pmid:1': {},
  };
  const { fields, failed } = await readPaperFields(papers, {
    fetchArxivPapers: async (ids) => {
      arxivAsked.push(ids);
      return [arxivPaper('2505.06123', ['quant-ph', 'cond-mat.mes-hall']), arxivPaper('2511.00001', ['hep-th'])];
    },
    fetchOpenAlexWorks: async (ids) => {
      openAlexAsked.push(ids);
      return { works: { 'doi:10.1103/physrevb.42.892': { primaryTopic: topic } }, failures: [] };
    },
  });

  assert.deepEqual(arxivAsked, [['2505.06123', '2511.00001']], 'one arXiv request, without versions');
  assert.deepEqual(openAlexAsked, [['doi:10.1103/physrevb.42.892', 'doi:10.5555/unknown']], 'only the papers with no arXiv id');
  assert.deepEqual(failed, []);
  assert.deepEqual(Object.keys(fields).sort(), ['2505.06123', 'ads:2025a', 'inspire:2920001'], 'no field for a paper the provider does not know, or one with no id to ask by');
  assert.deepEqual(fields['2505.06123'].categories, ['quant-ph', 'cond-mat.mes-hall']);
  assert.equal(areaWith('2505.06123', { primaryCategory: 'physics.optics' }, undefined), null, 'the stored category alone is no field');
  assert.equal(areaWith('2505.06123', { primaryCategory: 'physics.optics' }, fields['2505.06123']), 'Physics');
  assert.equal(areaWith('inspire:2920001', { primaryCategory: 'physics' }, fields['inspire:2920001']), 'Physics');
  assert.deepEqual(fields['ads:2025a'], { primaryTopic: topic });
});

test('an arXiv request that fails leaves its papers askable and the others filled', async () => {
  const { fields, failed } = await readPaperFields({
    '2505.06123': {},
    'openalex:W4410000002': { doi: '10.1103/physrevb.42.892' },
  }, {
    fetchArxivPapers: async () => { throw new Error('arXiv is down'); },
    fetchOpenAlexWorks: async () => ({ works: { 'openalex:W4410000002': { primaryTopic: topic } }, failures: [] }),
  });
  assert.deepEqual(failed, ['2505.06123']);
  assert.deepEqual(Object.keys(fields), ['openalex:W4410000002']);
});

// The errors below are synthetic, shaped like the ones the routes throw: the
// tab's arXiv lane refusing during a cooldown, and the OpenAlex client
// relaying the Worker's budget refusal (`OpenAlexRequestError`).
const refusal = (message: string, retryAfterMs?: number) => Object.assign(new Error(message), { status: 429, retryAfterMs });

test('the papers of a failed OpenAlex request are left askable, not answered without a field', async () => {
  const result = await readPaperFields({
    'openalex:W4410000002': {},
    'ads:2025a': { doi: '10.1103/PhysRevB.42.892' },
    'ads:2025b': { doi: '10.5555/unknown' },
  }, {
    fetchOpenAlexWorks: async () => ({
      works: { 'openalex:W4410000002': { primaryTopic: topic } },
      failures: [{ ids: ['doi:10.1103/physrevb.42.892'], error: refusal('OpenAlex rate limit reached', 30_000) }],
    }),
  });
  assert.deepEqual(result.failed, ['ads:2025a']);
  assert.deepEqual(Object.keys(result.fields), ['openalex:W4410000002'], 'a DOI OpenAlex answered without naming is not failed');
  assert.equal(result.retryAfterMs, 30_000);
});

test('an OpenAlex client that throws fails its own papers and keeps the arXiv fields', async () => {
  const result = await readPaperFields({
    '2505.06123': {},
    'openalex:W4410000002': {},
  }, {
    fetchArxivPapers: async () => [arxivPaper('2505.06123', ['quant-ph'])],
    fetchOpenAlexWorks: async () => { throw new TypeError('Failed to fetch dynamically imported module'); },
  });
  assert.deepEqual(result.failed, ['openalex:W4410000002']);
  assert.deepEqual(result.fields['2505.06123']?.categories, ['quant-ph']);
  assert.equal(result.retryAfterMs, null, 'no failure said how long to wait');
});

test('the longest wait any failure asked for is the one reported', async () => {
  const papers = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`2505.${String(10000 + index)}`, {}]));
  let batch = 0;
  const result = await readPaperFields({ ...papers, 'openalex:W4410000002': {} }, {
    fetchArxivPapers: async () => {
      batch += 1;
      // The Worker's beat refuses the first request; the lane, cooling down, the second.
      throw batch === 1 ? refusal('PaperTok arXiv API error: 429', 4_000) : Object.assign(new Error('arXiv is rate limited; not asking again yet'), { code: 'RATE_LIMITED', retryAfterMs: 45_000 });
    },
    fetchOpenAlexWorks: async () => ({ works: {}, failures: [{ ids: ['openalex:W4410000002'], error: refusal('OpenAlex rate limit reached', 12_000) }] }),
  });
  assert.equal(result.failed.length, 52);
  assert.equal(result.retryAfterMs, 45_000);
});

test('each id is asked the way its provider reads it', () => {
  const request = (paperId: string, paper: Partial<Paper> = {}) => fieldRequestFor(paperId, paper);
  assert.deepEqual(request('arxiv:2505.06123v3'), { provider: 'arxiv', id: '2505.06123' });
  assert.deepEqual(request('math.GT/0309136'), { provider: 'arxiv', id: 'math.GT/0309136' }, 'an old-style id keeps its case');
  assert.deepEqual(request('openalex:W4410000002'), { provider: 'openalex', id: 'openalex:W4410000002' }, 'a work id needs no DOI');
  assert.deepEqual(request('ads:2025x', { doi: 'https://doi.org/10.1103/PhysRevB.42.892' }), { provider: 'openalex', id: 'doi:10.1103/physrevb.42.892' });
  // arXiv's own DOI names the arXiv paper again, and OpenAlex reads `,` as a separator.
  assert.equal(request('ads:2025y', { doi: '10.48550/arXiv.2505.06123' }), null);
  assert.equal(request('ads:2025z', { doi: '10.1000/a,10.1000/b' }), null);
  assert.deepEqual(request('doi:10.1103/PhysRevB.42.892'), { provider: 'openalex', id: 'doi:10.1103/physrevb.42.892' }, 'a paper stored under its DOI');
  assert.equal(request('pmid:1'), null);
});

test('arXiv is asked fifty papers at a time', async () => {
  const asked: number[] = [];
  const papers = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`2505.${String(10000 + index)}`, {}]));
  await readPaperFields(papers, { fetchArxivPapers: async (ids) => { asked.push(ids.length); return []; } });
  assert.deepEqual(asked, [50, 50, 20]);
});

test('an old list or favorite without a saved document recovers its field on a cold cache', async () => {
  const { listPapersAwaitingField, nextListFieldRound } = await import('./list-paper-fields.ts');
  const { savedAnswersOf } = await import('../utils/profile-session-caches.ts');
  const needsRecovery = (uid: string, id: string, paper: Partial<Paper>) => id in nextListFieldRound(listPapersAwaitingField(uid, { [id]: paper }, { savedAnswers: savedAnswersOf(uid), attempts: new Map() }));
  const { copyOfRecordWithoutCopy } = await import('../utils/reading-library.ts');
  const { forgetListPapers, rememberSavedAnswers, rememberListPapers, readListPapers } = await import('../utils/profile-session-caches.ts');
  const { getPaperFieldClassification } = await import('../utils/paper-topic-tags.ts');
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  const uid = 'missing-saved-document';
  const id = '2608.19175';
  const old = copyOfRecordWithoutCopy(id, { paperTitle: 'State--Generator Geometry of Open Quantum Systems', paperAuthors: ['Eric R. Bittner', 'Carlos Silva-Acuna'] });
  forgetListPapers(uid);
  rememberListPapers(uid, { [id]: old }, 'interaction', storage);
  assert.equal(needsRecovery(uid, id, old), false, 'wait for the saved-document read');
  // The server answered: there is no savedPapers document. A favorite can have only an interaction.
  rememberSavedAnswers(uid, [id]);
  assert.equal(needsRecovery(uid, id, old), true, 'a missing document must not block recovery');
  const answer = await readPaperFields({ [id]: old }, { fetchArxivPapers: async () => [arxivPaper(id, ['quant-ph'])] });
  rememberListPapers(uid, { [id]: { ...old, ...answer.fields[id] } }, 'saved', storage);
  const recovered = readListPapers(uid)![id];
  assert.equal(getPaperFieldClassification(recovered)?.label, 'Quantum Physics');
  assert.equal(needsRecovery(uid, id, recovered), false);
  forgetListPapers(uid);
  const afterReload = readListPapers(uid, storage)![id];
  assert.equal(getPaperFieldClassification(afterReload)?.label, 'Quantum Physics');
  assert.equal(needsRecovery(uid, id, afterReload), false);
  assert.deepEqual(readListPapers('another-reader', storage), {});
  forgetListPapers(uid);
});

test('a provider primary category is sufficient even with an empty category list', async () => {
  const result = await readPaperFields({ '2608.19175': {} }, {
    fetchArxivPapers: async () => [{ ...arxivPaper('2608.19175', []), primaryCategory: 'quant-ph' }],
  });
  assert.equal(result.fields['2608.19175']?.primaryCategory, 'quant-ph');
});

// The policy below is read from concrete openings; the counts are the
// requests a provider was sent, not the module's constants restated.
const papersNamed = (count: number, from = 0) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`2505.${String(10000 + from + i)}`, { title: 'Synthetic old favorite' }]));
type RoundAnswer = { fields: Record<string, PaperField>; failed: string[]; retryAfterMs: number | null };

/**
 * One opening of a list, round after round, as the lists screen runs it:
 * `respond` answers each round's ids. Returns each round's ids and the wait
 * before the next round, and the requests counted at the end.
 */
async function openOnce(uid: string, papers: Record<string, Partial<Paper>>, respond: (ids: string[]) => RoundAnswer, attempts: ReadonlyMap<string, number> = new Map()) {
  const { listPapersAwaitingField, nextListFieldRound, settleFieldRound } = await import('./list-paper-fields.ts');
  const savedAnswers = new Set(Object.keys(papers));
  const rounds: { asked: string[]; waitMs: number }[] = [];
  for (let round = 0; round < 20; round += 1) {
    const asked = nextListFieldRound(listPapersAwaitingField(uid, papers, { savedAnswers, attempts }));
    if (Object.keys(asked).length === 0) break;
    const settled = settleFieldRound(attempts, asked, respond(Object.keys(asked)));
    rememberFieldAnswers(uid, settled.answered);
    attempts = settled.attempts;
    rounds.push({ asked: Object.keys(asked), waitMs: settled.waitMs });
  }
  return { rounds, attempts, awaiting: listPapersAwaitingField(uid, papers, { savedAnswers, attempts }) };
}
const failing = (retryAfterMs: number | null = null) => (ids: string[]): RoundAnswer => ({ fields: {}, failed: ids, retryAfterMs });

test('a paper whose arXiv request failed is asked again in the same opening, three times at most', async () => {
  const uid = 'field-retry-three-requests';
  const papers = papersNamed(2);
  const [refused, answered] = Object.keys(papers);
  // arXiv refuses one paper every time and answers the other without a field.
  const opening = await openOnce(uid, papers, ids => ({ fields: {}, failed: ids.filter(id => id === refused), retryAfterMs: null }));
  assert.deepEqual(opening.rounds.map(round => round.asked), [[refused, answered], [refused], [refused]], 'the answered paper once, the refused one three times');
  assert.deepEqual(opening.awaiting, {}, 'a spent paper no longer waits in this opening');
  const next = await openOnce(uid, papers, failing());
  assert.deepEqual(next.rounds[0].asked, [refused], 'the next opening asks it again');
  forgetListPapers(uid);
});

test('a paper named in both the fields and the failures is answered', async () => {
  const { listPapersAwaitingField, settleFieldRound } = await import('./list-paper-fields.ts');
  const uid = 'field-wins-over-failure';
  // One work saved under its arXiv id and under an INSPIRE id with the same arXiv id.
  const papers = { '2505.06123': {}, 'inspire:2920001': { arxivId: '2505.06123' } };
  const savedAnswers = new Set(Object.keys(papers));
  const settled = settleFieldRound(new Map(), papers, {
    fields: { '2505.06123': { primaryCategory: 'quant-ph', categories: ['quant-ph'] } },
    failed: ['2505.06123', 'inspire:2920001'],
    retryAfterMs: 4_000,
  });
  assert.deepEqual(settled.answered, ['2505.06123']);
  assert.equal(settled.waitMs, 4_000, 'the other id still failed and waits for the retry-after');
  rememberFieldAnswers(uid, settled.answered);
  assert.deepEqual(Object.keys(listPapersAwaitingField(uid, papers, { savedAnswers, attempts: settled.attempts })), ['inspire:2920001']);
  forgetListPapers(uid);
});

test('every paper still waiting for a field is reported, while a round asks sixty', async () => {
  const { listPapersAwaitingField, nextListFieldRound, settleFieldRound } = await import('./list-paper-fields.ts');
  const uid = 'field-waiting-beyond-the-round';
  const papers = papersNamed(130);
  const ids = Object.keys(papers);
  const savedAnswers = new Set(ids);
  const waiting = listPapersAwaitingField(uid, papers, { savedAnswers, attempts: new Map() });
  assert.deepEqual(Object.keys(waiting), ids, 'the rows queued behind the first round wait too');
  const first = nextListFieldRound(waiting);
  assert.deepEqual(Object.keys(first), ids.slice(0, 60));
  const settled = settleFieldRound(new Map(), first, { fields: {}, failed: [], retryAfterMs: null });
  rememberFieldAnswers(uid, settled.answered);
  assert.equal(settled.waitMs, 0, 'a round with no failure is followed at once');
  const after = listPapersAwaitingField(uid, papers, { savedAnswers, attempts: settled.attempts });
  assert.deepEqual(Object.keys(after), ids.slice(60));
  assert.deepEqual(Object.keys(nextListFieldRound(after)), ids.slice(60, 120));
  // A row whose saved read has not answered is not waiting on a provider yet.
  assert.deepEqual(listPapersAwaitingField(uid, papers, { savedAnswers: new Set(), attempts: new Map() }), {});
  forgetListPapers(uid);
});

test('the papers behind a round that keeps failing still get their turn, and the rounds end', async () => {
  const uid = 'field-rounds-after-failed-rounds';
  const papers = papersNamed(102);
  const ids = Object.keys(papers);
  const asked = new Map<string, number>();
  const opening = await openOnce(uid, papers, (roundIds) => {
    roundIds.forEach((id) => { asked.set(id, (asked.get(id) ?? 0) + 1); });
    return failing()(roundIds);
  });
  assert.deepEqual(opening.rounds.map(round => round.asked.length), [60, 60, 60, 42, 42, 42]);
  assert.deepEqual(opening.rounds.map(round => round.waitMs), [5_000, 10_000, 10_000, 5_000, 10_000, 10_000], 'about 5 s after a first failure, 10 s after later ones');
  assert.deepEqual([...asked.keys()].sort(), ids, 'every paper was asked');
  assert.ok([...asked.values()].every(count => count === 3), 'none more than three times');
  assert.deepEqual(opening.awaiting, {});
  forgetListPapers(uid);
});

test('a retry-after is honoured, and one longer than a minute leaves its papers for the next opening', async () => {
  const uid = 'field-long-retry-after';
  const papers = papersNamed(2);
  const ids = Object.keys(papers);
  const beat = await openOnce(uid, papers, failing(4_000));
  assert.deepEqual(beat.rounds.map(round => round.waitMs), [4_000, 4_000, 4_000], "the Worker's beat, each time");
  const cooling = await openOnce(uid, papers, failing(45_000));
  assert.deepEqual(cooling.rounds.map(round => round.waitMs), [45_000, 45_000, 45_000], "what is left of the lane's cooldown");
  const refused = await openOnce(uid, papers, failing(300_000));
  assert.deepEqual(refused.rounds.map(round => round.asked), [ids], 'not asked again inside the wait the provider asked for');
  assert.equal(refused.rounds[0].waitMs, 60_000, 'the next round waits a minute at most');
  assert.deepEqual(refused.awaiting, {}, 'the rows stop waiting');
  const fresh = await openOnce(uid, papers, failing(300_000));
  assert.deepEqual(fresh.rounds[0].asked, ids, 'a fresh opening asks again');
  forgetListPapers(uid);
});

test('an OpenAlex paper is asked once per opening', async () => {
  const uid = 'field-openalex-once';
  const papers = { 'openalex:W4410000002': {}, 'ads:2025a': { doi: '10.1103/PhysRevB.42.892' } };
  const opening = await openOnce(uid, papers, failing());
  assert.deepEqual(opening.rounds.map(round => round.asked), [Object.keys(papers)], 'a budgeted call is not repeated');
  assert.equal(opening.rounds[0].waitMs, 5_000, 'the failure still holds the next round');
  assert.deepEqual(opening.awaiting, {});
  const fresh = await openOnce(uid, papers, failing());
  assert.deepEqual(fresh.rounds[0].asked, Object.keys(papers), 'a fresh opening asks again');
  forgetListPapers(uid);
});

test('a round whose failed papers are all spent still holds the next round', async () => {
  const { settleFieldRound } = await import('./list-paper-fields.ts');
  const [arxiv] = Object.keys(papersNamed(1));
  const spent = settleFieldRound(new Map([[arxiv, 2]]), { [arxiv]: {} }, failing()([arxiv]));
  assert.equal(spent.waitMs, 10_000, 'the third failure waits like the second');
  const openAlex = settleFieldRound(new Map(), { 'openalex:W4410000002': {} }, failing(12_000)(['openalex:W4410000002']));
  assert.equal(openAlex.waitMs, 12_000);
});
