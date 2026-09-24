import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorExplorerPath, openAlexAuthorId } from './explorerPaths.js';

test('an author with an OpenAlex id opens by id, name riding along for the masthead', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A5023888391' }, 'openalex:W1'),
    '/explorer/author/A5023888391?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada', id: 'a5023888391' }, 'x'), '/explorer/author/A5023888391?name=Ada', 'a bare id, any case');
  assert.equal(openAlexAuthorId({ id: 'https://openalex.org/I123' }), '', 'an institution id is not an author');
});

test('an author without an id keeps the name door, with the arXiv id the explorer matches on', () => {
  assert.equal(authorExplorerPath({ name: 'Grace Hopper' }, 'arxiv:2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345');
  assert.equal(authorExplorerPath('Grace Hopper', '2401.12345'), '/explorer/author/Grace%20Hopper?arxivId=2401.12345', 'a plain string author');
  assert.equal(authorExplorerPath({ name: '' }, 'x'), '', 'nothing to open');
});

test('signed out, the public entity page gets the id when there is one, and the name beside it', () => {
  assert.equal(
    authorExplorerPath({ name: 'Ada Lovelace', id: 'https://openalex.org/A1' }, 'x', { publicMode: true }),
    '/public/entity/author/A1?name=Ada%20Lovelace',
  );
  assert.equal(authorExplorerPath({ name: 'Ada Lovelace' }, 'x', { publicMode: true }), '/public/entity/author/Ada%20Lovelace');
});

test('SOURCE: every author link on the card goes through the helper', async () => {
  const jsx = await readFile(new URL('../components/Feed/PaperCard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(jsx, /\/explorer\/author\/\$\{encodeURIComponent\(/, 'no card builds a name-only author path by hand anymore');
  assert.ok((jsx.match(/authorExplorerPath\(/g) || []).length >= 2, 'both author lists use it');
});

// PubMed and Europe PMC authors arrive without an OpenAlex id, and the card
// used to hand the paper's `pmid:…` id over as an "arXiv id" the explorer
// turned into an impossible `10.48550/arxiv.pmid:…` DOI; the name search it
// fell back to picked "Po-Wn Li" for "Li WN" (audit 2026-09-23, issue 4).
test('an author with an ORCID and no OpenAlex id opens by ORCID', () => {
  assert.equal(
    authorExplorerPath({ name: 'Li WN', orcid: 'https://orcid.org/0000-0002-1825-0097' }, { id: 'pmid:42774036', pmid: '42774036' }),
    '/explorer/author/0000-0002-1825-0097?name=Li%20WN',
  );
  assert.equal(
    authorExplorerPath({ name: 'Li WN', orcid: '0000-0002-1825-009X' }, {}, { publicMode: true }),
    '/public/entity/author/0000-0002-1825-009X?name=Li%20WN',
  );
});

test('a name-only author carries the paper it was clicked from, by its most reliable id', () => {
  const editorial = { id: 'pmid:42774036', pmid: '42774036', doi: '10.3389/fendo.2026.1980821' };
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, editorial),
    '/explorer/author/Li%20WN?paper=doi%3A10.3389%2Ffendo.2026.1980821',
  );
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, { id: 'pmid:42774036', pmid: '42774036' }),
    '/explorer/author/Li%20WN?paper=pmid%3A42774036',
  );
  assert.equal(
    authorExplorerPath({ name: 'Grace Hopper' }, { id: '2401.12345', arxivId: '2401.12345' }),
    '/explorer/author/Grace%20Hopper?arxivId=2401.12345',
  );
  assert.equal(authorExplorerPath({ name: 'Li WN' }, 'pmid:42774036'), '/explorer/author/Li%20WN?paper=pmid%3A42774036');
  assert.equal(authorExplorerPath({ name: 'Nobody' }, { id: 'europepmc:PPR:1' }), '/explorer/author/Nobody');
});

test('signed out, the name-only door keeps the paper too', () => {
  assert.equal(
    authorExplorerPath({ name: 'Li WN' }, { id: 'pmid:42774036', pmid: '42774036' }, { publicMode: true }),
    '/public/entity/author/Li%20WN?paper=pmid%3A42774036',
  );
});
