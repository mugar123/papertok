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
  authorProminenceWeight,
  buildSearchSectionValues,
  filterRelevantSearchResults,
  getSearchSectionOrder,
  institutionProminenceWeight,
  isOrganisationAuthorRecord,
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

// --- the institution that came last ----------------------------------------

/**
 * OpenAlex answers `authors?search=university of salamanca` with FOUR records
 * whose display_name is literally "University of Salamanca" — works_count 1-7,
 * no citations, no ORCID, no institution. Institution-as-author artifacts.
 *
 * They score 100, which used to hand `authors` the exact-match sweep and, with
 * it, first place. The real university came 5th of 6. These four tests are that
 * search, taken apart.
 */

test('an institution query is not stolen by authors named after the institution', () => {
  assert.equal(
    resolvePreferredSearchSection({
      query: 'university of salamanca',
      hint: null,
      sectionValues: populated({
        authors: ['University of Salamanca'],
        institutions: ['Universidad de Salamanca', 'University of Salamanca', 'USAL'],
      }),
    }),
    'institutions',
  );
});

test('the organisation words are read off the query, not off the results', () => {
  // The mirror of the test above, and the regression it must not cause: an
  // institution whose NAME contains "Foundation" does not make a person search
  // an institution search. Only the words typed decide.
  assert.equal(
    resolvePreferredSearchSection({
      query: 'Geoffrey Hinton',
      hint: null,
      sectionValues: populated({ institutions: ['Hinton Area Foundation'] }),
    }),
    'authors',
  );
});

test('the intent reorders the exact sweep, it does not replace it', () => {
  // An organisation query still prefers a section that matches it exactly over
  // institutions that only match loosely. Otherwise "instituto cervantes" typed
  // as a topic name would be dragged to an institutions section that has
  // nothing exact to show.
  assert.equal(
    resolvePreferredSearchSection({
      query: 'nick_mugar',
      hint: null,
      sectionValues: populated({ institutions: ['University of Salamanca'] }),
    }),
    'users',
    'an exact handle still wins',
  );
  assert.equal(
    resolvePreferredSearchSection({
      query: 'university of salamanca',
      hint: null,
      sectionValues: populated({ institutions: [], authors: ['University of Salamanca'] }),
    }),
    'authors',
    'with no institutions section at all, the exact author is still the answer',
  );
});

test('an institution-as-author record is not a person', () => {
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'University of Salamanca', orcid: null, institution: null,
    }),
    true,
  );
  // A collaboration is a real byline: it carries no organisation word and stays.
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'CMS Collaboration', orcid: null, institution: null,
    }),
    false,
  );
  // Either identity field is enough to say this is a person who happens to be
  // named after, or to work at, an organisation.
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'University of Salamanca', orcid: 'https://orcid.org/0000-0002-1825-0097',
    }),
    false,
  );
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'Ana Institut', orcid: null, institution: 'Universidad de Salamanca',
    }),
    false,
  );
  // The other shape of junk in that index: a display_name that is a whole
  // sentence naming several universities. Nobody is called that, so it goes
  // even with an ORCID attached.
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'a comparative study by the Universidad Pontificia de Salamanca and the '
        + 'University of Castilla-La Mancha on regional outcomes',
      orcid: 'https://orcid.org/0000-0002-1825-0097',
    }),
    true,
  );
  // But length alone is not evidence: a long collaboration byline carries no
  // organisation word and survives it.
  assert.equal(
    isOrganisationAuthorRecord({
      display_name: 'LIGO Scientific Collaboration and Virgo Collaboration and KAGRA '
        + 'Collaboration and the Pulsar Timing Array working group',
      orcid: null,
      institution: null,
    }),
    false,
  );
});

test('the organisation words cover the languages PaperTok searches in', () => {
  // Read through resolvePreferredSearchSection, which is the only consumer that
  // matters: with nothing matching exactly anywhere, an organisation query is
  // the only thing that can reach the institutions section.
  const probe = query => resolvePreferredSearchSection({
    query,
    hint: null,
    sectionValues: { papers: ['An unrelated paper'], institutions: ['Somewhere'] },
  });

  for (const query of [
    'universidade de lisboa',
    'universitat de barcelona',
    'université de paris',
    'technische universität münchen',
    'universitätsklinikum heidelberg',
    'centre hospitalier universitaire',
    'instituto de salud carlos iii',
    'laboratoire de physique',
    'max planck gesellschaft',
    'escuela politécnica superior',
  ]) {
    assert.equal(probe(query), 'institutions', query);
  }

  // The words a stem would have swallowed. Each of these is an ordinary query
  // in a science app, and none of them is asking for a building.
  for (const query of [
    'deep learning',
    'clinical trial outcomes',
    'academic performance',
    'the universe is expanding',
    'universal grammar',
    'cms collaboration',
    'geoffrey hinton',
  ]) {
    assert.equal(probe(query), 'papers', query);
  }
});

// --- ranking inside a section ----------------------------------------------

test('equal text scores break on prominence, not on the order the API sent', () => {
  // Four exact matches all score 100, and Array.prototype.sort is stable, so
  // without a weight the provider's order survives untouched — which is how
  // one-paper records ended up above the researcher being looked for.
  const authors = [
    { display_name: 'Jane Roe', cited_by_count: 0 },
    { display_name: 'Jane Roe', cited_by_count: 9100 },
    { display_name: 'Jane Roe', cited_by_count: 12 },
  ];
  assert.deepEqual(
    filterRelevantSearchResults('Jane Roe', authors, author => [author.display_name], {
      getWeight: authorProminenceWeight,
    }).map(author => author.cited_by_count),
    [9100, 12, 0],
  );
  // The text score still decides first: a weaker match does not buy its way up.
  const mixed = [
    { display_name: 'Jane Roe Institute', cited_by_count: 99999 },
    { display_name: 'Jane Roe', cited_by_count: 1 },
  ];
  assert.equal(
    filterRelevantSearchResults('Jane Roe', mixed, author => [author.display_name], {
      getWeight: authorProminenceWeight,
    })[0].display_name,
    'Jane Roe',
  );
});

test('the weight is opt-in, so the three-argument callers are untouched', () => {
  const results = [{ name: 'Beta' }, { name: 'Alpha' }];
  assert.deepEqual(
    filterRelevantSearchResults('exactly', results, result => [result.name]),
    [],
  );
  // With no citations to tell them apart, works decide — which is what keeps a
  // one-paper artifact below a real profile even when both score 100.
  assert.ok(
    authorProminenceWeight({ cited_by_count: 0, works_count: 40 })
      > authorProminenceWeight({ cited_by_count: 0, works_count: 3 }),
  );
  assert.ok(
    authorProminenceWeight({ cited_by_count: 1, works_count: 0 })
      > authorProminenceWeight({ cited_by_count: 0, works_count: 999999 }),
    'a single citation outweighs any number of papers',
  );

  const ties = [{ name: 'Same', id: 1 }, { name: 'Same', id: 2 }];
  assert.deepEqual(
    filterRelevantSearchResults('Same', ties, result => [result.name]).map(r => r.id),
    [1, 2],
    'without a weight, equal scores keep the order they arrived in',
  );
});

test('an acronym half a dozen organisations share still puts the famous one first', () => {
  // Live ROR, 2026-08-26: "MIT" answers with 47 organisations, 20 on the page,
  // six of which carry MIT in `acronyms` and so score exactly 100. Massachusetts
  // Institute of Technology is SEVENTH in ROR's own order, so the slice at five
  // dropped it and the search answered "MIT" without MIT in it.
  //
  // Counts are the real OpenAlex figures for these ROR ids, which is the point:
  // nothing in the ROR record itself separates these seven.
  const institutions = [
    { display_name: 'University of Southern Mindanao', acronyms: ['MIT', 'USM'], works_count: 974, cited_by_count: 8769 },
    { display_name: 'Management Intelligenter Technologien (Germany)', acronyms: ['MIT'], works_count: 128, cited_by_count: 1225 },
    { display_name: 'Manukau Institute of Technology', acronyms: ['MIT'], works_count: 1004, cited_by_count: 22797 },
    { display_name: 'Myanmar Institute of Theology', acronyms: ['MIT'], works_count: 255, cited_by_count: 4328 },
    { display_name: 'Ministry of Infrastructures and Transport', acronyms: ['MIT'], works_count: 150, cited_by_count: 3472 },
    { display_name: 'International Tourism Institute', acronyms: ['ITI', 'MIT'], works_count: 122, cited_by_count: 338 },
    { display_name: 'Massachusetts Institute of Technology', acronyms: ['MIT'], works_count: 355652, cited_by_count: 65816719 },
  ];

  const ranked = filterRelevantSearchResults(
    'MIT',
    institutions,
    institution => [institution.display_name, ...(institution.acronyms || [])],
    { getWeight: institutionProminenceWeight },
  );

  assert.equal(ranked[0].display_name, 'Massachusetts Institute of Technology');
  // The bug was the slice, not just the order: five is what `searchInstitutions`
  // shows, so surviving the cut is the thing worth pinning.
  assert.ok(
    ranked.slice(0, 5).some(institution => institution.display_name === 'Massachusetts Institute of Technology'),
    'MIT survives the slice at five',
  );
});

test('an institution nobody enriched weighs nothing instead of throwing', () => {
  // `normalizeRorInstitution` ships works_count, cited_by_count and
  // summary_stats as null on purpose — ROR does not carry them. A weight read
  // off an un-enriched record has to come out 0, so the text order survives
  // untouched rather than the sort blowing up or going NaN.
  assert.equal(institutionProminenceWeight({ works_count: null, cited_by_count: null }), 0);
  assert.equal(institutionProminenceWeight(undefined), 0);
  assert.ok(
    institutionProminenceWeight({ cited_by_count: 1, works_count: 0 })
      > institutionProminenceWeight({ cited_by_count: 0, works_count: 999999 }),
    'citations lead, exactly as they do for authors',
  );
});

// --- one vote, two surfaces -------------------------------------------------

test('both surfaces vote with the same values, acronyms included', () => {
  // The palette used to build these itself and left out aliases and acronyms,
  // so it could not see "USAL" — and an acronym is the ONLY way an acronym
  // search can win, since "MIT" carries no organisation word to read.
  const values = buildSearchSectionValues({
    institutions: [{
      display_name: 'Massachusetts Institute of Technology',
      localized_names: { es: 'Instituto Tecnológico de Massachusetts' },
      aliases: ['MIT'],
      acronyms: ['MIT'],
    }],
  });
  assert.ok(values.institutions.includes('MIT'));
  assert.ok(values.institutions.includes('Instituto Tecnológico de Massachusetts'));
  assert.equal(
    resolvePreferredSearchSection({
      query: 'MIT',
      hint: null,
      sectionValues: { ...populated(), institutions: values.institutions },
    }),
    'institutions',
  );
});

test('the section values drop the holes the sources leave', () => {
  // A concept with no labelEs, an author with no name, a project with no
  // acronym: an undefined in the list is a value that normalises to '' and
  // would match an empty query.
  const values = buildSearchSectionValues({
    topics: [{ display_name: 'Cosmology' }],
    projects: [{ title: 'A funded thing' }],
    users: [{ handle: 'nick' }],
  });
  assert.deepEqual(values.topics, ['Cosmology']);
  assert.deepEqual(values.projects, ['A funded thing']);
  assert.deepEqual(values.users, ['nick']);
});
