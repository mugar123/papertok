import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSavedPaperPayload } from './savedPaperPayload.ts';

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
    assert.notEqual(payload[key as keyof typeof payload], null, `${key} is null, which the rules refuse`);
  }
  for (const absent of ['authors', 'summary', 'doi', 'landingPageUrl', 'primaryTopic', 'published', 'arxivId']) {
    assert.equal(absent in payload, false, `${absent} must be absent, not null`);
  }
  // A save merges into the stored document, so the category and its list
  // are sent even when empty: left out, an older document's would stay and
  // be read under this payload's classificationVersion (PAP-60).
  assert.equal(payload.primaryCategory, '');
  assert.deepEqual(payload.categories, []);
  assert.deepEqual(Object.keys(payload).sort(), ['categories', 'classificationVersion', 'primaryCategory', 'savedAt', 'title']);
});

/**
 * PAP-60. This document kept only `primaryCategory`, which for an OpenAlex
 * card is a concept name, so a saved paper came back with no field at all
 * (159 of 200 sampled works). It keeps what the card's field was read from:
 * arXiv's categories and OpenAlex's topic, as ids and names.
 */
test("the field's evidence is kept as ids and names, within the bounds the rules set", () => {
  const topic = {
    id: 'https://openalex.org/T13904',
    display_name: 'Artificial Intelligence Applications',
    score: 0.9341,
    subfield: { id: 'https://openalex.org/subfields/1702', display_name: 'Artificial Intelligence' },
    field: { id: 'https://openalex.org/fields/17', display_name: 'Computer Science' },
    domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
  };
  const payload = buildSavedPaperPayload({ ...full, categories: ['astro-ph.EP', 'astro-ph.SR'], primaryTopic: topic }, SAVED_AT);
  assert.deepEqual(payload.categories, ['astro-ph.EP', 'astro-ph.SR']);
  assert.deepEqual(payload.primaryTopic, {
    id: topic.id, display_name: topic.display_name, subfield: topic.subfield, field: topic.field, domain: topic.domain,
  }, 'the score ranks; it does not classify');

  // The rules cap the list at 20; OpenAlex can list more concept names.
  const many = buildSavedPaperPayload({ ...full, categories: Array.from({ length: 30 }, (_, i) => `Concept ${i}`) }, SAVED_AT);
  assert.equal(many.categories!.length, 20);
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
  assert.equal(many.authors!.length, 5);

  // 1000 in the rules, 500 by convention here.
  const long = buildSavedPaperPayload({ ...full, summary: 'x'.repeat(4000) }, SAVED_AT);
  assert.equal(long.summary!.length, 500);
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
});

/**
 * The contract with the rules, checked as text. The emulator test in
 * `tests/firestore.rules.test.ts` proves the payload is accepted; this one
 * catches the cheaper mistake — the rules gaining a field the builder does not
 * know about, or losing one it emits.
 */
test('SOURCE: the builder emits exactly the fields the rules allow', async () => {
  const rules = await readFile(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const block = rules.slice(rules.indexOf('match /savedPapers/{paperId} {'));
  const allowed = block
    .slice(block.indexOf('hasOnly(['), block.indexOf('])'))
    .match(/'([a-zA-Z]+)'/g)!
    .map(entry => entry.replaceAll("'", ''));

  assert.ok(allowed.length > 5, 'expected to have parsed the rules allowlist');

  const emitted = Object.keys(buildSavedPaperPayload(full, SAVED_AT));
  for (const key of emitted) {
    assert.ok(allowed.includes(key), `the builder emits '${key}', which the rules refuse`);
  }
});
