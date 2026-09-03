import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRecommendationCache, getPaperRecommendations } from './semanticScholarService.js';
import { getSemanticScholarPaperId } from './relatedPapersService.js';

// The recommendations used to leave the browser for `api.semanticscholar.org`
// behind a module-variable limiter that did not even serialize: it read
// `lastRequestTime`, awaited, and only then wrote it, so concurrent callers all
// read the same stale value and fired together. They now go through `/related`.

test('turns the related papers from the Worker into arXiv identifiers, once per paper', async () => {
  clearRecommendationCache();
  const asked = [];
  const fetchRelated = async (paper, limit) => {
    asked.push({ paper, limit });
    return [
      { arxivId: '2601.00001' },
      { arxivId: null },
      { arxivId: '2602.00002' },
    ];
  };

  const ids = await getPaperRecommendations({ arxivId: '2607.12345v3' }, { fetchRelated });
  const again = await getPaperRecommendations({ arxivId: '2607.12345v2' }, { fetchRelated });

  assert.deepEqual(ids, ['2601.00001', '2602.00002']);
  assert.deepEqual(again, ids);
  // v2 and v3 of one paper are one lookup: the cache is keyed by the
  // version-free Semantic Scholar id, the same one `/related` is asked with.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].limit, 20);
});

test('asks for a paper that has a DOI and no arXiv id, and hands over the paper itself', async () => {
  clearRecommendationCache();
  const asked = [];
  const fetchRelated = async paper => { asked.push(paper); return [{ arxivId: '2601.00001' }]; };

  // A PubMed or OpenAlex paper used to be `getPaperRecommendations(undefined)`:
  // no recommendation, no log, and nobody knew the feed only expanded from
  // arXiv. `/related` takes a DOI and so does this.
  const paper = { id: 'pubmed:31000001', doi: '10.1000/xyz', title: 'One' };
  const ids = await getPaperRecommendations(paper, { fetchRelated });

  assert.deepEqual(ids, ['2601.00001']);
  // By reference, not by shape: `fetchRelatedFromWorker` filters the paper out
  // of its own related list by `paper.id`, so a forwarded copy that carried only
  // the identifiers would pass a `deepEqual` on `{ doi }` and still lose the id.
  assert.equal(asked.length, 1);
  assert.equal(asked[0], paper, 'the paper must be forwarded as-is, not rebuilt from its identifiers');
});

test('has nothing to ask for a paper with neither DOI nor arXiv id', async () => {
  clearRecommendationCache();
  let calls = 0;
  const ids = await getPaperRecommendations({ id: 'local-only' }, { fetchRelated: async () => { calls += 1; return []; } });
  assert.deepEqual(ids, []);
  assert.equal(calls, 0);
});

test('asks under the same identity the related-papers sheet would use, for a paper with both a DOI and an arXiv id', async () => {
  clearRecommendationCache();
  let askedPaper = null;
  const fetchRelated = async paper => { askedPaper = paper; return [{ arxivId: '2601.00001' }]; };

  // `RelatedPapersSheet` calls `getRelatedPapers(paper)` with the whole paper, and
  // `getSemanticScholarPaperId` prefers DOI over arXiv id. Before this change, the
  // feed called this function with only `paper.arxivId`, so one paper resolved to
  // `ARXIV:...` from the feed and `DOI:...` from the sheet: two edge-cache entries
  // and two provider calls close in time, a refusal at one request a second.
  // Assert on the resolved identity itself, not on the shape of what was forwarded.
  await getPaperRecommendations({ doi: '10.1000/xyz', arxivId: '2607.12345' }, { fetchRelated });

  assert.equal(getSemanticScholarPaperId(askedPaper), 'DOI:10.1000/xyz');
});

test('does not reach Semantic Scholar directly when the route is unavailable', async () => {
  clearRecommendationCache();
  const escaped = [];
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async input => {
    escaped.push(String(input?.url || input));
    return new Response('{}', { status: 500 });
  };
  console.warn = () => {};
  try {
    // No injected dependency: the real path, which needs a Firebase session and a
    // configured Worker origin, neither of which exists here. It has to fail as a
    // missing recommendation, not by falling back to a keyless browser call.
    const ids = await getPaperRecommendations({ arxivId: '2607.12345' });
    assert.deepEqual(ids, []);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }

  assert.deepEqual(escaped, [], `something still left the browser: ${escaped.join(', ')}`);
});

test('does not cache a failure as an empty recommendation set', async () => {
  clearRecommendationCache();
  let attempts = 0;
  const fetchRelated = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('route unavailable');
    return [{ arxivId: '2601.00001' }];
  };

  assert.deepEqual(await getPaperRecommendations({ arxivId: '2607.12345' }, { fetchRelated }), []);
  assert.deepEqual(await getPaperRecommendations({ arxivId: '2607.12345' }, { fetchRelated }), ['2601.00001']);
  assert.equal(attempts, 2);
});
