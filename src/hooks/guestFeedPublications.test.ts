import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { classifyFeedPublications, isFeedPublication } from '../services/feedPublicationService.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { buildGuestFeedPlan } from '../utils/guestFeedPlan.ts';
import { composeGuestPage, extendGuestPage } from '../utils/guestFeedComposition.ts';

const source = readFileSync(new URL('./useGuestFeed.ts', import.meta.url), 'utf8');
const start = source.indexOf('function startGuestCandidateRequests(');
const end = source.indexOf('\nfunction dedupePapers', start);
assert.ok(start >= 0 && end > start);
const callback = stripTypeScriptTypes(source.slice(start, end));

test('guest candidate batches exclude video books and book reviews before both early and late composition', async t => {
  const adapter = new OpenAlexAdapter();
  const papers = [
    { id: 'W568341909', doi: '10.1007/978-3-540-76956-9', title: 'Mathematical Theory of Feynman Path Integrals' },
    { id: 'W93572185', doi: '10.1007/978-3-319-04870-3', title: 'Combinatorial algebraic geometry : Levico Terme, Italy 2013' },
    { id: 'W1998067413', doi: '10.2307/2309205', title: 'Introduction to Algebraic Geometry.' },
    { id: 'W3029239115', doi: '10.1016/j.indag.2021.09.002', title: 'Applications of Algebraic Combinatorics to Algebraic Geometry' },
    { id: 'scientific-review', doi: '10.5555/guest-review', title: 'Synthetic scientific review', type: 'review' },
  ].map(work => ({ ...adapter.mapToStandard({ type: 'article', ...work })!, categories: ['math.AG'] }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const dois = new URL(String(input)).searchParams.get('filter')!.split(',').map(value => value.slice(4));
    return Response.json({ message: { 'total-results': dois.length, items: dois.map(DOI => ({ DOI, type: DOI.startsWith('10.1007/') ? 'book' : 'journal-article' })) } });
  });
  const env = {
    fetchPapers: async () => [], fetchDomainPapers: async () => [],
    OpenAlexAdapter: class { async search() { return { papers }; } },
    PubmedAdapter: class { async search() { return { papers: [] }; } },
    GUEST_PAGE_SIZE: 12, classifyFeedPublications, isFeedPublication,
  };
  const requests = new Function(...Object.keys(env), `${callback}; return startGuestCandidateRequests;`)(...Object.values(env));
  const plan = buildGuestFeedPlan(['math']);
  const candidates = (await Promise.all(requests(plan))).flat();
  for (const composed of [composeGuestPage(candidates, plan, 12), extendGuestPage([], candidates, plan, 12)]) {
    assert.deepEqual(composed.map(work => work.id).sort(), ['W3029239115', 'scientific-review']);
    assert.equal(composed.find(work => work.id === 'scientific-review')?.publicationType, 'review');
  }
});
