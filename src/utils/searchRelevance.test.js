/**
 * Section ordering, with people in the mix.
 *
 * The merged search does not interleave results: OpenAlex returns its own
 * relevance ranking and Firestore returns lexicographic order on a prefix, and
 * there is no honest way to compare a paper's score against a handle's. So
 * people are a section like the other five, and the only question this file
 * answers is which section goes first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRelevantSearchResults,
  getSearchSectionOrder,
  resolvePreferredSearchSection,
  scoreSearchMatch,
} from './searchRelevance.js';

// --- scoring and filtering, from before people joined the page --------------

test('keeps exact and complete institution matches ahead of fuzzy noise', () => {
  const results = [
    { name: 'Malaria No More' },
    { name: 'University of Salamanca' },
    { name: 'Pontifical University of Salamanca' },
    { name: 'Salamanca City Council' },
  ];

  const filtered = filterRelevantSearchResults(
    'University of Salamanca',
    results,
    result => [result.name],
  );

  assert.deepEqual(filtered.map(result => result.name), [
    'University of Salamanca',
    'Pontifical University of Salamanca',
  ]);
});

test('rejects partial person-name matches masquerading as institutions', () => {
  assert.equal(scoreSearchMatch('Geoffrey Hinton', ['Hinton Area Foundation']), 35);
  assert.deepEqual(
    filterRelevantSearchResults(
      'Geoffrey Hinton',
      [{ name: 'Hinton Area Foundation' }, { name: 'Geoffrey Beene Foundation' }],
      result => [result.name],
    ),
    [],
  );
});

test('promotes the exact topic or the intent of a suggested search', () => {
  const sectionValues = {
    papers: ['A paper about cosmology'],
    topics: ['Cosmology'],
    institutions: ['Astroparticle and Cosmology Laboratory'],
    projects: ['Cosmology survey'],
  };

  assert.equal(resolvePreferredSearchSection({
    query: 'Cosmology',
    sectionValues,
  }), 'topics');
  assert.equal(resolvePreferredSearchSection({
    query: 'Cosmology',
    hint: 'projects',
    sectionValues,
  }), 'projects');
  assert.ok(
    getSearchSectionOrder('topics', 'topics')
      < getSearchSectionOrder('institutions', 'topics'),
  );
});

test('defaults a general scientific query to papers', () => {
  assert.equal(resolvePreferredSearchSection({
    query: 'CRISPR Cas9',
    sectionValues: {
      papers: ['CRISPR-Cas9 genome editing'],
      projects: ['CRISPR programme'],
    },
  }), 'papers');
});

// --- section ordering with people in the mix -------------------------------

/** Every section populated, so ordering is the only thing under test. */
const populated = (overrides = {}) => ({
  papers: ['Numerical relativity of binary mergers'],
  users: ['nick_mugar', 'nicolás muñoz garcía'],
  topics: ['Cosmology'],
  authors: ['Geoffrey Hinton'],
  institutions: ['Massachusetts Institute of Technology'],
  projects: ['HORIZON'],
  ...overrides,
});

test('a section missing from the default order sinks to the bottom forever', () => {
  // The trap this file exists to keep shut: getSearchSectionOrder scores an
  // unknown section 99, so adding a section to the page without adding it here
  // makes it last on every search, silently and permanently.
  assert.ok(
    getSearchSectionOrder('users', null) < getSearchSectionOrder('nonsense', null),
    'users must be a known section, not a stranger scored 99',
  );
});

test('by default people come after papers, not before them', () => {
  // A two-letter prefix matches somebody by accident often enough that a
  // non-empty users section is not on its own evidence of intent. Leading with
  // it would put strangers above the literature on every search.
  const preferred = resolvePreferredSearchSection({
    query: 'binary mergers', hint: null, sectionValues: populated(),
  });
  assert.equal(preferred, 'papers');
  assert.ok(
    getSearchSectionOrder('users', preferred) < getSearchSectionOrder('topics', preferred),
    'and people come second, ahead of the rest',
  );
});

test('an @ prefix puts people first — nobody types @ looking for a paper', () => {
  const preferred = resolvePreferredSearchSection({
    query: '@nick', hint: null, sectionValues: populated(),
  });
  assert.equal(preferred, 'users');
  assert.equal(getSearchSectionOrder('users', preferred), 1);
});

test('the @ is read off the raw query, which normalisation would have eaten', () => {
  // normalizeSearchText strips every symbol, so by the time the scoring sees
  // the term the sigil is gone. Checking it there would silently never fire.
  assert.equal(scoreSearchMatch('@nick', ['nick']), 100, 'the sigil is invisible to scoring');
  assert.equal(
    resolvePreferredSearchSection({ query: '  @nick', hint: null, sectionValues: populated() }),
    'users',
    'leading whitespace does not hide the sigil',
  );
});

test('an exact handle or name beats every other exact match', () => {
  // The strongest signal available that a person was meant: stronger than a
  // paper or a topic whose title happens to be the same words.
  assert.equal(
    resolvePreferredSearchSection({
      query: 'nick_mugar', hint: null, sectionValues: populated(),
    }),
    'users',
  );
  assert.equal(
    resolvePreferredSearchSection({
      query: 'nicolás muñoz garcía', hint: null, sectionValues: populated(),
    }),
    'users',
    'an exact display name counts too, accents and all',
  );
});

test('a search that matches nobody leaves the other sections exactly as they were', () => {
  // The regression that would matter most: people joining the page must not
  // reorder a literature search.
  const withoutUsers = resolvePreferredSearchSection({
    query: 'Cosmology', hint: null, sectionValues: populated({ users: [] }),
  });
  const withUsers = resolvePreferredSearchSection({
    query: 'Cosmology', hint: null, sectionValues: populated(),
  });
  assert.equal(withoutUsers, 'topics');
  assert.equal(withUsers, 'topics', 'a populated users section does not steal an exact topic');
});

test('an empty users section can never be preferred, @ or not', () => {
  assert.equal(
    resolvePreferredSearchSection({
      query: '@nobody', hint: null, sectionValues: populated({ users: [] }),
    }),
    'papers',
    'preferring a section with nothing in it would show an empty box at the top',
  );
});

test('clicking the Users pill wins over everything, because it was asked for', () => {
  assert.equal(
    resolvePreferredSearchSection({
      query: 'Cosmology', hint: 'users', sectionValues: populated(),
    }),
    'users',
  );
});
