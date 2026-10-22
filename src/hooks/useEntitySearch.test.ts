import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import type { SearchSection, SearchSnapshot } from '../services/entitySearchService.ts';

// Run the real hook with a small hook host and controlled service replies.
// No provider, publication policy or production test API is duplicated here.
const source = await readFile(new URL('./useEntitySearch.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.slice(source.indexOf('const SEARCH_DEBOUNCE_MS')).replace('export function', 'function') + '\nuseEntitySearch;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const sections: SearchSection[] = ['papers', 'authors', 'institutions', 'topics', 'projects'];
const empty: SearchSnapshot = { results: { papers: [], authors: [], topics: [], institutions: [], projects: [] }, pending: [], issues: [] };
const loading: SearchSnapshot = { ...empty, pending: sections };
const paper = { id: 'openalex:W1', title: 'Graph neural networks', authors: [], abstract: '', sources: { primary: 'openalex' as const, enrichedBy: [] } };
const withPaper: SearchSnapshot = { ...loading, results: { ...empty.results, papers: [paper] }, pending: ['authors', 'topics', 'institutions', 'projects'] };
const complete: SearchSnapshot = { ...withPaper, pending: [], results: { ...withPaper.results, institutions: [{ id: 'https://ror.org/02f40zc51', display_name: 'University of Salamanca' }] } };
type View = {
  setQuery: (term: string) => void; retry: () => void;
  results: SearchSnapshot['results']; pendingSections: SearchSection[];
  totalResults: number; isPending: boolean; hasSearched: boolean;
  searchIssues: SearchSnapshot['issues'];
};
type Scope = 'all' | SearchSection;

function setup() {
  // One entry per ask: a search is started once, then asked for each scope it shows.
  const calls: { query: string; scope: Scope; signal: AbortSignal; onUpdate: (snapshot: SearchSnapshot) => void; finish: (snapshot: SearchSnapshot) => void }[] = [];
  const events: unknown[] = [];
  const slots: unknown[] = [];
  const memo = new Map<number, { deps: unknown[]; value: unknown }>();
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  const pendingEffects = new Map<number, () => void | (() => void)>();
  let cursor = 0;
  let dirty = false;
  let scope: Scope = 'all';
  let enabled = true;
  let view: View;
  const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const trackEvent = (...args: unknown[]) => events.push(args);
  const hook = vm.runInNewContext(compiled, {
    AbortController, setTimeout, clearTimeout, EMPTY_SEARCH: empty, SEARCH_SECTIONS: sections,
    useAnalyticsConsent: () => ({ trackEvent }),
    useState: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[i]) : next;
        if (!Object.is(slots[i], value)) { slots[i] = value; dirty = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useCallback: (fn: unknown, deps: unknown[]) => {
      const i = cursor++;
      if (!memo.has(i) || !same(memo.get(i)!.deps, deps)) memo.set(i, { deps, value: fn });
      return memo.get(i)!.value;
    },
    useEffectEvent: (fn: (...args: unknown[]) => unknown) => {
      const i = cursor++;
      const state = slots[i] as { fn: typeof fn; call: typeof fn } | undefined;
      if (state) state.fn = fn;
      else slots[i] = { fn, call: (...args: unknown[]) => (slots[i] as { fn: typeof fn }).fn(...args) };
      return (slots[i] as { call: typeof fn }).call;
    },
    useEffect: (fn: () => void | (() => void), deps: unknown[]) => {
      const i = cursor++;
      if (!effects.has(i) || !same(effects.get(i)!.deps, deps)) {
        effects.get(i)?.cleanup?.();
        effects.set(i, { deps });
        pendingEffects.set(i, fn);
      }
    },
    searchEntities: (query: string, options: { signal: AbortSignal; onUpdate: (snapshot: SearchSnapshot) => void }) => ({
      ask: (asked: Scope) => new Promise<SearchSnapshot>(finish => calls.push({ query, scope: asked, signal: options.signal, onUpdate: options.onUpdate, finish })),
    }),
  }) as (enabled: boolean, papers: unknown[], scope: Scope) => View;
  function render() {
    let renders = 0;
    do {
      cursor = 0;
      dirty = false;
      view = hook(enabled, [], scope);
      assert.ok(++renders < 20, 'the hook must reach a stable render');
    } while (dirty);
    for (const [i, effect] of pendingEffects) effects.get(i)!.cleanup = effect() || undefined;
    pendingEffects.clear();
    return view;
  }
  return {
    calls, events, render,
    type: (term: string) => { view.setQuery(term); return render(); },
    scope: (next: Scope) => { scope = next; return render(); },
    close: () => { enabled = false; return render(); },
    retry: () => { view.retry(); return render(); },
  };
}

function start(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.render();
  h.type('graph');
  t.mock.timers.tick(320);
  h.render();
  return h;
}

test('All publishes only after every category settles, including an empty or failed category', t => {
  const h = start(t);
  h.calls[0].onUpdate(withPaper);
  t.mock.timers.tick(1000);
  let view = h.render();
  assert.equal(view.isPending, true);
  assert.equal(view.totalResults, 0, 'no paper-only first paint after the old grouping window');
  h.calls[0].onUpdate({ ...complete, pending: ['projects'] });
  view = h.render();
  assert.equal(view.hasSearched, false);
  h.calls[0].onUpdate({ ...complete, issues: [{ section: 'projects', reason: 'timeout' }] });
  view = h.render();
  assert.equal(view.isPending, false);
  assert.equal(view.results.papers[0].title, 'Graph neural networks');
  assert.equal(view.results.institutions[0].display_name, 'University of Salamanca');
  assert.equal(view.searchIssues[0].section, 'projects');
  h.close();
});

test('Papers waits for its final provider merge, then rows and counts stay fixed as other sections settle', t => {
  const h = start(t);
  h.scope('papers');
  h.calls[0].onUpdate({ ...withPaper, pending: sections });
  assert.equal(h.render().totalResults, 0, 'feed seeds cannot trigger a partial answer');
  h.calls[0].onUpdate(withPaper);
  const first = h.render();
  assert.equal(first.isPending, false);
  assert.equal(first.results.papers[0].id, paper.id);
  h.calls[0].onUpdate(complete);
  const later = h.render();
  assert.equal(later.results, first.results);
  assert.equal(later.totalResults, first.totalResults);
  assert.equal(later.pendingSections, first.pendingSections, 'unknown tab counts do not change in the background');
  assert.ok(h.calls.every(call => call.signal === h.calls[0].signal), 'one search');
  h.close();
});

test('switching scope asks the same search for the type and exposes the newly selected complete view', t => {
  const h = start(t);
  h.calls[0].onUpdate(withPaper);
  assert.equal(h.scope('papers').isPending, false);
  assert.equal(h.scope('institutions').isPending, true);
  h.calls[0].onUpdate({ ...complete, pending: ['projects'] });
  assert.equal(h.render().isPending, false);
  assert.equal(h.scope('all').isPending, true);
  assert.equal(h.scope('papers').results.papers[0].id, paper.id);
  h.calls[0].onUpdate(complete);
  assert.equal(h.scope('all').totalResults, 2);
  assert.deepEqual(h.calls.map(call => call.scope), ['all', 'papers', 'institutions', 'all', 'papers', 'all']);
  assert.ok(h.calls.every(call => call.signal === h.calls[0].signal), 'tab changes never start a search');
  h.close();
});

test('an empty type settles without waiting for unrelated sources, retaining their terminal metadata', t => {
  const h = start(t);
  h.scope('topics');
  h.calls[0].onUpdate({ ...loading, pending: ['papers', 'institutions', 'projects'], issues: [{ section: 'authors', reason: 'error' }] });
  const view = h.render();
  assert.equal(view.hasSearched, true);
  assert.equal(view.isPending, false);
  assert.equal(view.totalResults, 0);
  assert.equal(view.searchIssues[0].section, 'authors');
  h.close();
});

test('a failed selected type publishes its failure without claiming a successful empty answer', t => {
  const h = start(t);
  h.scope('institutions');
  h.calls[0].onUpdate({ ...loading, pending: ['papers', 'authors', 'topics', 'projects'], issues: [{ section: 'institutions', reason: 'timeout' }] });
  const view = h.render();
  assert.equal(view.isPending, false);
  assert.equal(view.searchIssues[0].reason, 'timeout');
  h.close();
});

test('query edits hide the previous answer immediately and cancelled replies cannot restore it', t => {
  const h = start(t);
  h.calls[0].onUpdate(complete);
  assert.equal(h.render().totalResults, 2);
  assert.equal(h.type('new title').totalResults, 0);
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].onUpdate(complete);
  assert.equal(h.render().totalResults, 0);
  h.type('graph');
  assert.equal(h.render().totalResults, 0, 'returning to an old term cannot revive a cancelled generation');
  t.mock.timers.tick(320);
  h.calls[1].onUpdate(complete);
  assert.equal(h.render().totalResults, 2);
  h.close();
});

test('retrying the same query invalidates the frozen view; late replies from the old request stay out', t => {
  const h = start(t);
  h.calls[0].onUpdate(complete);
  h.render();
  const waiting = h.retry();
  assert.equal(waiting.isPending, true);
  assert.equal(waiting.totalResults, 0);
  h.calls[0].onUpdate(complete);
  assert.equal(h.render().isPending, true);
  h.calls[1].onUpdate(empty);
  assert.equal(h.render().isPending, false);
  assert.equal(h.render().totalResults, 0);
  assert.equal(h.calls.length, 2);
  h.close();
});

test('closing cancels the query and analytics ignores the cancelled search', async t => {
  const h = start(t);
  h.close();
  h.calls[0].onUpdate(complete);
  h.calls[0].finish(complete);
  await Promise.resolve();
  assert.equal(h.render().totalResults, 0);
  assert.equal(h.events.length, 0);
});

// PAP-86: the search starts with the type on screen and asks for another type
// only when the reader opens it, so a reader who stays on Papers never pays for
// the author search.
test('a type opened on a running search is asked for then; one opened after the query changed waits for the new search', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = setup();
  h.render();
  h.scope('papers');
  h.type('hinton');
  t.mock.timers.tick(320);
  h.render();
  assert.deepEqual(h.calls.map(call => call.scope), ['papers'], 'the search starts with the type on screen');
  h.scope('authors');
  assert.deepEqual(h.calls.map(call => call.scope), ['papers', 'authors']);
  assert.equal(h.calls[1].signal, h.calls[0].signal, 'asked of the same search');
  h.type('hinton geoffrey');
  h.scope('topics');
  assert.equal(h.calls.length, 2, 'a cancelled search is not asked for anything');
  t.mock.timers.tick(320);
  h.render();
  assert.equal(h.calls.at(-1)?.scope, 'topics');
  assert.notEqual(h.calls.at(-1)?.signal, h.calls[0].signal);
  h.close();
});
