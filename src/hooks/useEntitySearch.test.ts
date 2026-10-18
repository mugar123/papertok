import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import type { SearchSnapshot } from '../services/entitySearchService.ts';

// Exercise the hook's publication callback with controlled provider replies and
// Node's clock, without a second batching implementation or a DOM test runner.
const source = await readFile(new URL('./useEntitySearch.ts', import.meta.url), 'utf8');
const timing = source.slice(source.indexOf('const SEARCH_DEBOUNCE_MS'), source.indexOf('export function'));
const callback = source.slice(source.indexOf('  const performSearch ='), source.indexOf('  const startSearch ='));
const compiled = ts.transpileModule(`${timing}
${callback}
performSearch;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const empty: SearchSnapshot = { results: { papers: [], authors: [], topics: [], institutions: [], projects: [] }, pending: ['papers', 'authors', 'topics', 'institutions', 'projects'], issues: [] };
const paper = { id: 'openalex:W1', title: 'Graph neural networks', authors: [], abstract: '', sources: { primary: 'openalex' as const, enrichedBy: [] } };
const withPaper: SearchSnapshot = { ...empty, results: { ...empty.results, papers: [paper] }, pending: ['authors', 'topics', 'institutions', 'projects'] };
const withTopic: SearchSnapshot = { ...withPaper, results: { ...withPaper.results, topics: [{ id: 'https://openalex.org/T1', display_name: 'Graph neural networks' }] }, pending: ['authors', 'institutions', 'projects'] };

function setup() {
  const updates: { term: string; snapshot: SearchSnapshot }[] = [];
  const calls: { query: string; signal: AbortSignal; onUpdate: (snapshot: SearchSnapshot) => void; finish: (snapshot: SearchSnapshot) => void }[] = [];
  const events: unknown[] = [];
  const request: { current: AbortController | null } = { current: null };
  const performSearch = vm.runInNewContext(compiled, {
    request, AbortController, setTimeout, clearTimeout,
    useCallback: (fn: unknown) => fn,
    setAnswer: (answer: typeof updates[number]) => updates.push(answer),
    trackEvent: (...args: unknown[]) => events.push(args),
    searchEntities: (query: string, options: { signal: AbortSignal; onUpdate: (snapshot: SearchSnapshot) => void }) => new Promise<SearchSnapshot>(finish => calls.push({ query, ...options, finish })),
  }) as (term: string, papers: unknown[]) => Promise<void>;
  return { updates, calls, events, request, performSearch };
}

test('the first usable answer starts one 250 ms window; later replies cannot extend it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  const done = h.performSearch('graph neural', []);
  h.calls[0].onUpdate(empty);
  t.mock.timers.tick(1000);
  assert.equal(h.updates.length, 1, 'loading remains visible before the first usable answer');
  h.calls[0].onUpdate(withPaper);
  t.mock.timers.tick(200);
  h.calls[0].onUpdate(withTopic);
  t.mock.timers.tick(49);
  assert.equal(h.updates.length, 1, 'no intermediate paper-only paint');
  t.mock.timers.tick(1);
  assert.equal(h.updates.length, 2);
  assert.equal(h.updates[1].snapshot, withTopic, 'first paint includes the latest replies together');
  assert.ok(h.updates[1].snapshot.pending.includes('projects'), 'slow projects do not hold back the answer');
  const failedProject: SearchSnapshot = { ...withTopic, pending: [], issues: [{ section: 'projects', reason: 'timeout' }] };
  h.calls[0].onUpdate(failedProject);
  assert.equal(h.updates.at(-1)?.snapshot, failedProject, 'late updates publish immediately with section failures');
  h.calls[0].finish(failedProject);
  await done;
  assert.equal(h.calls.length, 1, 'grouping does not launch another search');
  assert.equal(h.events.length, 1);
});

test('cached results still form a batch when all sources finish before its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  const done = h.performSearch('graph neural', []);
  const cached = { ...withPaper, pending: [] };
  h.calls[0].onUpdate(cached);
  h.calls[0].finish(cached);
  await done;
  assert.equal(h.updates.length, 0);
  t.mock.timers.tick(250);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].snapshot, cached);
});

test('empty and failed searches finish without an artificial result delay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  const done = h.performSearch('missing', []);
  const settled: SearchSnapshot = { ...empty, pending: [], issues: [{ section: 'authors', reason: 'error' }] };
  h.calls[0].onUpdate(settled);
  h.calls[0].finish(settled);
  await done;
  assert.equal(h.updates[0].snapshot, settled);
  t.mock.timers.tick(250);
  assert.equal(h.updates.length, 1);
});

test('closing or changing the query cancels a buffered answer and ignores late updates', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  const old = h.performSearch('old', []);
  h.calls[0].onUpdate(withPaper);
  t.mock.timers.tick(100);
  h.request.current?.abort();
  h.calls[0].onUpdate(withTopic);
  h.calls[0].finish(withTopic);
  await old;
  t.mock.timers.tick(250);
  assert.equal(h.updates.length, 0);
  assert.equal(h.events.length, 0);
  const next = h.performSearch('new', []);
  h.calls[1].onUpdate(withTopic);
  t.mock.timers.tick(250);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].term, 'new');
  h.calls[1].finish(withTopic);
  await next;
});

test('retrying the same term replaces its pending batch rather than publishing both', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  const old = h.performSearch('graph', []);
  h.calls[0].onUpdate(withPaper);
  t.mock.timers.tick(200);
  const retry = h.performSearch('graph', []);
  h.calls[1].onUpdate(withTopic);
  h.calls[0].finish(withPaper);
  await old;
  t.mock.timers.tick(50);
  assert.equal(h.updates.length, 0);
  t.mock.timers.tick(200);
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0].snapshot, withTopic);
  h.calls[1].finish(withTopic);
  await retry;
});
