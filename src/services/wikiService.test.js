import test from 'node:test';
import assert from 'node:assert/strict';
import { getEntityWikiInfo, mapWikipediaSearchResponse } from './wikiService.js';

test('maps a Wikipedia search result in the requested language', () => {
  const result = mapWikipediaSearchResponse({
    query: {
      pages: {
        12: {
          index: 1,
          title: 'General relativity',
          extract: 'General relativity is a theory of gravitation developed by Albert Einstein.',
          fullurl: 'https://en.wikipedia.org/wiki/General_relativity',
          thumbnail: { source: 'https://upload.wikimedia.org/example.jpg' },
        },
      },
    },
  }, 'en');

  assert.deepEqual(result, {
    title: 'General relativity',
    extract: 'General relativity is a theory of gravitation developed by Albert Einstein.',
    thumbnail: 'https://upload.wikimedia.org/example.jpg',
    url: 'https://en.wikipedia.org/wiki/General_relativity',
    language: 'en',
  });
});

test('skips disambiguation and empty Wikipedia results', () => {
  assert.equal(mapWikipediaSearchResponse({
    query: {
      pages: {
        1: {
          index: 1,
          title: 'Relativity',
          extract: 'Relativity may refer to several concepts.',
          pageprops: { disambiguation: '' },
        },
        2: {
          index: 2,
          title: 'Empty result',
          extract: '',
        },
      },
    },
  }, 'en'), null);
});

test('rejects an approximate Wikipedia result for a free-text topic', () => {
  const data = {
    query: {
      pages: {
        7: {
          index: 1,
          title: 'Journal of Chemical Theory and Computation',
          extract: 'A scientific journal about theoretical chemistry.',
          fullurl: 'https://en.wikipedia.org/wiki/Journal_of_Chemical_Theory_and_Computation',
        },
      },
    },
  };

  assert.equal(mapWikipediaSearchResponse(data, 'en', {
    expectedTitle: 'Theory of computation',
    strictTitleMatch: true,
  }), null);
});

test('keeps an exact Wikipedia result for a free-text topic', () => {
  const result = mapWikipediaSearchResponse({
    query: {
      pages: {
        9: {
          index: 1,
          title: 'Theory of computation',
          extract: 'Theoretical computer science and mathematical logic.',
          fullurl: 'https://en.wikipedia.org/wiki/Theory_of_computation',
        },
      },
    },
  }, 'en', {
    expectedTitle: 'Theory of computation',
    strictTitleMatch: true,
  });

  assert.equal(result?.title, 'Theory of computation');
});

test('uses a localized canonical title for a major plural topic', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requestedSearches = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    requestedSearches.push(requestUrl.searchParams.get('gsrsearch'));
    const search = requestUrl.searchParams.get('gsrsearch');
    return {
      ok: true,
      async json() {
        return search === 'Black hole'
          ? {
              query: {
                pages: {
                  11: {
                    index: 1,
                    title: 'Black hole',
                    extract: 'A black hole is a region of spacetime where gravity is extremely strong.',
                    fullurl: 'https://en.wikipedia.org/wiki/Black_hole',
                    thumbnail: { source: 'https://upload.wikimedia.org/black-hole.jpg' },
                  },
                },
              },
            }
          : { query: { pages: {} } };
      },
    };
  };

  const result = await getEntityWikiInfo({
    title: 'Black holes',
    language: 'en',
    strictTitleMatch: true,
  });

  assert.deepEqual(requestedSearches, ['Black holes', 'Black hole']);
  assert.equal(result?.title, 'Black hole');
  assert.equal(result?.thumbnail, 'https://upload.wikimedia.org/black-hole.jpg');
});

/**
 * A prefetch from a topic pill and the explorer's own lookup must be ONE
 * request. Measured 2026-09-11: with two, the explorer waited on its copy
 * and the hero grew 171 px after the page had settled.
 */
test('two concurrent lookups of the same title share one request', async () => {
  const { getEntityWikiInfo } = await import('./wikiService.js');
  const originalFetch = globalThis.fetch;
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => { calls += 1; await gate; return { ok: true, json: async () => ({ query: { pages: { 1: { title: 'Shared Title Zeta', extract: 'x', index: 1 } } } }) }; };
  try {
    const a = getEntityWikiInfo({ title: 'Shared Title Zeta', language: 'en' });
    const b = getEntityWikiInfo({ title: 'Shared Title Zeta', language: 'en' });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1, 'the second lookup joined the first request');
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb, 'both callers get the same answer');
    await getEntityWikiInfo({ title: 'Shared Title Zeta', language: 'en' });
    assert.equal(calls, 1, 'and afterwards the cache answers');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
