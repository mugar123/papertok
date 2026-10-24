import test from 'node:test';
import assert from 'node:assert/strict';
import type { SearchProviders, SearchScope, SearchSnapshot } from '../../services/entitySearchService.ts';
import { searchEntities } from '../../services/entitySearchService.ts';
import { OpenAlexRequestError } from '../../services/openAlexClient.ts';
import type { SearchRun } from './searchPageRun.ts';
import { openSearchScope, scopeAnswerPaints, searchPageIssue } from './searchPageRun.ts';

const author = { id: 'https://openalex.org/A1', display_name: 'Someone' };
const institution = { id: 'https://ror.org/02f40zc51', display_name: 'University of Salamanca' };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A run of the real search over stubbed providers, started for `scope` as the page starts one. */
function startRun(scope: SearchScope, sources: Partial<SearchProviders>): SearchRun {
  const controller = new AbortController();
  return {
    controller,
    scope,
    search: searchEntities('cosmology', {
      signal: controller.signal,
      onUpdate() {},
      sources: {
        papers: async () => [], authors: async () => [], institutions: async () => [], topics: async () => [], projects: async () => [],
        ...sources,
      },
      timeouts: { papers: 1000, authors: 1000, institutions: 1000, topics: 1000, projects: 1000 },
    }),
  };
}

function painter() {
  const paints: SearchSnapshot[] = [];
  let waits = 0;
  return { paints, paint: (snapshot: SearchSnapshot) => { paints.push(snapshot); }, waiting: () => { waits += 1; }, waits: () => waits };
}

test('a scope opened while the search runs is painted by its own answer, not by the one it replaced', async () => {
  let resolveAuthors!: (items: typeof author[]) => void;
  const run = startRun('papers', { authors: () => new Promise(resolve => { resolveAuthors = resolve; }) });
  const screen = painter();
  const papersAnswer = run.search.ask('papers');
  openSearchScope(run, 'all', screen.paint, screen.waiting);
  await papersAnswer;
  assert.equal(scopeAnswerPaints(run, 'papers'), false, 'the Papers answer, with the authors still pending, would paint under All');
  assert.equal(screen.waits(), 1);
  await settle();
  assert.equal(screen.paints.length, 0);
  resolveAuthors([author]);
  await settle();
  assert.equal(screen.paints.length, 1);
  assert.deepEqual(screen.paints[0].results.authors, [author]);
});

test('a scope that has already settled paints at once, with no wait', async () => {
  const run = startRun('all', { institutions: async () => { throw new Error('ROR failed'); } });
  await run.search.ask('all');
  assert.equal(scopeAnswerPaints(run, 'all'), true);
  const screen = painter();
  openSearchScope(run, 'papers', screen.paint, screen.waiting);
  assert.equal(screen.paints.length, 1, 'opening a settled scope painted nothing in the same turn');
  assert.equal(screen.waits(), 0);
  assert.deepEqual(screen.paints[0].issues.map(issue => issue.section), ['institutions']);
});

test('between two scope changes only the scope on screen paints', async () => {
  let resolveAuthors!: (items: typeof author[]) => void;
  let resolveInstitutions!: (items: typeof institution[]) => void;
  const run = startRun('all', {
    authors: () => new Promise(resolve => { resolveAuthors = resolve; }),
    institutions: () => new Promise(resolve => { resolveInstitutions = resolve; }),
  });
  const screen = painter();
  void run.search.ask('all');
  openSearchScope(run, 'authors', screen.paint, screen.waiting);
  openSearchScope(run, 'institutions', screen.paint, screen.waiting);
  await settle();
  resolveAuthors([author]);
  await settle();
  assert.equal(screen.paints.length, 0, 'the Authors answer painted the Institutions scope empty');
  resolveInstitutions([institution]);
  await settle();
  assert.equal(screen.paints.length, 1);
  assert.deepEqual(screen.paints[0].results.institutions, [institution]);
});

test('an ended search paints nothing when a scope is opened', () => {
  const run = startRun('papers', {});
  run.controller.abort();
  const screen = painter();
  openSearchScope(run, 'authors', screen.paint, screen.waiting);
  openSearchScope(null, 'authors', screen.paint, screen.waiting);
  assert.equal(run.scope, 'papers');
  assert.equal(scopeAnswerPaints(run, 'papers'), false);
  assert.deepEqual([screen.paints.length, screen.waits()], [0, 0]);
});

// OpenAlex's Retry-After counts from the refusal. Opening a scope repaints the
// answer the search already has; a wait restarted on each repaint kept Retry
// hidden for as long as the reader kept switching.
test("a rate limit's wait counts from the refusal, whenever the answer is repainted", () => {
  const issues = [{
    section: 'authors' as const, reason: 'error' as const, failedAtMs: 1_000_000,
    error: new OpenAlexRequestError('OpenAlex rate limit reached', { code: 'rate_limited', status: 429, retryAfterMs: 300_000 }),
  }];
  const recovered = { rateLimited: false, retryAfterMs: 0 };
  assert.equal(searchPageIssue(issues, recovered, 1_000_000)?.retryAtMs, 1_300_000);
  assert.equal(searchPageIssue(issues, recovered, 1_100_000)?.retryAtMs, 1_300_000);
  const ended = searchPageIssue(issues, recovered, 1_350_000);
  assert.deepEqual(ended?.sections, ['authors']);
  assert.equal(ended?.retryAtMs, null, 'a wait that had ended started again');
});

test('a search the Worker refused for the budget is a pause with no countdown', () => {
  const issue = searchPageIssue([{
    section: 'papers', reason: 'error', failedAtMs: 1_000_000,
    error: new OpenAlexRequestError('OpenAlex rate limit reached', { code: 'rate_limited', status: 429, retryAfterMs: 300_000, budgetTier: 'exploration' }),
  }], { rateLimited: false, retryAfterMs: 0 }, 1_000_000);
  assert.deepEqual(issue?.sections, ['papers']);
  assert.equal(issue?.budgetPaused, true);
  assert.equal(issue?.rateLimited, false);
  assert.equal(issue?.retryAtMs, null);
});

test('a 429 from OpenAIRE does not name OpenAlex', () => {
  const issue = searchPageIssue([{
    section: 'projects', reason: 'error', failedAtMs: 1_000_000,
    error: Object.assign(new Error('OpenAIRE 429'), { status: 429 }),
  }], { rateLimited: false, retryAfterMs: 0 }, 1_000_000);
  assert.deepEqual(issue?.sources, ['openaire']);
  assert.equal(issue?.rateLimited, false);
});
