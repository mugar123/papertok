import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { Paper } from '../models/Paper.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { getMissingArxivAbstractIds, getMissingAbstractDois, mergeFeedAbstracts } from '../utils/feedEnrichment.ts';

// Trimmed OpenAlex W3029239115 and arXiv 2005.12542v4 payloads fetched on
// 2026-10-18 for the user's video. The abstract is the source's actual text.
const videoPaper = PaperBuilder.create(new OpenAlexAdapter().mapToStandard({
  id: 'https://openalex.org/W3029239115',
  title: 'Applications of Algebraic Combinatorics to Algebraic Geometry',
  doi: 'https://doi.org/10.1016/j.indag.2021.09.002',
  ids: { openalex: 'https://openalex.org/W3029239115' },
  type: 'article',
  publication_date: '2021-12-01',
  publication_year: 2021,
  cited_by_count: 8,
  abstract_inverted_index: null,
  authorships: [],
  open_access: { is_oa: true },
  primary_location: { landing_page_url: 'https://doi.org/10.1016/j.indag.2021.09.002', is_published: true },
  locations: [{ landing_page_url: 'http://arxiv.org/abs/2005.12542', pdf_url: 'https://arxiv.org/pdf/2005.12542' }],
})!);
const sourceAbstract = 'We formulate a number of new results in Algebraic Geometry and outline their derivation from Theorem 2.12 which belongs to Algebraic Combinatorics.';
const arxivPaper = PaperBuilder.create({
  id: '2005.12542', arxivId: '2005.12542', title: videoPaper.title,
  abstract: sourceAbstract, sources: { primary: 'arxiv', enrichedBy: [] },
  publicationStatus: 'preprint', openAccess: true,
});

// Execute the hook's effects with only the React lifecycle and provider
// boundary replaced. This exercises cleanup and dependency changes under Node.
const hookSource = stripTypeScriptTypes(readFileSync(new URL('./useFeedAbstractRecovery.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export function', 'function'));
function harness(initial: Paper[], fetchPapers: (ids: string[]) => Promise<Paper[]>, fetchDois: (dois: string[]) => Promise<Partial<Paper>[]> = async () => []) {
  let papers = initial;
  const dependencies: unknown[][] = [];
  const cleanups: Array<(() => void) | void> = [];
  let effectIndex = 0;
  let deliveries = 0;
  const useEffect = (effect: () => (() => void) | void, next: unknown[]) => {
    const index = effectIndex++;
    const previous = dependencies[index] || [];
    if (next.length === previous.length && next.every((value, i) => Object.is(value, previous[i]))) return;
    cleanups[index]?.();
    dependencies[index] = next;
    cleanups[index] = effect();
  };
  const hook = new Function('useEffect', 'fetchPapersByIds', 'getMissingArxivAbstractIds', 'getMissingAbstractDois', 'fetchInspireAbstracts',
    `${hookSource}\nreturn useFeedAbstractRecovery;`)(useEffect, fetchPapers, getMissingArxivAbstractIds, getMissingAbstractDois, fetchDois);
  const apply = (records: Partial<Paper>[]) => { deliveries += 1; papers = mergeFeedAbstracts(papers, records); };
  return {
    render(scope = 'guest') { effectIndex = 0; hook(papers, apply, scope); },
    replace(next: Paper[]) { papers = next; },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
    get papers() { return papers; },
    get deliveries() { return deliveries; },
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('recovers a DOI-only OpenAlex scientific review without changing its status, access or identity', async () => {
  const review = { ...videoPaper, arxivId: undefined, doi: '10.1016/0370-2693(86)90963-9', publicationType: 'review', openAccess: false, pdfUrl: null };
  const state = harness([review], async () => { throw new Error('No arXiv identifier'); }, async dois => {
    assert.deepEqual(dois, ['10.1016/0370-2693(86)90963-9']);
    return [{ doi: '10.1016/0370-2693(86)90963-9', abstract: 'Verified publisher text.', sources: { primary: 'inspire', enrichedBy: [] } }];
  });
  state.render();
  await tick();
  assert.deepEqual(state.papers[0], {
    ...review, abstract: 'Verified publisher text.', summary: 'Verified publisher text.',
    sources: { primary: 'openalex', enrichedBy: ['inspire'] },
  });
});

test('DOI recovery skips existing abstracts and arXiv links, and preserves unmatched work', () => {
  const unlinked = { ...videoPaper, arxivId: undefined, doi: 'https://doi.org/10.5555/KNOWN' };
  const unavailable = { ...unlinked, doi: undefined };
  const existing = { ...unlinked, abstract: 'Existing source text.' };
  assert.deepEqual(getMissingAbstractDois([unlinked, unavailable, existing, videoPaper, { ...unlinked, doi: '10.5555/known' }]), ['10.5555/known']);
  const papers = [unlinked, unavailable, existing, videoPaper];
  assert.equal(mergeFeedAbstracts(papers, [{ doi: '10.5555/another', abstract: 'Other text.', sources: { primary: 'inspire', enrichedBy: [] } }]), papers);
});

test('DOI recovery rejects stale responses after account changes and unmount', async () => {
  const record = { ...videoPaper, arxivId: undefined };
  const old = deferred();
  const current = deferred();
  let calls = 0;
  const state = harness([record], async () => [], async () => ++calls === 1 ? old.promise : current.promise);
  state.render('user-a');
  state.render('user-b');
  old.resolve([{ ...record, abstract: 'Old account response.', sources: { primary: 'inspire', enrichedBy: [] } }]);
  await tick();
  assert.equal(state.deliveries, 0);
  state.unmount();
  current.resolve([{ ...record, abstract: 'Unmounted response.', sources: { primary: 'inspire', enrichedBy: [] } }]);
  await tick();
  assert.equal(state.deliveries, 0);
});

test('a restored DOI-only snapshot recovers without discovery and preserves a later existing abstract', async () => {
  const pending = deferred();
  const record = { ...videoPaper, arxivId: undefined };
  const state = harness([], async () => [], async () => pending.promise);
  state.render('user-a');
  state.replace([record]);
  state.render('user-a');
  const existing = { ...record, abstract: 'Already recovered elsewhere.' };
  state.replace([existing]);
  pending.resolve([{ ...record, abstract: 'Later source.', sources: { primary: 'inspire', enrichedBy: [] } }]);
  await tick();
  assert.equal(state.papers[0], existing);
});
function deferred() {
  let resolve!: (papers: Paper[]) => void;
  const promise = new Promise<Paper[]>(done => { resolve = done; });
  return { promise, resolve };
}

test('recovers the video paper from its linked arXiv record without changing published metadata', async () => {
  assert.equal(videoPaper.abstract, 'No abstract available.');
  assert.equal(videoPaper.arxivId, '2005.12542');
  const requests: string[][] = [];
  const state = harness([videoPaper], async ids => { requests.push(ids); return [arxivPaper]; });
  state.render();
  await tick();
  assert.deepEqual(requests, [['2005.12542']]);
  assert.equal(state.papers[0].abstract, sourceAbstract);
  assert.deepEqual(state.papers[0], {
    ...videoPaper, abstract: sourceAbstract, summary: sourceAbstract,
    sources: { primary: 'openalex', enrichedBy: ['arxiv'] },
  });
  state.render();
  await tick();
  assert.equal(requests.length, 1);
});

test('only asks for linked OpenAlex papers missing an abstract, deduplicating versioned IDs', () => {
  assert.deepEqual(getMissingArxivAbstractIds([
    videoPaper,
    { ...videoPaper, arxivId: 'arxiv:2005.12542v4' },
    { ...videoPaper, abstract: 'The publisher already supplied this abstract.', arxivId: '2101.12345' },
    { ...videoPaper, arxivId: undefined },
    { ...videoPaper, arxivId: 'not-an-arxiv-id' },
    { ...arxivPaper, abstract: 'No abstract available.' },
  ]), ['2005.12542']);
});

test('preserves existing abstracts, missing records, and closed access', () => {
  const closed = { ...videoPaper, openAccess: false, pdfUrl: null };
  const existing = { ...videoPaper, abstract: 'Already supplied by the publisher.' };
  const unlinked = { ...videoPaper, arxivId: undefined };
  const other = { ...videoPaper, arxivId: 'hep-th/9901001' };
  const papers = [closed, existing, unlinked, other];
  const merged = mergeFeedAbstracts(papers, [arxivPaper]);
  assert.equal(merged[0].abstract, sourceAbstract);
  assert.equal(merged[0].openAccess, false);
  assert.equal(merged[0].pdfUrl, null);
  assert.equal(merged[0].publicationStatus, 'published');
  assert.equal(merged[1], existing);
  assert.equal(merged[2], unlinked);
  assert.equal(merged[3], other);
  assert.equal(mergeFeedAbstracts(papers, []), papers);
  assert.equal(mergeFeedAbstracts(papers, [{ ...arxivPaper, abstract: 'No abstract available.' }]), papers);
  assert.equal(mergeFeedAbstracts(merged, [arxivPaper]), merged);
});

test('a late arXiv response does not replace an abstract another provider already filled', async () => {
  const pending = deferred();
  const state = harness([videoPaper], () => pending.promise);
  state.render();
  const updated = { ...videoPaper, abstract: 'A sourced abstract arriving from another provider.' };
  state.replace([updated]);
  pending.resolve([arxivPaper]);
  await tick();
  assert.equal(state.papers[0], updated);
});

test('a restored snapshot gets recovery without running discovery again', async () => {
  const state = harness([], async () => [arxivPaper]);
  state.render('user-a:top');
  state.replace(JSON.parse(JSON.stringify([videoPaper])));
  state.render('user-a:top');
  await tick();
  assert.equal(state.papers[0].abstract, sourceAbstract);
});

for (const nextScope of ['user-b:top', 'user-a:recent', 'guest:new-interests']) {
  test(`discards an in-flight response after changing scope to ${nextScope}`, async () => {
    const oldRequest = deferred();
    const newRequest = deferred();
    let requests = 0;
    const state = harness([videoPaper], () => ++requests === 1 ? oldRequest.promise : newRequest.promise);
    state.render('user-a:top');
    state.render(nextScope);
    oldRequest.resolve([arxivPaper]);
    await tick();
    assert.equal(state.deliveries, 0);
    assert.equal(state.papers[0].abstract, 'No abstract available.');
    newRequest.resolve([arxivPaper]);
    await tick();
    assert.equal(state.papers[0].abstract, sourceAbstract);
  });
}

test('unmounting prevents a late response from updating papers', async () => {
  const pending = deferred();
  const state = harness([videoPaper], () => pending.promise);
  state.render();
  state.unmount();
  pending.resolve([arxivPaper]);
  await tick();
  assert.equal(state.deliveries, 0);
});

test('a provider failure keeps the feed usable and retries only after its dependencies change', async t => {
  t.mock.method(console, 'warn', () => {});
  let requests = 0;
  const state = harness([videoPaper], async () => {
    requests += 1;
    if (requests === 1) throw new Error('arXiv unavailable');
    return [arxivPaper];
  });
  state.render();
  await tick();
  assert.equal(state.papers[0], videoPaper);
  state.render();
  await tick();
  assert.equal(requests, 1);
  state.render('guest:refresh');
  await tick();
  assert.equal(state.papers[0].abstract, sourceAbstract);
});

test('a long restored feed requests sequential batches within the Worker limit', async () => {
  const papers = Array.from({ length: 55 }, (_, i) => ({ ...videoPaper, arxivId: `2101.${String(10000 + i)}` }));
  const requests: string[][] = [];
  const first = deferred();
  const state = harness(papers, async ids => {
    requests.push(ids);
    if (requests.length === 1) return first.promise;
    return ids.map(arxivId => ({ ...arxivPaper, arxivId }));
  });
  state.render();
  assert.equal(requests.length, 1);
  first.resolve(requests[0].map(arxivId => ({ ...arxivPaper, arxivId })));
  await tick();
  assert.deepEqual(requests.map(ids => ids.length), [50, 5]);
  assert.equal(state.papers.filter(paper => paper.abstract === sourceAbstract).length, 55);
});

for (const host of ['guest', 'signed-in'] as const) {
  test(`${host} feed applies recovered text to its displayed card${host === 'signed-in' ? ' and snapshot' : ''}`, () => {
    const source = readFileSync(new URL(host === 'guest' ? './useGuestFeed.ts' : '../context/FeedContext.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('  const applyRecoveredAbstracts = useCallback(');
    const call = source.indexOf('  useFeedAbstractRecovery(', start);
    const end = source.indexOf(';', call) + 1;
    assert.ok(start >= 0 && call > start && end > call, 'the feed connects abstract recovery');
    const code = stripTypeScriptTypes(source.slice(start, end));
    let current = [videoPaper];
    let saved: Paper[] = [];
    const env = {
      papers: current, enabled: true, feedRouteActive: true, recommendationProfileReady: true,
      planKey: 'math.AG', isRefreshing: false, user: { uid: 'emulator-user' }, feedMode: 'top',
      abstractRecoverySignature: 'math.AG',
      feedCache: { current: { top: { papers: current, page: 1, hasMore: true } } },
      useCallback: (fn: unknown) => fn,
      setPapers: (update: (papers: Paper[]) => Paper[]) => { current = update(current); },
      mergeFeedAbstracts,
      scheduleFeedSnapshotWrite: (_uid: string, _signature: string, snapshot: { papers: Paper[] }) => { saved = snapshot.papers; },
      useFeedAbstractRecovery: (papers: Paper[], apply: (records: Paper[]) => void) => {
        assert.equal(papers[0], videoPaper);
        apply([arxivPaper]);
      },
    };
    new Function(...Object.keys(env), code)(...Object.values(env));
    assert.equal(current[0].abstract, sourceAbstract);
    if (host === 'signed-in') assert.equal(saved[0].abstract, sourceAbstract);
  });
}
