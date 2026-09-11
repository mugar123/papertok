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
