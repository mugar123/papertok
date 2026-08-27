import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScientificReportEditions,
  calculateScientificImpactSignals,
  countSelections,
} from './scientificReportRanking.js';

function paper(id, category, citations, extra = {}) {
  return {
    id,
    title: `Paper ${id}`,
    abstract: 'A'.repeat(300),
    authors: [{ name: `Author ${id}` }],
    primaryCategory: category,
    categories: [category],
    allCategories: [category],
    citationCount: citations,
    published: '2026-07-10',
    doi: `10.1/${id}`,
    ...extra,
  };
}

test('uses normalized OpenAlex impact without producing invalid values', () => {
  const signals = calculateScientificImpactSignals(
    paper('one', 'physics', 10, {
      fwci: 2,
      citationNormalizedPercentile: { value: 0.9 },
      institutionCount: 3,
    }),
    '30d',
    new Map(),
    new Date('2026-07-16T12:00:00Z'),
  );

  assert.ok(signals.fieldImpact > 0.5);
  assert.ok(Number.isFinite(signals.score));
  assert.equal(signals.confidence, 'high');
});

test('builds a personal edition from the same corpus while preserving exploration', () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => paper(`physics-${index}`, 'physics', 100 - index)),
    ...Array.from({ length: 6 }, (_, index) => paper(`cs-${index}`, 'cs', 20 - index)),
  ];
  const editions = buildScientificReportEditions(candidates, {
    timeframe: '30d',
    days: 30,
    currentDate: new Date('2026-07-16T12:00:00Z'),
    profile: {
      userPreferences: ['cs'],
      categoryAffinities: { cs: 20 },
      conceptAffinities: {},
      followedAuthors: [],
    },
  });

  const panoramaPapers = [editions.panorama.mainDiscovery, ...editions.panorama.highlights];
  const personalPapers = [editions.personal.mainDiscovery, ...editions.personal.highlights];
  assert.ok(
    personalPapers.filter(item => item.primaryCategory === 'cs').length
      > panoramaPapers.filter(item => item.primaryCategory === 'cs').length,
  );
  assert.ok(personalPapers.filter(item => item.primaryCategory === 'physics').length >= 2);
  assert.equal(editions.panorama.mainDiscovery.primaryCategory, 'physics');
});

test('excludes papers explicitly rejected by the user from the personal corpus', () => {
  const editions = buildScientificReportEditions([
    paper('blocked', 'cs', 100),
    paper('allowed', 'physics', 10),
  ], {
    timeframe: '30d',
    days: 30,
    profile: { userPreferences: ['cs'], notInterestedIds: ['blocked'] },
  });

  assert.equal(editions.personal.mainDiscovery.id, 'allowed');
});

/* ── Selections: reading further down the same period ──
   A selection is a slice of one greedy ordering, not a re-run of it. The
   reader has to be able to walk out to selection 4 and back and find
   selection 1 exactly as they left it. */

function candidate(index) {
  return {
    id: `sel-${index}`,
    title: `Selection candidate ${index}`,
    abstract: 'A'.repeat(320),
    authors: [{ name: `Author ${index}` }],
    primaryCategory: ['physics', 'bio', 'cs', 'math', 'med'][index % 5],
    categories: [['physics', 'bio', 'cs', 'math', 'med'][index % 5]],
    allCategories: [['physics', 'bio', 'cs', 'math', 'med'][index % 5]],
    journal: `Journal ${index % 7}`,
    citationCount: 500 - index,
    published: '2026-08-20',
    doi: `10.1/sel-${index}`,
  };
}

const CANDIDATES = Array.from({ length: 47 }, (_, index) => candidate(index));
const AT = selection => buildScientificReportEditions(CANDIDATES, {
  timeframe: '7d',
  days: 7,
  selection,
  currentDate: new Date('2026-08-26T12:00:00Z'),
});

function idsOf(edition) {
  return [edition.panorama.mainDiscovery, ...edition.panorama.highlights]
    .filter(Boolean)
    .map(paper => paper.id);
}

test('a selection holds a lead story and ten more', () => {
  const first = AT(1);
  assert.equal(first.panorama.mainDiscovery.id.startsWith('sel-'), true);
  assert.equal(first.panorama.highlights.length, 10);
  assert.equal(idsOf(first).length, 11);
});

test('selections do not overlap and cover the ordering in order', () => {
  const seen = new Set();
  let covered = 0;
  for (let selection = 1; selection <= AT(1).selectionCount; selection += 1) {
    for (const id of idsOf(AT(selection))) {
      assert.equal(seen.has(id), false, `${id} appears in two selections`);
      seen.add(id);
      covered += 1;
    }
  }
  assert.equal(covered, CANDIDATES.length);
});

test('walking out to a later selection and back leaves the first untouched', () => {
  const before = idsOf(AT(1));
  AT(4);
  AT(2);
  assert.deepEqual(idsOf(AT(1)), before);
});

test('the count is reported, and the last selection is the short one', () => {
  const first = AT(1);
  // 47 candidates, eleven to a selection: four full-ish and a remainder.
  assert.equal(first.selectionCount, 5);
  assert.equal(first.perSelection, 11);
  assert.equal(idsOf(AT(5)).length, 47 - 4 * 11);
});

test('a selection past the end falls back to the last one that exists', () => {
  const last = AT(5);
  for (const beyond of [6, 40, 999]) {
    assert.equal(AT(beyond).selection, 5);
    assert.deepEqual(idsOf(AT(beyond)), idsOf(last));
  }
});

test('a selection below one is treated as the first', () => {
  const first = idsOf(AT(1));
  for (const under of [0, -3, null, undefined, NaN, 'two']) {
    assert.deepEqual(idsOf(AT(under)), first);
  }
});

test('a period with a single page of candidates offers exactly one selection', () => {
  const thin = buildScientificReportEditions(CANDIDATES.slice(0, 9), {
    timeframe: '7d', days: 7, selection: 1, currentDate: new Date('2026-08-26T12:00:00Z'),
  });
  assert.equal(thin.selectionCount, 1);
  assert.equal(thin.panorama.highlights.length, 8);
});

test('an empty period still reports one selection rather than none', () => {
  const empty = buildScientificReportEditions([], { timeframe: '7d', days: 7, selection: 3 });
  assert.equal(empty.selectionCount, 1);
  assert.equal(empty.selection, 1);
  assert.equal(empty.panorama.mainDiscovery, null);
});

test('the selection count never drops below one, whatever it is handed', () => {
  assert.equal(countSelections(0), 1);
  assert.equal(countSelections(1), 1);
  assert.equal(countSelections(11), 1);
  assert.equal(countSelections(12), 2);
  assert.equal(countSelections(47), 5);
  // A period that reports nonsense still yields a page the reader can open.
  for (const nonsense of [-4, NaN, null, undefined, 'many']) {
    assert.equal(countSelections(nonsense), 1);
  }
});
