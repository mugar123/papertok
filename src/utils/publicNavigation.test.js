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
