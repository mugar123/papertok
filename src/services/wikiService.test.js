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

test('a concept reads its English article, found by identity and never by search', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q11190' }), body: wikidataEntity('Q11190', { enwiki: 'Medicine', eswiki: 'Medicina' }) },
    { match: isWikipediaTitle('en', 'Medicine'), body: wikipediaPage({ title: 'Medicine', extract: 'Medicine is the science of health.', qid: 'Q11190', thumbnail: 'https://upload.wikimedia.org/medicine.jpg' }) },
    { match: isWikipediaSearch('en'), body: wikipediaPage({ title: 'Medicine (song)', extract: 'Medicine is a song by Shakira.', qid: 'Q17040952' }) },
  ]);

  const result = await getEntityWikiInfoByIdentity({ qid: 'Q11190' });

  assert.deepEqual(result, {
    title: 'Medicine',
    extract: 'Medicine is the science of health.',
    thumbnail: 'https://upload.wikimedia.org/medicine.jpg',
    url: 'https://en.wikipedia.org/wiki/Medicine',
    language: 'en',
  });
  assert.equal(requested.some(url => url.includes('generator=search')), false);
});

test('an item without an English article gives no box', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q7654321' }), body: wikidataEntity('Q7654321', { eswiki: 'Solo en español' }) },
  ]);

  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q7654321' }), null);
  assert.equal(requested.some(url => url.includes('wikipedia.org')), false);
});

test('a topic known only by its English article is resolved through Wikidata', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ sites: 'enwiki', titles: 'Cancer stem cell' }), body: wikidataEntity('Q1638475', { enwiki: 'Cancer stem cell', eswiki: 'Célula madre cancerosa' }) },
    { match: isWikipediaTitle('en', 'Cancer stem cell'), body: wikipediaPage({ title: 'Cancer stem cell', extract: 'Cancer stem cells are cancer cells that possess characteristics of normal stem cells.', qid: 'Q1638475' }) },
  ]);

  const result = await getEntityWikiInfoByIdentity({ enwikiTitle: 'Cancer stem cell' });

  assert.equal(result?.title, 'Cancer stem cell');
  assert.equal(result?.language, 'en');
});

test('a page that turns out to describe something else is refused', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q424242' }), body: wikidataEntity('Q424242', { enwiki: 'Something' }) },
    // The title now redirects to another item: the photo and the text would be
    // someone else's.
    { match: isWikipediaTitle('en', 'Something'), body: wikipediaPage({ title: 'Something else', extract: 'An article about something else.', qid: 'Q999' }) },
  ]);

  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q424242' }), null);
});

test('an unknown title, a missing page or a failed call give no box', async (t) => {
  stubWikiFetch(t, [
    { match: isWikidata({ sites: 'enwiki', titles: 'Nothing here' }), body: { entities: { '-1': { site: 'enwiki', title: 'Nothing here', missing: '' } }, success: 1 } },
    { match: isWikidata({ ids: 'Q515151' }), body: wikidataEntity('Q515151', { enwiki: 'Gone' }) },
    { match: isWikipediaTitle('en', 'Gone'), body: { batchcomplete: '', query: { pages: { '-1': { ns: 0, title: 'Gone', missing: '' } } } } },
    { match: isWikidata({ ids: 'Q616161' }), ok: false, body: {} },
  ]);

  assert.equal(await getEntityWikiInfoByIdentity({ enwikiTitle: 'Nothing here' }), null);
  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q515151' }), null);
  assert.equal(await getEntityWikiInfoByIdentity({ qid: 'Q616161' }), null);
});

test('the Explorer\'s loader resolves an OpenAlex concept by identity, not by the first search hit', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikidata({ ids: 'Q16909648' }), body: wikidataEntity('Q16909648', { enwiki: 'Tumor progression' }) },
    { match: isWikipediaTitle('en', 'Tumor progression'), body: wikipediaPage({ title: 'Tumor progression', extract: 'Tumor progression is the third and last phase in tumor development.', qid: 'Q16909648' }) },
    { match: isWikipediaSearch('en'), body: wikipediaPage({ title: 'Allan Balmain', extract: 'Allan Balmain FRS is a distinguished professor of cancer genetics.', qid: 'Q20031714', thumbnail: 'https://upload.wikimedia.org/balmain.jpg' }) },
  ]);

  const result = await loadEntityWikiInfo({
    entity: { id: 'https://openalex.org/C2779256057', display_name: 'Tumor progression', ids: { wikidata: 'https://www.wikidata.org/wiki/Q16909648' } },
    title: 'Tumor progression',
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
  });

  assert.equal(result, null);
  assert.equal(requested.length > 0 && requested.every(url => url.includes('generator=search')), true);
});

// The taxonomy's own topics carry no Wikidata id, so their curated labels are
// searched; a first hit that is some other article is a guess, and a missing
// box beats a wrong one (AGENTS.md, invariant 3; review of 2026-09-25).
test('the Explorer\'s loader keeps the exact-title search for a PaperTok topic too', async (t) => {
  const requested = stubWikiFetch(t, [
    { match: isWikipediaSearch('en'), body: wikipediaPage({ title: 'Matter', extract: 'Matter is any substance that has mass and takes up space.', qid: 'Q35758' }) },
  ]);

  const result = await loadEntityWikiInfo({
    entity: { id: 'cond-mat.soft', display_name: 'Soft Condensed Matter', _localTopic: true },
    title: 'Soft Condensed Matter',
  });

  assert.equal(result, null);
  assert.equal(requested.length > 0 && requested.every(url => url.includes('generator=search')), true);
});

test('maps an English Wikipedia search result', () => {
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
  });

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
  }), null);
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

  assert.equal(mapWikipediaSearchResponse(data, {
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
  }, {
    expectedTitle: 'Theory of computation',
    strictTitleMatch: true,
  });

  assert.equal(result?.title, 'Theory of computation');
});

test('uses a canonical title for a major plural topic', async (t) => {
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
    strictTitleMatch: true,
  });

  assert.deepEqual(requestedSearches, ['Black holes', 'Black hole']);
  assert.equal(result?.title, 'Black hole');
  assert.equal(result?.thumbnail, 'https://upload.wikimedia.org/black-hole.jpg');
});
