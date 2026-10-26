import test from 'node:test';
import assert from 'node:assert/strict';
import { searchEntities } from './entity-search-service.ts';
import type { SearchProviders, SearchSection, SearchSnapshot } from './entity-search-service.ts';
import type { Paper } from '../models/paper.ts';
import type { Project } from './open-aire-service.ts';
import { openAlexClient } from './open-alex-client.ts';

const paper: Paper = { id: 'openalex:W1', title: 'Segment Anything', authors: [], abstract: '', sources: { primary: 'openalex', enrichedBy: [] } };
const emptySources = { papers: async () => [paper], authors: async () => [], institutions: async () => [], topics: async () => [], projects: async () => [] };
const timeouts = { papers: 100, authors: 100, institutions: 100, topics: 100, projects: 10 };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('author suggestions answer while both background OpenAlex slots are occupied', async t => {
  for (const query of ['张伟', 'Geofrey Hin']) {
    await t.test(query, async t => {
      const release: Array<() => void> = [];
      const searches: string[] = [];
      const originalFetch = openAlexClient.fetchImpl;
      t.after(() => { openAlexClient.fetchImpl = originalFetch; });
      openAlexClient.fetchImpl = async rawUrl => {
        const url = new URL(rawUrl instanceof Request ? rawUrl.url : rawUrl);
        if (url.pathname.startsWith('/works/W')) {
          await new Promise<void>(resolve => release.push(resolve));
          return Response.json({ id: url.pathname.slice(1) });
        }
        searches.push(url.pathname);
        // Synthetic provider pages: Chinese matches the index; the typo
        // needs the byline fallback, which must have a turn of its own too.
        return Response.json({ results: url.pathname === '/authors'
          ? (query === '张伟' ? [{ id: 'https://openalex.org/A90001', display_name: '张伟' }] : [])
          : [{ authorships: [{ author: { id: 'https://openalex.org/A90002', display_name: 'Geoffrey E. Hinton' } }] }],
        });
      };
      const background = [1, 2].map(id => openAlexClient.json(`https://api.openalex.org/works/W9000${id}`, { cacheTtlMs: 0 }));
      try {
        await settle();
        assert.equal(release.length, 2, 'both background requests are still waiting for their response');
        const keepAlive = setTimeout(() => {}, 2000);
        t.after(() => clearTimeout(keepAlive));
        const result = await searchEntities(query, {
          signal: new AbortController().signal,
          timeouts: { ...timeouts, authors: 1000 },
          onUpdate: () => {},
        }).ask('authors');
        assert.deepEqual(result.issues, []);
        assert.deepEqual(result.results.authors.map(author => author.display_name),
          [query === '张伟' ? '张伟' : 'Geoffrey E. Hinton']);
        assert.deepEqual(searches, query === '张伟' ? ['/authors'] : ['/authors', '/works']);
      } finally {
        release.forEach(resolve => resolve());
        await Promise.all(background);
        await settle();
      }
    });
  }
});

test('papers publish before a slow project lookup and late replies cannot replace them', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  t.mock.method(Date, 'now', () => 5_000);
  const updates: SearchSnapshot[] = [];
  // Recorded as it happens, not sampled after a timer: a timer armed after the
  // 10 ms project deadline loses to it whenever a loaded machine deschedules
  // the test in between.
  const order: string[] = [];
  let resolveProject!: (items: Project[]) => void;
  const done = searchEntities('segment anything', {
    signal: new AbortController().signal, timeouts,
    sources: { ...emptySources, projects: (_q, signal) => {
      signal.addEventListener('abort', () => order.push('projects cut off'));
      return new Promise(resolve => { resolveProject = resolve; });
    } },
    onUpdate: snapshot => {
      if (snapshot.results.papers.length > 0 && !order.includes('papers shown')) order.push('papers shown');
      updates.push(snapshot);
    },
  }).ask('all');
  const result = await done;
  assert.deepEqual(order, ['papers shown', 'projects cut off']);
  const papersShown = updates.find(snapshot => snapshot.results.papers.length > 0);
  assert.deepEqual(papersShown?.results.papers, [paper]);
  assert.ok(papersShown?.pending.includes('projects'));
  assert.deepEqual(papersShown?.issues, []);
  assert.deepEqual(result.issues, [{ section: 'projects', reason: 'timeout', failedAtMs: 5_000 }]);
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
  }).ask('all');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].section, 'institutions');
  assert.equal(result.issues[0].reason, 'error');
  // The failure rides along: it is what tells a rate limit, and its wait, from the rest.
  assert.equal((result.issues[0].error as Error).message, 'Network failed');
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
  }).ask('all');
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
    }).ask('all');
    await settle();
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
  }).ask('all');
  assert.equal(updates[0].results.papers[0].title, target.title);
  assert.equal(result.results.papers.length, 1);
  assert.equal(result.results.papers[0].id, target.id);
  assert.equal(calls, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].section, 'papers');
  assert.equal(result.issues[0].reason, 'error');
});

// PAP-86: every debounced term is a papers search, but the author search is
// billed as ten list calls more, so it waits for the papers to settle and is
// never made for a term abandoned before its papers answer.
function countingSources(asked: SearchSection[], papers: SearchProviders['papers']): SearchProviders {
  return {
    papers: (query, signal) => { asked.push('papers'); return papers(query, signal); },
    authors: async () => { asked.push('authors'); return []; },
    institutions: async () => { asked.push('institutions'); return []; },
    topics: async () => { asked.push('topics'); return []; },
    projects: async () => { asked.push('projects'); return []; },
  };
}

test('under All the entity sections are asked once the papers have settled, the projects beside the papers', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const asked: SearchSection[] = [];
  let resolvePapers!: (items: Paper[]) => void;
  const search = searchEntities('quantum entanglement', {
    signal: new AbortController().signal, timeouts, onUpdate: () => {},
    sources: countingSources(asked, () => new Promise(resolve => { resolvePapers = resolve; })),
  });
  const done = search.ask('all');
  await settle();
  assert.deepEqual(asked, ['papers', 'projects']);
  assert.equal(search.settled('all'), false);
  resolvePapers([paper]);
  await settle();
  assert.deepEqual(asked, ['papers', 'projects', 'authors', 'institutions', 'topics']);
  const snapshot = await done;
  assert.deepEqual(snapshot.pending, []);
  assert.deepEqual(snapshot.results.papers, [paper]);
  assert.equal(search.settled('all'), true);
});

test('a query abandoned before the papers answer is never searched for authors, institutions or topics', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const asked: SearchSection[] = [];
  const controller = new AbortController();
  let resolvePapers!: (items: Paper[]) => void;
  const done = searchEntities('quantum', {
    signal: controller.signal, timeouts, onUpdate: () => {},
    sources: countingSources(asked, () => new Promise(resolve => { resolvePapers = resolve; })),
  }).ask('all');
  await settle();
  controller.abort();
  resolvePapers([paper]);
  await done;
  await settle();
  assert.deepEqual(asked, ['papers', 'projects']);
});

test('a chosen type is searched alone, and a type opened later is asked for then, once', async () => {
  const asked: SearchSection[] = [];
  const search = searchEntities('hinton', {
    signal: new AbortController().signal, timeouts, onUpdate: () => {},
    sources: countingSources(asked, async () => [paper]),
  });
  await search.ask('papers');
  assert.deepEqual(asked, ['papers']);
  assert.equal(search.settled('papers'), true);
  assert.equal(search.settled('all'), false, 'what was not asked is not answered');
  await Promise.all([search.ask('authors'), search.ask('authors')]);
  assert.deepEqual(asked, ['papers', 'authors']);
  const snapshot = await search.ask('authors');
  assert.deepEqual(snapshot.pending, ['institutions', 'topics', 'projects']);
  assert.deepEqual(snapshot.results.papers, [paper]);
});
