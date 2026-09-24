import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaOfPaper,
  composeGuestPage,
  extendGuestPage,
  guestPageReady,
} from './guestFeedComposition.js';

const PAGE = 12;
const CS_MED = { key: 'cs+med', areas: ['cs', 'med'] };
const DEFAULT_PLAN = { key: 'default', areas: [] };

// Papers as the four guest branches deliver them: arXiv tags the requested
// category, OpenReview and Hugging Face the first category of the plan
// (`cs.AI` on page 1), PubMed the medicine subcategory it matched.
function papers(source, categories, count, prefix = source) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    title: `${prefix} paper ${index}`,
    primaryCategory: categories[index % categories.length],
    categories: [categories[index % categories.length]],
    sources: { primary: source },
  }));
}

const arxiv = papers('arxiv', ['cs.AI', 'cs.LG', 'cs.CV'], 12);
const domain = [...papers('openreview', ['cs.AI'], 10), ...papers('huggingface', ['cs.AI'], 10)];
const pubmed = papers('pubmed', ['med.cardio', 'med.onco', 'med.gen'], 25);
const areasOf = (page) => page.map(areaOfPaper);
const count = (page, area) => areasOf(page).filter(value => value === area).length;

test('a paper belongs to the area of its category', () => {
  assert.equal(areaOfPaper({ primaryCategory: 'cs.AI' }), 'cs');
  assert.equal(areaOfPaper({ primaryCategory: 'med.cardio' }), 'med');
  assert.equal(areaOfPaper({ primaryCategory: 'astro-ph.CO' }), 'physics');
  assert.equal(areaOfPaper({ primaryCategory: 'Oncology', categories: ['Humans', 'med.onco'] }), 'med');
  assert.equal(areaOfPaper({ primaryCategory: 'something else' }), null);
  assert.equal(areaOfPaper(null), null);
});

test('two areas share the page, alternating, as soon as both have answered', () => {
  const page = composeGuestPage([...arxiv, ...domain, ...pubmed], CS_MED, PAGE);

  assert.equal(page.length, PAGE);
  assert.equal(count(page, 'cs'), 6);
  assert.equal(count(page, 'med'), 6);
  assert.deepEqual(areasOf(page).slice(0, 4), ['cs', 'med', 'cs', 'med']);
});

test('inside an area the sources take turns, so one fast source cannot fill it', () => {
  const page = composeGuestPage([...arxiv, ...domain, ...pubmed], CS_MED, PAGE);
  const csSources = page.filter(paper => areaOfPaper(paper) === 'cs').map(paper => paper.sources.primary);

  assert.deepEqual(csSources, ['arxiv', 'openreview', 'huggingface', 'arxiv', 'openreview', 'huggingface']);
});

test('an area that has answered alone gets its share, not the whole page', () => {
  const early = composeGuestPage(domain, CS_MED, PAGE);

  assert.equal(early.length, 6);
  assert.equal(count(early, 'cs'), 6);
});

test('the area that answers late is added after the cards already shown, which do not move', () => {
  const early = composeGuestPage(domain, CS_MED, PAGE);
  const extended = extendGuestPage(early, [...domain, ...pubmed], CS_MED, PAGE);

  assert.equal(extended.length, PAGE);
  assert.deepEqual(extended.slice(0, early.length), early);
  assert.equal(count(extended, 'med'), 6);
});

test('an area with too little to fill its share leaves the rest to the others', () => {
  const extended = extendGuestPage(composeGuestPage(domain, CS_MED, PAGE), [...domain, ...pubmed.slice(0, 2)], CS_MED, PAGE);

  assert.equal(extended.length, PAGE);
  assert.equal(count(extended, 'med'), 2);
  assert.equal(count(extended, 'cs'), 10);
});

test('papers from an area nobody chose only fill what the chosen areas cannot', () => {
  const physics = papers('arxiv', ['astro-ph.CO'], 5, 'physics');
  const full = extendGuestPage([], [...physics, ...arxiv, ...pubmed], CS_MED, PAGE);
  assert.equal(count(full, 'physics'), 0);

  const short = extendGuestPage([], [...physics, ...arxiv.slice(0, 3), ...pubmed.slice(0, 3)], CS_MED, PAGE);
  assert.equal(short.length, 11);
  assert.equal(count(short, 'physics'), 5);
  assert.deepEqual(areasOf(short).slice(-5), ['physics', 'physics', 'physics', 'physics', 'physics']);
});

test('without chosen areas the page is what the sources returned, in order', () => {
  const mixed = [...arxiv, ...pubmed];
  assert.deepEqual(composeGuestPage(mixed, DEFAULT_PLAN, PAGE), mixed.slice(0, PAGE));
  assert.deepEqual(extendGuestPage(mixed.slice(0, 4), mixed, DEFAULT_PLAN, PAGE), mixed.slice(0, PAGE));
});

test('the first paint waits for every chosen area, and only for four papers without areas', () => {
  assert.equal(guestPageReady(domain, CS_MED, PAGE), false);
  assert.equal(guestPageReady([...domain, ...pubmed.slice(0, 1)], CS_MED, PAGE), false);
  assert.equal(guestPageReady([...domain, ...pubmed.slice(0, 2)], CS_MED, PAGE), true);
  assert.equal(guestPageReady(arxiv.slice(0, 3), DEFAULT_PLAN, PAGE), false);
  assert.equal(guestPageReady(arxiv.slice(0, 4), DEFAULT_PLAN, PAGE), true);
});

// The five arrival orders measured or modelled in the audit (2026-09-23),
// each of which put a single branch on the whole page. `arrived` is what has
// answered when the first paint is taken (the first moment the page is
// ready), `all` what the late pool holds once every branch has settled.
const SCENARIOS = [
  { name: 'arXiv 502, the domain branch cached at 4 ms, PubMed at 2 s', steps: [domain, pubmed] },
  { name: 'PubMed from its local cache first, the rest 2 ms later', steps: [pubmed, domain, arxiv] },
  { name: 'all four branches in the same tick', steps: [[...arxiv, ...domain, ...pubmed]] },
  { name: 'arXiv 300 ms ahead of everyone', steps: [arxiv, [...domain, ...pubmed]] },
  { name: 'PubMed 50 ms ahead of everyone', steps: [pubmed, [...arxiv, ...domain]] },
];

for (const scenario of SCENARIOS) {
  test(`both chosen areas are on the page when ${scenario.name}`, () => {
    const answered = [];
    let early = null;
    for (const step of scenario.steps) {
      answered.push(...step);
      if (!early && guestPageReady(answered, CS_MED, PAGE)) early = composeGuestPage(answered, CS_MED, PAGE);
    }
    const page = extendGuestPage(early || [], answered, CS_MED, PAGE);

    assert.equal(page.length, PAGE);
    assert.ok(count(page, 'cs') >= 5, `cs: ${count(page, 'cs')}`);
    assert.ok(count(page, 'med') >= 5, `med: ${count(page, 'med')}`);
  });
}
