import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getEntityWikiInfo,
  getEntityWikiInfoByIdentity,
  loadEntityWikiInfo,
  mapWikipediaSearchResponse,
  resolveEntityWikiIdentity,
  wikidataIdFromOpenAlexIds,
} from './wikiService.js';

// Shapes copied from real answers (2026-09-24): wbgetentities keys entities by
// QID ("-1" when a title is unknown), and the query API keys pages by pageid
// ("-1" when missing) and carries `pageprops.wikibase_item` after a redirect.
function wikidataEntity(qid, sitelinks) {
  return {
    entities: {
      [qid]: {
        type: 'item',
        id: qid,
        sitelinks: Object.fromEntries(Object.entries(sitelinks)
          .map(([site, title]) => [site, { site, title, badges: [] }])),
      },
    },
    success: 1,
  };
}

function wikipediaPage({ title, extract, qid, lang = 'en', thumbnail = null, pageid = 101 }) {
  return {
    batchcomplete: '',
    query: {
      pages: {
        [pageid]: {
          pageid,
          ns: 0,
          title,
          extract,
          ...(thumbnail ? { thumbnail: { source: thumbnail, width: 480, height: 300 } } : {}),
          contentmodel: 'wikitext',
          pagelanguage: lang,
          fullurl: `https://${lang}.wikipedia.org/wiki/${title.replace(/ /g, '_')}`,
          pageprops: { wikibase_item: qid },
        },
      },
    },
  };
}

// Answers by host + the parameter that identifies the question, and records
// every URL asked, so a test can prove which requests never happened.
function stubWikiFetch(t, routes) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requested = [];
  globalThis.fetch = async (url) => {
    const requestUrl = new URL(url);
    requested.push(requestUrl.toString());
    const route = routes.find(candidate => candidate.match(requestUrl));
    if (!route) return { ok: false, status: 404, async json() { return {}; } };
    return { ok: route.ok ?? true, status: route.ok === false ? 500 : 200, async json() { return route.body; } };
  };
  return requested;
}

const isWikidata = (params) => (url) => url.host === 'www.wikidata.org'
  && Object.entries(params).every(([key, value]) => url.searchParams.get(key) === value);
const isWikipediaTitle = (lang, title) => (url) => url.host === `${lang}.wikipedia.org`
  && url.searchParams.get('titles') === title;
const isWikipediaSearch = (lang) => (url) => url.host === `${lang}.wikipedia.org`
  && url.searchParams.get('generator') === 'search';

test('reads the Wikidata id OpenAlex gives in any of its three spellings', () => {
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'https://www.wikidata.org/wiki/Q16909647' }), 'Q16909647');
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'https://www.wikidata.org/entity/Q180445' }), 'Q180445');
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'http://www.wikidata.org/entity/Q162555' }), 'Q162555');
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'Q34433' }), 'Q34433');
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'https://example.org/Q1' }), '');
  assert.equal(wikidataIdFromOpenAlexIds({ wikidata: 'not an id' }), '');
  assert.equal(wikidataIdFromOpenAlexIds(null), '');
});

test('an OpenAlex entity is identified by its Wikidata id, a topic by its English article', () => {
  assert.deepEqual(
    resolveEntityWikiIdentity({ id: 'https://openalex.org/C2779256057', ids: { wikidata: 'https://www.wikidata.org/wiki/Q16909647' } }),
    { qid: 'Q16909647', enwikiTitle: '' },
  );
  assert.deepEqual(
    resolveEntityWikiIdentity({ id: 'https://openalex.org/T10336', ids: { wikipedia: 'https://en.wikipedia.org/wiki/Cancer_stem_cell' } }),
    { qid: '', enwikiTitle: 'Cancer stem cell' },
  );
  assert.deepEqual(
    resolveEntityWikiIdentity({ ids: { wikipedia: 'http://en.wikipedia.org/wiki/Schr%C3%B6dinger_equation' } }),
    { qid: '', enwikiTitle: 'Schrödinger equation' },
  );
  // A non-English article is not an identity the resolver can use.
  assert.equal(resolveEntityWikiIdentity({ ids: { wikipedia: 'https://fr.wikipedia.org/wiki/Cancer' } }), null);
  assert.equal(resolveEntityWikiIdentity({ id: 'https://openalex.org/I1', ids: {} }), null);
  assert.equal(resolveEntityWikiIdentity(null), null);
});

test('a concept with a Spanish article reads that article, found by identity and never by search', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q11190' }), body: wikidataEntity('Q11190', { enwiki: 'Medicine', eswiki: 'Medicina' }) },
    { match: isWikipediaTitle('es', 'Medicina'), body: wikipediaPage({ title: 'Medicina', extract: 'La medicina es la ciencia de la salud.', qid: 'Q11190', lang: 'es', thumbnail: 'https://upload.wikimedia.org/medicina.jpg' }) },
    { match: isWikipediaSearch('es'), body: wikipediaPage({ title: 'Medicine', extract: 'Medicine es una canción de Shakira.', qid: 'Q17040952', lang: 'es' }) },
  ]);

  const result = await getEntityWikiInfoByIdentity({ qid: 'Q11190', language: 'es' });

  assert.deepEqual(result, {
    title: 'Medicina',
    extract: 'La medicina es la ciencia de la salud.',
    thumbnail: 'https://upload.wikimedia.org/medicina.jpg',
    url: 'https://es.wikipedia.org/wiki/Medicina',
    language: 'es',
  });
  assert.equal(requested.some(url => url.includes('generator=search')), false);
});

test('without an article in the reader\'s language the English one is used and says so', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q16909647' }), body: wikidataEntity('Q16909647', { enwiki: 'Tumor progression' }) },
    { match: isWikipediaTitle('en', 'Tumor progression'), body: wikipediaPage({ title: 'Tumor progression', extract: 'Tumor progression is the third and last phase in tumor development.', qid: 'Q16909647' }) },
  ]);

  const result = await getEntityWikiInfoByIdentity({ qid: 'Q16909647', language: 'es' });

  assert.equal(result?.title, 'Tumor progression');
  assert.equal(result?.language, 'en');
});

test('a topic known only by its English article is translated through Wikidata', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ sites: 'enwiki', titles: 'Cancer stem cell' }), body: wikidataEntity('Q1638475', { enwiki: 'Cancer stem cell', eswiki: 'Célula madre cancerosa' }) },
    { match: isWikipediaTitle('es', 'Célula madre cancerosa'), body: wikipediaPage({ title: 'Célula madre cancerosa', extract: 'Las células madre cancerosas son células tumorales.', qid: 'Q1638475', lang: 'es' }) },
  ]);

  const result = await getEntityWikiInfoByIdentity({ enwikiTitle: 'Cancer stem cell', language: 'es' });

  assert.equal(result?.title, 'Célula madre cancerosa');
  assert.equal(result?.language, 'es');
});

test('a page that turns out to describe something else is refused', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q424242' }), body: wikidataEntity('Q424242', { eswiki: 'Algo' }) },
    // The title now redirects to another item: the photo and the text would be
    // someone else's.
    { match: isWikipediaTitle('es', 'Algo'), body: wikipediaPage({ title: 'Otra cosa', extract: 'Un artículo sobre otra cosa.', qid: 'Q999', lang: 'es' }) },
  ]);

  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q424242', language: 'es' }), null);
});

test('an unknown title, a missing page or a failed call give no box', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ sites: 'enwiki', titles: 'Nothing here' }), body: { entities: { '-1': { site: 'enwiki', title: 'Nothing here', missing: '' } }, success: 1 } },
    { match: isWikidata({ ids: 'Q515151' }), body: wikidataEntity('Q515151', { enwiki: 'Gone' }) },
    { match: isWikipediaTitle('en', 'Gone'), body: { batchcomplete: '', query: { pages: { '-1': { ns: 0, title: 'Gone', missing: '' } } } } },
    { match: isWikidata({ ids: 'Q616161' }), ok: false, body: {} },
  ]);

  assert.equal(await getEntityWikiInfoByIdentity({ enwikiTitle: 'Nothing here', language: 'en' }), null);
  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q515151', language: 'en' }), null);
  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q616161', language: 'en' }), null);
});

test('the Explorer\'s loader resolves an OpenAlex concept by identity, not by the first search hit', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q16909648' }), body: wikidataEntity('Q16909648', { enwiki: 'Tumor progression' }) },
    { match: isWikipediaTitle('en', 'Tumor progression'), body: wikipediaPage({ title: 'Tumor progression', extract: 'Tumor progression is the third and last phase in tumor development.', qid: 'Q16909648' }) },
    { match: isWikipediaSearch('es'), body: wikipediaPage({ title: 'Allan Balmain', extract: 'Allan Balmain FRS es un profesor distinguido de Genética del Cáncer.', qid: 'Q20031714', lang: 'es', thumbnail: 'https://upload.wikimedia.org/balmain.jpg' }) },
  ]);

  const result = await loadEntityWikiInfo({
    entity: { id: 'https://openalex.org/C2779256057', display_name: 'Tumor progression', ids: { wikidata: 'https://www.wikidata.org/wiki/Q16909648' } },
    title: 'Tumor progression',
    language: 'es',
  });

  assert.equal(result?.title, 'Tumor progression');
  assert.equal(result?.language, 'en');
  assert.equal(requested.some(url => url.includes('generator=search')), false);
});

test('the Explorer\'s loader shows nothing for an OpenAlex entity without an identity', async (t) => {
  const requested = stubWikiFetch(t, []);

  const result = await loadEntityWikiInfo({
    entity: { id: 'https://openalex.org/I12345', display_name: 'Some Institute', ids: {} },
    title: 'Some Institute',
    language: 'es',
  });

  assert.equal(result, null);
  assert.deepEqual(requested, []);
});

test('the Explorer\'s loader keeps the exact-title search for a free-text topic', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikipediaSearch('en'), body: wikipediaPage({ title: 'Journal of Theory of Stuff', extract: 'A journal.', qid: 'Q1' }) },
  ]);

  const result = await loadEntityWikiInfo({
    entity: { id: 'q-theory-of-stuff', display_name: 'Theory of stuff', _queryTopic: true },
    title: 'Theory of stuff',
    language: 'en',
  });

  assert.equal(result, null);
  assert.equal(requested.length > 0 && requested.every(url => url.includes('generator=search')), true);
});

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
