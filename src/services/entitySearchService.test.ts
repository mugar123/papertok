import test from 'node:test';
import assert from 'node:assert/strict';
import { searchEntities } from './entitySearchService.ts';
import type { SearchSnapshot } from './entitySearchService.ts';
import type { Paper } from '../models/Paper.ts';
import type { Project } from './openAireService.ts';

const paper: Paper = { id: 'openalex:W1', title: 'Segment Anything', authors: [], abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
const emptySources = { papers: async () => [paper], authors: async () => [], institutions: async () => [], topics: async () => [], projects: async () => [] };
const timeouts = { papers: 100, authors: 100, institutions: 100, topics: 100, projects: 10 };

test('papers publish before a slow project lookup and late replies cannot replace them', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const updates: SearchSnapshot[] = [];
  // Recorded as it happens, not sampled after a timer: a timer armed after the
  // 10 ms project deadline loses to it whenever a loaded machine deschedules
  // the test in between.
  const order: string[] = [];
  let projectSignal: AbortSignal | undefined;
  let resolveProject!: (items: Project[]) => void;
  const done = searchEntities('segment anything', {
    signal: new AbortController().signal, timeouts,
    sources: { ...emptySources, projects: (_q, signal) => {
      projectSignal = signal;
      signal.addEventListener('abort', () => order.push('projects cut off'));
      return new Promise(resolve => { resolveProject = resolve; });
    } },
    onUpdate: snapshot => {
      if (snapshot.results.papers.length > 0 && !order.includes('papers shown')) order.push('papers shown');
      updates.push(snapshot);
    },
  });
  const result = await done;
  assert.deepEqual(order, ['papers shown', 'projects cut off']);
  const papersShown = updates.find(snapshot => snapshot.results.papers.length > 0);
  assert.deepEqual(papersShown?.results.papers, [paper]);
  assert.ok(papersShown?.pending.includes('projects'));
  assert.deepEqual(papersShown?.issues, []);
  assert.deepEqual(result.issues, [{ section: 'projects', reason: 'timeout' }]);
  assert.equal(projectSignal?.aborted, true);
  assert.deepEqual(result.results.papers, [paper]);
  resolveProject([{ id: 'late', title: 'Late project', funder: '' }]);
  await Promise.resolve();
  assert.deepEqual(updates.at(-1)?.results.projects, []);
});

test('failed sections are identified even when no section returns a result', async () => {
  const result = await searchEntities('missing', {
    signal: new AbortController().signal,
    sources: { ...emptySources, papers: async () => [], institutions: async () => { throw new Error('Network failed'); } },
    onUpdate: () => {},
  });
  assert.deepEqual(result.issues, [{ section: 'institutions', reason: 'error' }]);
  assert.equal(Object.values(result.results).flat().length, 0);
});

test('a cancelled search cannot publish results or errors into the next query', async () => {
  const controller = new AbortController();
  const updates: SearchSnapshot[] = [];
  let resolvePaper!: (items: Paper[]) => void;
  const done = searchEntities('old query', {
    signal: controller.signal,
    sources: { ...emptySources, papers: () => new Promise(resolve => { resolvePaper = resolve; }) },
    onUpdate: snapshot => updates.push(snapshot),
  });
  await Promise.resolve();
  controller.abort();
  await done;
  resolvePaper([paper]);
  await Promise.resolve();
  assert.equal(updates.length, 1, 'only the initial loading state was published');
});

test('a preferred institution or project never holds back available papers', async () => {
  for (const query of ['BERT', 'Human Brain Project']) {
    const controller = new AbortController();
    const updates: SearchSnapshot[] = [];
    const done = searchEntities(query, {
      signal: controller.signal,
      sources: { ...emptySources, institutions: () => new Promise(() => {}), projects: () => new Promise(() => {}) },
      onUpdate: snapshot => updates.push(snapshot),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(updates.at(-1)?.results.papers, [paper]);
    assert.ok(updates.at(-1)?.pending.includes('institutions'));
    assert.ok(updates.at(-1)?.pending.includes('projects'));
    controller.abort();
    await done;
  }
});


test('a loaded feed title is suggested before providers and survives their failure without extra calls', async () => {
  const target: Paper = { ...paper, title: 'From Accelerating Rotating Black Holes to a Swirling Universe' };
  const updates: SearchSnapshot[] = [];
  let calls = 0;
  const result = await searchEntities('from acelerating rotating bla', {
    knownPapers: [target, { ...paper, id: 'unrelated', title: 'Rotarod enables mouse assessment' }],
    signal: new AbortController().signal,
    sources: { ...emptySources, papers: async () => { calls += 1; throw new Error('Unavailable'); } },
    onUpdate: snapshot => updates.push(snapshot),
  });
  assert.equal(updates[0].results.papers[0].title, target.title);
  assert.equal(result.results.papers.length, 1);
  assert.equal(result.results.papers[0].id, target.id);
  assert.equal(calls, 1);
  assert.deepEqual(result.issues, [{ section: 'papers', reason: 'error' }]);
});
