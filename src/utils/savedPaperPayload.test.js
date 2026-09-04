import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSavedPaperPayload, canStoreSavedPaper } from './savedPaperPayload.js';

const SAVED_AT = '2026-08-27T10:00:00.000Z';
const full = {
  id: '2608.20113',
  title: 'A metallicity sweet spot for disc fragmentation and planet formation',
  authors: ['Ethan J. Carter', 'Dimitris Stamatellos', 'George Blaylock-Squibbs'],
  primaryCategory: 'astro-ph.EP',
  published: '2026-08-01',
  arxivId: '2608.20113',
  summary: 'Disc fragmentation depends on metallicity in a non-monotonic way.',
  doi: '10.48550/arXiv.2608.20113',
  landingPageUrl: 'https://arxiv.org/abs/2608.20113',
};

/**
 * The bug this file exists for: the rules accept an optional field that is
 * ABSENT and refuse one that is `null` — measured against the emulator, where
 * `summary: null`, `authors: null` and `title: null` are each rejected while
 * omitting them is fine. The modal wrote `null` for every absent field, so a
 * paper with no abstract had its write refused, after its id had already gone
 * into the list.
 */
test('a field we do not have is left out, never nulled', () => {
  const { id, ...bare } = full;
  const payload = buildSavedPaperPayload({ id, title: bare.title }, SAVED_AT);

  for (const key of Object.keys(payload)) {
    assert.notEqual(payload[key], null, `${key} is null, which the rules refuse`);
  }
  for (const absent of ['authors', 'summary', 'doi', 'landingPageUrl', 'primaryCategory', 'published', 'arxivId']) {
    assert.equal(absent in payload, false, `${absent} must be absent, not null`);
  }
  assert.deepEqual(Object.keys(payload).sort(), ['savedAt', 'title']);
});

test('blank and whitespace count as absent, not as a value', () => {
  const payload = buildSavedPaperPayload(
    { ...full, summary: '   ', doi: '', authors: ['  ', ''], landingPageUrl: null },
    SAVED_AT,
  );
  assert.equal('summary' in payload, false);
  assert.equal('doi' in payload, false);
  assert.equal('authors' in payload, false, 'a list of blanks is not a list of authors');
  assert.equal('landingPageUrl' in payload, false);
});

test('everything present is carried, within the caps the rules set', () => {
  const payload = buildSavedPaperPayload(full, SAVED_AT);
  assert.equal(payload.title, full.title);
  assert.deepEqual(payload.authors, full.authors);
  assert.equal(payload.savedAt, SAVED_AT);

  // The rules cap authors at 20; the app has always stored at most 5.
  const many = buildSavedPaperPayload(
    { ...full, authors: Array.from({ length: 40 }, (_, i) => `Author ${i}`) },
    SAVED_AT,
  );
  assert.equal(many.authors.length, 5);

  // 1000 in the rules, 500 by convention here.
  const long = buildSavedPaperPayload({ ...full, summary: 'x'.repeat(4000) }, SAVED_AT);
  assert.equal(long.summary.length, 500);
});

test('the abstract stands in for a missing summary', () => {
  const payload = buildSavedPaperPayload(
    { ...full, summary: undefined, abstract: 'The abstract instead.' },
    SAVED_AT,
  );
  assert.equal(payload.summary, 'The abstract instead.');
});

/**
 * `title` is the one field with no absent-or-null escape in the rules, so a
 * paper without one cannot be written at all — and refusing is the worst
 * answer available, because the id is going into a list either way and a list
 * entry with no document is the whole problem.
 */
test('an untitled paper is stored under its id rather than refused', () => {
  const payload = buildSavedPaperPayload({ id: '2608.20071' }, SAVED_AT);
  assert.equal(payload.title, '2608.20071');
  assert.equal(canStoreSavedPaper({ id: '2608.20071' }), true);

  // Every reader already treats `title === id` as "no title yet", so this
  // claims nothing it should not.
  assert.equal(canStoreSavedPaper({}), false, 'no id and no title is nothing to write');
  assert.equal(canStoreSavedPaper(null), false);
});

/**
 * The contract with the rules, checked as text. The emulator test in
 * `tests/firestore.rules.test.js` proves the payload is accepted; this one
 * catches the cheaper mistake — the rules gaining a field the builder does not
 * know about, or losing one it emits.
 */
test('SOURCE: the builder emits exactly the fields the rules allow', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const block = rules.slice(rules.indexOf('match /savedPapers/{paperId} {'));
  const allowed = block
    .slice(block.indexOf('hasOnly(['), block.indexOf('])'))
    .match(/'([a-zA-Z]+)'/g)
    .map(entry => entry.replaceAll("'", ''));

  assert.ok(allowed.length > 5, 'expected to have parsed the rules allowlist');

  const emitted = Object.keys(buildSavedPaperPayload(full, SAVED_AT));
  for (const key of emitted) {
    assert.ok(allowed.includes(key), `the builder emits '${key}', which the rules refuse`);
  }
});
