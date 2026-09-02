import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePaperKey,
  getAbsoluteShareUrl,
  getHashRoute,
  getPublicEntityPath,
  getPublicEntityUrl,
  getPublicPaperPath,
  getPublicPaperUrl,
  getPublicProfilePath,
  getPublicProfileUrl,
  getSharedListPath,
  getSharedListUrl,
  getSiteRootUrl,
  getViteBasePath,
  parsePaperKey,
  encodePaperKey,
} from './publicNavigation.js';

const URL_OPTIONS = { origin: 'https://example.test', base: '/papertok/' };

test('normalizes Vite base paths for project-site roots', () => {
  assert.equal(getViteBasePath('/papertok'), '/papertok/');
  assert.equal(getViteBasePath('https://example.test/papertok/'), '/papertok/');
  assert.equal(getViteBasePath('./'), '/');
  assert.equal(getSiteRootUrl(URL_OPTIONS), 'https://example.test/papertok/');
});

test('builds HashRouter-compatible entity routes with encoded path segments', () => {
  const path = getPublicEntityPath({
    type: 'author',
    canonicalId: 'https://orcid.org/0000-0001/2345',
  });

  assert.equal(path, '/public/entity/author/https%3A%2F%2Forcid.org%2F0000-0001%2F2345');
  assert.equal(getHashRoute(path), '#/public/entity/author/https%3A%2F%2Forcid.org%2F0000-0001%2F2345');
  assert.equal(getPublicEntityPath('not-an-entity', 'id'), null);
});

test('encodes DOI and arXiv identities into reversible URL-safe paper keys', () => {
  const doiKey = encodePaperKey({ doi: 'https://doi.org/10.1000/ABC.123' });
  const arxivKey = encodePaperKey({ arxivId: 'https://arxiv.org/abs/2401.12345v2' });

  assert.match(doiKey, /^[A-Za-z0-9_-]+$/);
  assert.match(arxivKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(decodePaperKey(doiKey), 'doi:10.1000/abc.123');
  assert.equal(decodePaperKey(arxivKey), 'arxiv:2401.12345v2');
  assert.deepEqual(parsePaperKey(arxivKey), { type: 'arxiv', value: '2401.12345v2' });
  assert.equal(decodePaperKey(`${doiKey}!`), null);
});

test('prefers DOI identity and places paper keys in public router paths', () => {
  const path = getPublicPaperPath({
    doi: '10.5555/Some.DOI',
    arxivId: '2401.12345',
  });

  const key = encodePaperKey({ doi: '10.5555/Some.DOI' });
  assert.equal(path, `/public/paper/${key}`);
  assert.equal(getPublicPaperPath({ title: 'No stable identifier' }), null);
});

/**
 * The Liked tab is keyed by the feed's `paper.id`, and for an OpenAlex or
 * PubMed card that id is `openalex:W…` or `pmid:…` with no DOI stored beside
 * it. Those rows rendered as plain labels because nothing here could name a
 * page for them. Both ids open through OpenAlex, so both are identities.
 */
test('keys OpenAlex work ids and PubMed ids so provider-keyed likes can link', () => {
  const openAlexKey = encodePaperKey('openalex:w2741809807');
  assert.equal(decodePaperKey(openAlexKey), 'openalex:W2741809807');
  assert.deepEqual(parsePaperKey(openAlexKey), { type: 'openalex', value: 'W2741809807' });
  assert.equal(encodePaperKey('W2741809807'), openAlexKey, 'the bare id OpenAlex-built papers carry');
  assert.equal(encodePaperKey('https://openalex.org/W2741809807'), openAlexKey, 'the URL form the API returns');
  assert.equal(encodePaperKey({ id: 'openalex:W2741809807', doi: '', arxivId: '' }), openAlexKey,
    'a like serialized from its stored title has empty DOI and arXiv fields');
  assert.equal(getPublicPaperPath('openalex:W2741809807'), `/public/paper/${openAlexKey}`);
  assert.equal(getPublicPaperPath('openalex', 'W2741809807'), `/public/paper/${openAlexKey}`);

  const pmidKey = encodePaperKey('pmid:31234567');
  assert.equal(decodePaperKey(pmidKey), 'pmid:31234567');
  assert.deepEqual(parsePaperKey(pmidKey), { type: 'pmid', value: '31234567' });
  assert.equal(encodePaperKey('https://pubmed.ncbi.nlm.nih.gov/31234567/'), pmidKey);
  assert.equal(encodePaperKey({ id: 'pmid:31234567' }), pmidKey);
  assert.equal(encodePaperKey({ pmid: '31234567' }), pmidKey, 'a PubMed paper names its pmid as a field too');
});

test('a DOI or arXiv id still outranks the provider id the paper was keyed by', () => {
  assert.equal(
    encodePaperKey({ id: 'openalex:W2741809807', doi: '10.5555/Some.DOI' }),
    encodePaperKey({ doi: '10.5555/some.doi' }),
  );
  assert.equal(
    encodePaperKey({ id: 'pmid:31234567', arxivId: '2401.12345' }),
    encodePaperKey({ arxivId: '2401.12345' }),
  );
});

test('an id nobody can open is still no key at all', () => {
  assert.equal(encodePaperKey('31234567'), null, 'a bare number is not taken for a PubMed id');
  assert.equal(encodePaperKey('pmid:abc'), null);
  assert.equal(encodePaperKey('openalex:A2741809807'), null, 'an author id is not a work');
  assert.equal(encodePaperKey('openalex:W'), null);
  assert.equal(encodePaperKey('scopus:85012345678'), null);
  assert.equal(encodePaperKey('649def34f8be52c8b66281af98ae884c09aef38b'), null, 'a Semantic Scholar hash');
  assert.equal(getPublicPaperPath('openalex', 'not-a-work'), null);
  assert.equal(getPublicPaperPath('pmid', '12a'), null);
});

test('builds shared-list paths and absolute share URLs with the Vite base', () => {
  assert.equal(getSharedListPath('list/with spaces'), '/public/list/list%2Fwith%20spaces');
  assert.equal(
    getPublicEntityUrl('topic', 'astro-ph.CO', URL_OPTIONS),
    'https://example.test/papertok/#/public/entity/topic/astro-ph.CO',
  );
  assert.equal(
    getPublicPaperUrl({ arxivId: '2401.12345' }, undefined, URL_OPTIONS),
    `https://example.test/papertok/#/public/paper/${encodePaperKey({ arxivId: '2401.12345' })}`,
  );
  assert.equal(
    getPublicPaperUrl({ arxivId: '2401.12345' }, URL_OPTIONS),
    `https://example.test/papertok/#/public/paper/${encodePaperKey({ arxivId: '2401.12345' })}`,
  );
  assert.equal(
    getSharedListUrl('reading-list', URL_OPTIONS),
    'https://example.test/papertok/#/public/list/reading-list',
  );
  assert.equal(
    getAbsoluteShareUrl('/public/entity/topic/astro-ph.CO', URL_OPTIONS),
    'https://example.test/papertok/#/public/entity/topic/astro-ph.CO',
  );
});

test('builds a public profile path from a handle or a profile', () => {
  assert.equal(getPublicProfilePath('ada'), '/public/user/ada');
  assert.equal(getPublicProfilePath('  @Ada_Lovelace '), '/public/user/ada_lovelace');
  assert.equal(getPublicProfilePath({ handle: 'ADA' }), '/public/user/ada');
});

test('refuses to build a profile path for a handle the rules would reject', () => {
  // A link to a reserved handle would shadow an application route, and a link
  // to an invalid one would 404 after costing a Firestore read.
  for (const handle of ['settings', 'admin', 'api', 'ada lovelace', '../admin', 'ab', '']) {
    assert.equal(getPublicProfilePath(handle), null, `${handle} must not become a link`);
  }
  assert.equal(getPublicProfilePath(null), null);
  assert.equal(getPublicProfileUrl('admin'), null);
});

test('a profile URL is absolute and hash-routed like every other share link', () => {
  const url = getPublicProfileUrl('ada', { origin: 'https://example.test', base: '/papertok/' });
  assert.equal(url, 'https://example.test/papertok/#/public/user/ada');
});
