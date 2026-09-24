import test from 'node:test';
import assert from 'node:assert/strict';
import { parseShareSeed, publicPaperMetadata, readShareSeed, SHARE_SEED_ELEMENT_ID } from './shareSeed.js';

const KEY = 'ZG9pOjEwLjExNDUvMzU1NTE3NA';
const PAPER = Object.freeze({
  id: 'doi:10.1145/3555174',
  title: 'On commensurations of pro-$\\mathcal{C}$ groups',
  abstract: 'We study how video creators earn money outside the advertising program of the platform.',
  authors: [{ name: 'Yiqing Hua' }],
  doi: '10.1145/3555174',
});
const SEED = JSON.stringify({ key: KEY, paper: PAPER });

// The document a crawler got from the Worker (worker/share-pages.js) carries
// the paper; only a crawler that runs JavaScript — Googlebot — reads it, and
// the API it would otherwise load from is closed to it by robots.txt.

test('a seed is read only for the key it names', () => {
  assert.deepEqual(parseShareSeed(SEED, KEY), PAPER);
  assert.equal(parseShareSeed(SEED, 'YXJ4aXY6MjYwOS4yODQ3MA'), null, 'another paper\'s seed never dresses this one');
  assert.equal(parseShareSeed(SEED, ''), null);
});

test('a malformed or empty seed is no seed', () => {
  assert.equal(parseShareSeed('{not json', KEY), null);
  assert.equal(parseShareSeed('', KEY), null);
  assert.equal(parseShareSeed(null, KEY), null);
  assert.equal(parseShareSeed(JSON.stringify({ key: KEY, paper: null }), KEY), null);
  assert.equal(parseShareSeed(JSON.stringify({ key: KEY, paper: { ...PAPER, title: '  ' } }), KEY), null);
  assert.equal(parseShareSeed(JSON.stringify({ paper: PAPER }), KEY), null);
  assert.equal(parseShareSeed(JSON.stringify([SEED]), KEY), null);
});

test('the seed is read from the element the Worker writes it into', () => {
  const documentWith = element => ({ getElementById: id => (id === SHARE_SEED_ELEMENT_ID ? element : null) });
  assert.equal(SHARE_SEED_ELEMENT_ID, 'papertok-share-seed');
  assert.deepEqual(readShareSeed(KEY, documentWith({ textContent: SEED })), PAPER);
  assert.equal(readShareSeed(KEY, documentWith(null)), null);
  assert.equal(readShareSeed(KEY, undefined), null);
});

test('a page with a paper is indexable, and its head reads as plain text', () => {
  const metadata = publicPaperMetadata(PAPER, `/public/paper/${KEY}`);
  assert.equal(metadata.noIndex, undefined);
  assert.deepEqual(metadata.title, { es: 'On commensurations of pro-C groups', en: 'On commensurations of pro-C groups' });
  assert.equal(metadata.description.en, PAPER.abstract);
  assert.equal(metadata.route, `/public/paper/${KEY}`);
  assert.equal(metadata.ogType, 'article');
});

test('only a page with no paper yet is kept out of an index', () => {
  assert.deepEqual(publicPaperMetadata(null, `/public/paper/${KEY}`), { route: `/public/paper/${KEY}`, noIndex: true });
});
