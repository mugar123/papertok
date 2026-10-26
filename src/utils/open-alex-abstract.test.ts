import test from 'node:test';
import assert from 'node:assert/strict';

import { isPlausibleAbstract, reconstructOpenAlexAbstract, usableOpenAlexAbstract } from './open-alex-abstract.ts';

// Builds an inverted index from plain text, the way OpenAlex stores it.
function invertedIndexOf(text: string) {
  const index: Record<string, number[]> = {};
  text.split(' ').forEach((word, position) => {
    (index[word] ||= []).push(position);
  });
  return index;
}

const ARTICLE_ABSTRACT = 'We measured serum markers in 120 patients with chronic heart failure and found higher levels in severe cases.';

test('an article keeps the abstract OpenAlex rebuilds for it', () => {
  assert.equal(
    usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf(ARTICLE_ABSTRACT) }),
    ARTICLE_ABSTRACT,
  );
});

// W7211952859 is the editorial behind PMID 42774036: OpenAlex indexes its whole
// text as the "abstract", with the paragraph breaks lost ("response.A
// particularly"), and the card showed 9137 characters of it (audit 2026-09-23).
test('an editorial, a letter, an erratum or front matter has no abstract to take', () => {
  const fullText = invertedIndexOf('the therapeutic response.A particularly important finding of this collection is that tumour cells adapt.');
  for (const type of ['editorial', 'letter', 'erratum', 'paratext']) {
    assert.equal(usableOpenAlexAbstract({ type, abstract_inverted_index: fullText }), '', type);
  }
});

test('text too long to be an abstract, or too short to be one, is not an abstract', () => {
  const tooLong = invertedIndexOf(Array.from({ length: 1300 }, (_, i) => `word${i}`).join(' '));
  assert.equal(reconstructOpenAlexAbstract(tooLong).length > 6000, true);
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: tooLong }), '');
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf('Lettre') }), '');
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf('in volume 57, e8.') }), '');
});

// W7222919853, NBER working paper w35910 "Infinite Factor Structure in
// Conditional Asset Pricing": OpenAlex's index holds only the start of its
// funding note, and the Economics feed showed it as the abstract (ENG-105).
test('a funding acknowledgement is not an abstract', () => {
  const acknowledgement = 'Semyon Malamud gratefully acknowledges the financial';
  assert.equal(usableOpenAlexAbstract({ type: 'report', abstract_inverted_index: invertedIndexOf(acknowledgement) }), '');
  for (const text of [
    'We thank seminar participants at Columbia and Wharton for helpful comments and suggestions.',
    'The authors acknowledge financial support from the Swiss National Science Foundation.',
    'Acknowledgements: we are grateful to the editor and two anonymous referees.',
    'This research was supported by the National Science Foundation under grant SES-1234567.',
    'The views expressed herein are those of the authors and do not necessarily reflect the views of the National Bureau of Economic Research.',
  ]) {
    assert.equal(isPlausibleAbstract(text), false, text);
  }
});

test('an abstract that mentions support or thanks later on is still an abstract', () => {
  const abstract = 'We study how firms respond to credit supply shocks. Using bank-level data, we find that support from relationship lenders acknowledges the role of soft information.';
  assert.equal(usableOpenAlexAbstract({ type: 'article', abstract_inverted_index: invertedIndexOf(abstract) }), abstract);
  assert.equal(isPlausibleAbstract('This paper studies how financial support for students changes enrolment, and we thank no one in particular.'), true);
  assert.equal(isPlausibleAbstract('Existing literature rarely acknowledges the financial burden of informal caregiving on households.'), true);
  assert.equal(isPlausibleAbstract('Acknowledging uncertainty in climate projections changes how planners weigh adaptation options.'), true);
});

// A hyphen or an en dash joins a compound ("Funding-liquidity",
// "Funding–liquidity"), so it separates a heading from its text only with a
// space after it; an em dash never joins one.
test('an abstract that opens with a compound starting like a heading word is still an abstract', () => {
  for (const text of [
    'Funding-liquidity spirals amplify shocks to dealer balance sheets; we document this channel using repo data from 2008 to 2020.',
    'Funding–liquidity spirals amplify shocks to dealer balance sheets; we document this channel using repo data from 2008 to 2020.',
    'Funding-constrained banks cut lending to small firms, and we trace the effect through loan-level data from 2010 to 2019.',
    'Disclaimer-style warnings on food labels barely change what shoppers buy, according to a field experiment in 40 stores.',
  ]) {
    assert.equal(isPlausibleAbstract(text), true, text);
  }
  assert.equal(isPlausibleAbstract('Funding - the authors gratefully thank the Swiss National Science Foundation for support.'), false);
  for (const text of [
    'Funding—This work was supported by the Swiss National Science Foundation under grant 1234.',
    'Acknowledgments—We thank the editor and two anonymous referees for helpful comments.',
    'Disclaimer—The views expressed are those of the authors and not of the IMF or its board.',
    'Disclaimer – The views expressed are those of the authors and not of the IMF or its board.',
  ]) {
    assert.equal(isPlausibleAbstract(text), false, text);
  }
});

// "Supported by" or "funded by" opens a funding note, whoever the funder is; a
// study supported by data describes the research. A project that opens by
// naming its funder reads as a funding note too, even when it goes on to
// describe the work.
test('an opening that says what supported or funded the work is front matter unless data or evidence follows', () => {
  for (const text of [
    'This study is supported by data from the Health and Retirement Study and examines retirement timing across cohorts.',
    'This paper is supported by new evidence from 40 field experiments on how households respond to price changes.',
    // Semantic Scholar text reaches the check without its whitespace collapsed.
    'This study is supported by  data from the Health and Retirement Study and examines retirement timing across cohorts.',
    'This study is supported by\n data from the Health and Retirement Study and examines retirement timing across cohorts.',
    'Funded by venture capital, the startup market in this study grew twice as fast as the rest of the economy over the decade.',
    // A participle that names its funder still opens a real abstract.
    'Funded by Medicaid, community health centers expanded dental services to adults, and we measure the effect on emergency room visits using claims from 2010 to 2019.',
    'Funded by China\'s Belt and Road Initiative, new ports in East Africa changed regional trade flows, which we trace through customs records from 2013 to 2022.',
    'Co-funded by the European Union, cross-border rail projects reduced travel times between regional capitals, and we estimate the effect on commuting from census data.',
  ]) {
    assert.equal(isPlausibleAbstract(text), true, text);
  }
  for (const text of [
    'This paper was funded by a grant from the Swiss National Science Foundation.',
    'This work is supported by the European Research Council (ERC) under the Horizon 2020 programme.',
    'This work was supported by the National Institutes of Health (R01 HL123456 to J.S.).',
    'This research was supported by the Intramural Research Program of the National Institutes of Health, National Institute on Aging.',
    'This study was funded by the Wellcome Trust (215123/Z/19/Z).',
    'This research was supported by the U.S. Department of Energy, Office of Science, Basic Energy Sciences.',
    // A funder whose name starts with Data or Evidence is still a funder.
    'This work was supported by the Data Science Institute at Columbia University and by NSF grant 1234.',
    'This research was funded by Evidence Action and the Global Innovation Fund.',
    'The project was funded by the EU and built a cohort of 10,000 children, whom we follow from birth to age 12.',
    // The wordings funders ask grantees to use (NIH, Wellcome, NSF, Horizon 2020, Horizon Europe).
    'Research reported in this publication was supported by the National Institute of General Medical Sciences of the National Institutes of Health under Award Number R01GM123456.',
    'This research was funded in whole, or in part, by the Wellcome Trust [215123/Z/19/Z]. For the purpose of open access, the author has applied a CC BY public copyright licence.',
    'This work was supported in part by the National Science Foundation under Grant No. CCF-1234567.',
    'This work was supported, in part, by the National Science Foundation under Grant No. CCF-1234567.',
    'This project has received funding from the European Research Council (ERC) under the European Union\'s Horizon 2020 research and innovation programme (grant agreement No 123456).',
    'Funded by the European Union. Views and opinions expressed are however those of the author(s) only and do not necessarily reflect those of the European Union.',
    'This article was supported by the National Natural Science Foundation of China (No. 12345678).',
    'This trial was funded by the NIHR Health Technology Assessment programme (project 16/31/101).',
    // The opening is matched whatever its case; only the data or evidence exception is case-sensitive.
    'THIS WORK WAS SUPPORTED BY THE NATIONAL INSTITUTES OF HEALTH UNDER GRANT R01 HL123456.',
    'This Work Was Supported By The National Science Foundation Under Grant No. 1234567.',
    // The EU's disclaimer sentence, in any case.
    'Co-funded by the European Union. Views and opinions expressed are however those of the author(s) only.',
    'FUNDED BY THE EUROPEAN UNION. Views and opinions expressed are however those of the author(s) only and do not necessarily reflect those of the European Union.',
    // "Has received funding from" for any subject a supported-by note has, and FP7's.
    'This paper has received funding from the European Union\'s Horizon 2020 research and innovation programme under grant agreement No 123456.',
    'This publication has received funding from the European Research Council under grant agreement No 123456.',
    'This work received funding from the European Research Council under grant agreement No 123456.',
    'The research leading to these results has received funding from the European Research Council under the European Union\'s Seventh Framework Programme (FP7/2007-2013).',
  ]) {
    assert.equal(isPlausibleAbstract(text), false, text);
  }
});

test('a note of thanks or funding is front matter in the forms a PDF extract and a singular author give it', () => {
  for (const text of [
    'The author thanks seminar participants at the Federal Reserve Board for helpful comments.',
    'Acknowledgments We thank the editor and two anonymous referees for comments on an earlier draft.',
    '* We thank the editor and two anonymous referees for helpful comments on an earlier draft.',
    '1 We thank the editor and two anonymous referees for helpful comments on an earlier draft.',
    'Financial support from the Swiss National Science Foundation is gratefully acknowledged.',
    'This material is based upon work supported by the National Science Foundation under Grant No. 1234567.',
  ]) {
    assert.equal(isPlausibleAbstract(text), false, text);
  }
  assert.equal(isPlausibleAbstract('Acknowledgement of omitted variable bias changes how we read the estimated returns to schooling.'), true);
});

test('a work with no index, or no work, has no abstract', () => {
  assert.equal(usableOpenAlexAbstract({ type: 'article' }), '');
  assert.equal(usableOpenAlexAbstract(null), '');
});

test('rebuilds the abstract in position order, not in key order', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ world: [1], Hello: [0], again: [3], world2: [] , '!': [2] }),
    'Hello world ! again',
  );
});

test('places a word that repeats at each of its positions', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ the: [0, 2], cat: [1], hat: [3] }),
    'the cat the hat',
  );
});

test('collapses the gap a missing position leaves instead of doubling the space', () => {
  // The sparse array leaves a hole at 2, which `join` renders as two spaces.
  assert.equal(reconstructOpenAlexAbstract({ a: [0], b: [1], d: [3] }), 'a b d');
});

test('returns an empty string when there is nothing to rebuild', () => {
  // The caller supplies its own placeholder, because they differ by locale.
  assert.equal(reconstructOpenAlexAbstract(null), '');
  assert.equal(reconstructOpenAlexAbstract(undefined), '');
  assert.equal(reconstructOpenAlexAbstract({}), '');
  assert.equal(reconstructOpenAlexAbstract('not an index'), '');
});

test('ignores malformed positions rather than producing holes or crashing', () => {
  assert.equal(
    reconstructOpenAlexAbstract({ good: [0], bad: 'nope', worse: [-1], odd: [null], last: [1] }),
    'good last',
  );
});
