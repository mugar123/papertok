import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorProminenceWeight,
  authorSearchValues,
  buildSearchSectionValues,
  filterRelevantSearchResults,
  getSearchSectionOrder,
  institutionProminenceWeight,
  isOrganisationAuthorRecord,
  normalizeSearchText,
  rankPaperSearchResults,
  resolvePreferredSearchSection,
  scorePaperSearchMatch,
  scoreSearchMatch,
} from './search-relevance.ts';

// --- scoring and filtering ---------------------------------------------------

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

// --- section ordering -------------------------------------------------------

/** Every section populated, so ordering is the only thing under test. */
const populated = (overrides = {}) => ({
  papers: ['Numerical relativity of binary mergers'],
  topics: ['Cosmology'],
  authors: ['Geoffrey Hinton'],
  institutions: ['Massachusetts Institute of Technology'],
  projects: ['HORIZON'],
  ...overrides,
});

test('a leading @ is read as text, like any other symbol', () => {
  // No section claims the sigil: normalisation strips it along with every
  // other symbol, so the words that follow decide the order.
  assert.equal(scoreSearchMatch('@nick', ['nick']), 100, 'the sigil is invisible to scoring');
  assert.equal(
    resolvePreferredSearchSection({ query: '@Cosmology', hint: null, sectionValues: populated() }),
    'topics',
  );
  assert.equal(
    resolvePreferredSearchSection({ query: '  @nobody', hint: null, sectionValues: populated() }),
    'papers',
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
  const probe = (query: string) => resolvePreferredSearchSection({
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
  assert.equal(institutionProminenceWeight(undefined!), 0);
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
  });
  assert.deepEqual(values.topics, ['Cosmology']);
  assert.deepEqual(values.projects, ['A funded thing']);
});

// --- paper ranking: the title a reader typed goes first ----------------------

test('a paper whose title is the query outranks the derivative papers that quote it', () => {
  // The order OpenAlex sent for "segment anything" once conference papers are
  // allowed back in, with the original deliberately placed last so the sort,
  // not the provider, has to lift it.
  const ranked = rankPaperSearchResults('segment anything', [
    { title: 'Segment anything in medical images', abstract: 'We adapt the Segment Anything Model...' },
    { title: 'Segment anything model for medical image analysis: An experimental study' },
    { title: 'The Segment Anything Model (SAM) for remote sensing applications' },
    { title: 'RingMo-SAM: A Foundation Model for Segment Anything in Multimodal Remote-Sensing' },
    { title: 'Segment Anything' },
  ]).map(paper => paper.title);
  assert.equal(ranked[0], 'Segment Anything');
  // Prefix matches keep their place above the phrase-somewhere matches, and
  // the provider's order still decides between equals.
  assert.deepEqual(ranked.slice(1, 3), [
    'Segment anything in medical images',
    'Segment anything model for medical image analysis: An experimental study',
  ]);
});

test('a title that starts with the query beats one that merely contains it', () => {
  const ranked = rankPaperSearchResults('llama 2', [
    { title: 'Systematic analysis of ChatGPT, Google search and Llama 2 for clinical decision support' },
    { title: 'Nanobodies from camelid mice and llamas neutralize SARS-CoV-2 variants' },
    { title: 'LLaMA-VID: An Image is Worth 2 Tokens in Large Language Models' },
    { title: 'Llama 2: Open Foundation and Fine-Tuned Chat Models' },
  ]).map(paper => paper.title);
  assert.equal(ranked[0], 'Llama 2: Open Foundation and Fine-Tuned Chat Models');
  assert.equal(ranked[1], 'Systematic analysis of ChatGPT, Google search and Llama 2 for clinical decision support');
  // Both query tokens as words, but not the phrase: below the phrase matches.
  assert.equal(ranked[2], 'LLaMA-VID: An Image is Worth 2 Tokens in Large Language Models');
  // "llamas" is not "llama" and "cov 2" only lends the digit: last.
  assert.equal(ranked[3], 'Nanobodies from camelid mice and llamas neutralize SARS-CoV-2 variants');
});

test('hyphens, case and the digit are not what decides a title match', () => {
  const title = 'Llama 2: Open Foundation and Fine-Tuned Chat Models';
  const prefix = scorePaperSearchMatch('llama 2', { title });
  assert.ok(prefix >= 94 && prefix < 100, `a prefix match, got ${prefix}`);
  assert.equal(scorePaperSearchMatch('Llama-2', { title }), prefix);
  assert.equal(scorePaperSearchMatch('LLAMA 2', { title }), prefix);
  assert.equal(scorePaperSearchMatch('llama-2 open foundation and fine tuned chat models', { title }), 100);
  const steering = scorePaperSearchMatch('Steering Llama-2', { title: 'Steering Llama 2 via Contrastive Activation Addition' });
  assert.ok(steering >= 94 && steering < 100, `a prefix match, got ${steering}`);
});

test('of two titles that start with the query, the one the query covers more is nearer', () => {
  // The live order on 2026-09-22: OpenAlex sent the preprints.org note first
  // and arXiv the Llama 2 paper last, and both start with "Llama 2".
  const adopters = { title: "Llama 2: Early Adopters' Utilization of Meta's New Open-Source Pretrained Model" };
  const llama2 = { title: 'Llama 2: Open Foundation and Fine-Tuned Chat Models' };
  assert.ok(scorePaperSearchMatch('llama 2', llama2) > scorePaperSearchMatch('llama 2', adopters));
  assert.deepEqual(rankPaperSearchResults('llama 2', [adopters, llama2]), [llama2, adopters]);
  // Never enough to climb a tier: a long exact-prefix title still beats a
  // short title that only contains the phrase, and nothing reaches 100.
  const contains = { title: 'Steering Llama 2' };
  assert.ok(scorePaperSearchMatch('llama 2', adopters) > scorePaperSearchMatch('llama 2', contains));
  assert.ok(scorePaperSearchMatch('llama 2', { title: 'Llama 2 X' }) < 100);
  assert.ok(scorePaperSearchMatch('llama 2', { title: 'X Llama 2' }) < 94);
});

test('a paper known by an acronym its title never uses is found through the abstract', () => {
  const fcClip = {
    title: 'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP',
    abstract: 'We propose FC-CLIP, a single-stage framework built on a shared frozen convolutional CLIP backbone.',
  };
  const textToClip = { title: 'Multilevel Language and Vision Integration for Text-to-Clip Retrieval', abstract: 'Text-to-clip retrieval.' };
  const unrelated = { title: 'Respiratory sinus arrhythmia in humans', abstract: 'Breathing modulates heart rate.' };

  const scattered = { title: 'Clip Formation in the Complementarity Determining Region with Fc proteins' };
  assert.ok(scorePaperSearchMatch('FC-CLIP', fcClip) > scorePaperSearchMatch('FC-CLIP', scattered));
  assert.equal(rankPaperSearchResults('fc clip', [scattered, fcClip])[0], fcClip);
  // One of two query words in the title, no phrase anywhere.
  assert.equal(scorePaperSearchMatch('FC-CLIP', textToClip), 35);
  assert.equal(scorePaperSearchMatch('FC-CLIP', unrelated), 0);

  const ranked = rankPaperSearchResults('FC-CLIP', [unrelated, textToClip, fcClip]);
  assert.equal(ranked[0], fcClip);
});

test('the near-exact title ranks first even when the provider sent it last', () => {
  const exact = { title: 'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP' };
  const ranked = rankPaperSearchResults(
    'Convolutions Die Hard: Open-Vocabulary Segmentation with Single Frozen Convolutional CLIP',
    [
      { title: 'Towards Open Vocabulary Learning: A Survey' },
      { title: 'Open-Vocabulary Camouflaged Object Segmentation with Cascaded Vision Language Models' },
      exact,
    ],
  );
  assert.equal(ranked[0], exact);
  assert.equal(scorePaperSearchMatch('convolutions die hard open vocabulary segmentation with single frozen convolutional clip', exact), 100);
});

test('phrase matches are whole words: "sam" is not inside "samples"', () => {
  assert.equal(scorePaperSearchMatch('sam', { title: 'Sampling strategies for samples', abstract: 'Many samples.' }), 0);
  const contains = scorePaperSearchMatch('sam', { title: 'Medical SAM adapter' });
  assert.ok(contains >= 88 && contains < 94, `a phrase-inside match, got ${contains}`);
});

test('the paper ranking drops nothing and survives holes', () => {
  const papers = [{ title: null! }, {}, { title: 'Segment Anything', abstract: undefined }];
  assert.equal(rankPaperSearchResults('segment anything', papers).length, 3);
  assert.deepEqual(rankPaperSearchResults('', papers), papers);
  assert.equal(scorePaperSearchMatch('anything', null!), 0);
});

test('small spelling errors find the closest title before derivatives', () => {
  const original = { title: 'Segment Anything' };
  for (const query of ['Segment Anythign', 'Segmnt Anythng']) {
    assert.equal(rankPaperSearchResults(query, [
      { title: 'Fast Segment Anything' }, { title: 'Segment anything in medical images' }, original,
    ])[0], original);
  }
});

test('a partial title prefers its completion and leaves version numbers exact', () => {
  const original = { title: 'Attention Is All You Need' };
  assert.equal(rankPaperSearchResults('attention is all you ne', [
    { title: 'Attention Is All You Have' }, { title: 'Attention Is All You Need In Speech Separation' }, original,
  ])[0], original);
  assert.ok(scorePaperSearchMatch('Llama 2', { title: 'Llama 2: Open Foundation Models' })
    > scorePaperSearchMatch('Llama 2', { title: 'Llama 20' }));
  assert.equal(scorePaperSearchMatch('Llama 2', { title: 'Llama 20' }), 35);
});


test('partial names and title phrases tolerate an earlier typo without accepting unrelated words', () => {
  for (const [query, title] of [
    ['from acelerating rotating bla', 'From Accelerating Rotating Black Holes to a Swirling Universe'],
    ['Superconducting circuits host two-lev', 'Superconducting circuits host two-level systems with lifetimes exceeding one second'],
    ['attentio', 'Attention Is All You Need'],
    ['Geofrey Hin', 'Geoffrey Hinton'],
    ['Andrej Karp', 'Andrej Karpathy'],
    ['Graphene Flag', 'Graphene Flagship'],
    ['Machien lear', 'Machine Learning'],
  ]) {
    assert.ok(scoreSearchMatch(query, [title]) >= 82, query);
    assert.ok(scorePaperSearchMatch(query, { title }) >= 82, query);
    assert.ok(scoreSearchMatch(query, ['Unrelated experiments']) < 55, query);
  }
  assert.ok(scorePaperSearchMatch('Llama 2', { title: 'Llama 20' }) < 80);
  assert.ok(scorePaperSearchMatch('sam', { title: 'Samples from biology' }) < 80);
});


test('All puts a close author-name completion before titles mentioning that person', () => {
  assert.equal(resolvePreferredSearchSection({ query: 'Geofrey Hin', sectionValues: {
    authors: ['Geoffrey E. Hinton', 'Geoffrey Hinton'],
    papers: ['Neural network pioneer Geoffrey Hinton'],
  } }), 'authors');
});


test('an unfinished project name ranks its shortest completion above derivative titles', () => {
  assert.ok(scoreSearchMatch('Human Brain Pro', ['Human Brain Project'])
    > scoreSearchMatch('Human Brain Pro', ['NEUROPORTAL Gateway to the Human Brain Project']));
  assert.equal(resolvePreferredSearchSection({ query: 'Geoffrey Hin', sectionValues: {
    authors: ['Geoffrey Hinton'], papers: ['Neural network pioneer Geoffrey Hinton'],
  } }), 'authors');
});

// --- names and titles in other scripts --------------------------------------

/** The authors section as the palette and the page filter it. */
const authorMatches = (query: string, names: string[]) => filterRelevantSearchResults(
  query, names.map(display_name => ({ display_name })), authorSearchValues, { minimumScore: 80 },
).map(author => author.display_name);

test('a name in another script finds its own author and no stranger', () => {
  // The first three are what OpenAlex answered for `authors?search=محبوبه سلیمانی`
  // on 2026-10-25. The scorer used to erase every letter of them, so all three
  // fell under the threshold together with the strangers.
  assert.deepEqual(
    authorMatches('محبوبه سلیمانی', ['علی رضایی', 'محبوبه سلیمانی', 'محبوبه سلیمانی حصار', 'محبوبه سلیمانی ساسانی', 'Mahboubeh Soleimani']),
    ['محبوبه سلیمانی', 'محبوبه سلیمانی حصار', 'محبوبه سلیمانی ساسانی'],
  );
  assert.deepEqual(authorMatches('张伟', ['李小龙', '张伟', '张伟明', 'Wei Zhang']), ['张伟', '张伟明']);
  // Case and the diaeresis fold as they do in Latin; swapped or half-shared
  // names do not pass.
  assert.deepEqual(
    authorMatches('Пётр Иванов', ['Иван Петров', 'ПЕТР ИВАНОВ', 'Пётр Сидоров']),
    ['ПЕТР ИВАНОВ'],
  );
  assert.deepEqual(authorMatches('Ayşe Arık', ['Ayşe Ak', 'AYŞE ARIK', 'Ayse Arik']), ['AYŞE ARIK', 'Ayse Arik']);
  assert.deepEqual(
    authorMatches('José García', ['Josefina Garza', 'Jose Garcia', 'José García Márquez']),
    ['Jose Garcia', 'José García Márquez'],
  );
});

test('letters that NFD leaves whole fold to the letters typed without them', () => {
  assert.deepEqual(
    ['Arık', 'İlker', 'Łukasz', 'Søren', 'Straße', 'Đorđević', 'Þórður', 'Ærø', 'Œuvre', 'Ħal', 'Ĳssel', 'µ-opioid'].map(normalizeSearchText),
    ['arik', 'ilker', 'lukasz', 'soren', 'strasse', 'dordevic', 'thordur', 'aero', 'oeuvre', 'hal', 'ijssel', 'μ opioid'],
  );
  assert.equal(scoreSearchMatch('Lukasz Kowalski', ['Łukasz Kowalski']), 100);
});

test('modifier letters separate words like the apostrophe typed for them', () => {
  assert.equal(scoreSearchMatch("Sa'id Ahmad", ['Saʿid Ahmad']), 100);
  assert.equal(scoreSearchMatch("University of Hawai'i", ['University of Hawaiʻi at Mānoa']), 94);
  assert.equal(scoreSearchMatch('محمد', ['مـحـمـد']), 100, 'tatweel only stretches the letters');
});

test('a run of Chinese or Japanese is one word, split from the Latin beside it', () => {
  // OpenAlex stores many Japanese names with a space the reader does not type.
  assert.equal(scoreSearchMatch('山田太郎', ['山田 太郎']), 100);
  assert.equal(scoreSearchMatch('葛城', ['葛\ufe00城']), 100, 'a variation selector only picks the glyph');
  assert.ok(scorePaperSearchMatch('LSTM 预测', { title: 'LSTM预测模型研究' }) >= 94);
  assert.ok(scorePaperSearchMatch('COVID-19 疫苗', { title: 'COVID-19疫苗接种意愿调查' }) >= 94);
  assert.ok(scorePaperSearchMatch('CNN', { title: 'CNN在图像识别中的应用' }) >= 94);
  assert.ok(scorePaperSearchMatch('预测', { title: 'LSTM预测模型研究' }) >= 88);
});

test('a script is kept, not translated: a name matches only text in its own script', () => {
  assert.equal(scoreSearchMatch('Wei Zhang', ['张伟']), 0);
  assert.equal(scoreSearchMatch('张伟', ['Wei Zhang']), 0);
});

test('an exact name in another script leads with its own section', () => {
  // With every letter erased, any value in another script was an "exact match"
  // for the empty query, and the first section in the sweep took the lead.
  assert.equal(resolvePreferredSearchSection({
    query: '张伟',
    sectionValues: { topics: ['机器学习'], authors: ['张伟'], papers: ['深度学习'] },
  }), 'authors');
});

test('a title in a script without spaces matches inside its run of characters', () => {
  // Titles OpenAlex answered for `深度学习` on 2026-10-25. Chinese writes no
  // spaces, so the query is part of a longer run and has no word to complete.
  const contains = scorePaperSearchMatch('深度学习', { title: '基于深度学习的三维重建方法综述' });
  assert.ok(contains >= 88 && contains < 94, `a phrase-inside match, got ${contains}`);
  assert.ok(scorePaperSearchMatch('深度学习', { title: '深度学习：推进人工智能的梦想' }) >= 94);
  assert.ok(scorePaperSearchMatch('深度学习', { title: '基于学习的深度估计' }) < 80, 'shared characters out of order are not the phrase');
  assert.ok(scorePaperSearchMatch('深度学习', { title: 'Attention is all you need' }) < 80);
});

test('a title in a spaced script keeps whole words and unfinished prefixes', () => {
  // Titles OpenAlex answered for `машинное обучение` on 2026-10-25.
  assert.ok(scorePaperSearchMatch('машинное обучение', { title: 'Машинное обучение в бизнесе' }) >= 94);
  const contains = scorePaperSearchMatch('машинное обучение', { title: 'Глубинное машинное обучение' });
  assert.ok(contains >= 88 && contains < 94, `a phrase-inside match, got ${contains}`);
  assert.ok(scorePaperSearchMatch('машинное обуч', { title: 'Машинное обучение в бизнесе' }) >= 90, 'the last word is still being typed');
  assert.ok(scorePaperSearchMatch('учение', { title: 'Глубинное машинное обучение' }) < 80, 'the end of a word is not a phrase');
  assert.ok(scorePaperSearchMatch('машинное обучение', { title: 'Большие данные' }) < 80);
});
