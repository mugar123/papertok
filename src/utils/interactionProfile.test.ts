import type { InteractionDocument, InteractionDocumentData } from './interactionProfile.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  CURATED_ID_CAPS,
  INTERACTION_PROFILE_SCHEMA_VERSION,
  MAX_AFFINITY_JSON_BYTES,
  MAX_CURATED_JSON_BYTES,
  MAX_VIEWED_IDS,
  buildProfileFromInteractionDocuments,
  createEmptyInteractionProfile,
  curatedIds,
  deserializeInteractionProfile,
  interactionProfileNeedsRebuild,
  isPaperKnown,
  lacksLearnedAffinities,
  positiveExamples,
  readProfileSignals,
  recordInteractionEvent,
  seedLearnedAffinities,
  serializeInteractionProfile,
  viewedIds,
} from './interactionProfile.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

/**
 * The category affinity rules, stated on their own: every interaction decays
 * by `max(0.2, exp(-ageDays/30))`; a like is +5, a save +8, an opened PDF +4,
 * a skip -1, a PDF bounce -2 and a rejection -3 on the category. A view is
 * judged against the reader's median dwell, which starts at 6 s and moves 5%
 * towards each view, oldest first, inside [2, 60]: 0 at the median, +7.5 per
 * doubling above it up to +15, -1 per halving below it down to -1.
 */
function referenceFullScan(documents: InteractionDocument[], now: number) {
  let median = 6;
  const viewImpacts = new Map<string, number>();
  [...documents].reverse().forEach(({ id, data }) => {
    if (!(Number(data.viewTime) > 0)) return;
    const seconds = Number(data.viewTime);
    const doublings = Math.log2(seconds / median);
    viewImpacts.set(id, doublings >= 0 ? Math.min(doublings, 2) * 7.5 : Math.max(doublings, -1));
    const step = median * 0.05;
    median = Math.max(2, Math.min(60, median + (seconds > median ? step : seconds < median ? -step : 0)));
  });

  const affinities: Record<string, number> = {};
  documents.forEach(({ id, data }) => {
    const category = data.paperCategory;
    if (!category) return;
    if (!affinities[category]) affinities[category] = 0;

    let decayFactor = 1;
    if (data.timestamp) {
      const daysOld = (now - new Date(data.timestamp).getTime()) / DAY_MS;
      decayFactor = Math.max(0.2, Math.exp(-daysOld / 30));
    }

    let impact = viewImpacts.get(id) || 0;
    if (data.liked) impact += 5;
    if (data.saved) impact += 8;
    if (data.openedPdf) impact += 4;
    if (data.skip) impact -= 1;
    if (data.pdfBounce) impact -= 2;
    if (data.notInterested) impact -= 3;
    affinities[category] += impact * decayFactor;
  });

  Object.keys(affinities).forEach((category) => {
    affinities[category] = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, affinities[category]));
  });
  return affinities;
}

// Newest first, the order the loader and the backfill script pass.
function makeDocuments(count: number, { spanDays = 30, seed = 1 } = {}) {
  const categories = ['cs.AI', 'cs.LG', 'quant-ph', 'math.NT', 'q-bio.NC'];
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  return Array.from({ length: count }, (_unused, index) => {
    const ageDays = random() * spanDays;
    const data: InteractionDocumentData = {
      paperCategory: categories[index % categories.length],
      timestamp: new Date(NOW - ageDays * DAY_MS).toISOString(),
    };
    const roll = random();
    if (roll < 0.05) data.liked = true;
    else if (roll < 0.09) data.saved = true;
    else if (roll < 0.13) data.notInterested = true;
    else if (roll < 0.2) data.openedPdf = true;
    else if (roll < 0.25) data.read = true;
    else data.skip = 1 + Math.floor(random() * 3);
    if (random() < 0.6) data.viewTime = Number((random() * 90).toFixed(2));
    return { id: `arxiv:24${String(index).padStart(5, '0')}`, data };
  }).sort((a, b) => Date.parse(b.data.timestamp as string) - Date.parse(a.data.timestamp as string));
}

function assertMapsClose(actual: Record<string,number>, expected: Record<string,number>, tolerance: number, label: string) {
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    `${label}: category sets differ`,
  );
  Object.keys(expected).forEach((category) => {
    const difference = Math.abs(actual[category] - expected[category]);
    const scale = Math.max(1, Math.abs(expected[category]));
    assert.ok(
      difference / scale <= tolerance,
      `${label}: ${category} was ${actual[category]}, expected ~${expected[category]}`,
    );
  });
}

const categoryAffinities = (profile: Parameters<typeof readProfileSignals>[0]) => readProfileSignals(profile, NOW).categoryAffinities;

function assertClose(actual: number | undefined, expected: number, message?: string) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, message || `${actual} is not ${expected}`);
}

test('a new profile is empty and at the current schema version', () => {
  const profile = createEmptyInteractionProfile();
  assert.equal(profile.version, INTERACTION_PROFILE_SCHEMA_VERSION);
  assert.deepEqual(readProfileSignals(profile, NOW), {
    categoryAffinities: {},
    conceptAffinities: {},
    authorAffinities: {},
    sessionAffinities: {},
    categoryExposure: {},
    interactionCount: 0,
    dwellMedianSeconds: 6,
  });
  assert.equal(curatedIds(profile, 'liked').length, 0);
  assert.equal(isPaperKnown(profile, 'arxiv:2401.00001'), false);
});

test('records interactions incrementally into the curated sets', () => {
  const profile = createEmptyInteractionProfile();

  recordInteractionEvent(profile, { paperId: 'a', kind: 'like', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'b', kind: 'save', category: 'cs.LG' }, NOW);
  recordInteractionEvent(profile, { paperId: 'c', kind: 'read', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'd', kind: 'notInterested', category: 'math.NT' }, NOW);

  assert.deepEqual(curatedIds(profile, 'liked'), ['a']);
  assert.deepEqual(curatedIds(profile, 'saved'), ['b']);
  assert.deepEqual(curatedIds(profile, 'read'), ['c']);
  assert.deepEqual(curatedIds(profile, 'notInterested'), ['d']);
  assert.equal(profile.counters.interactions, 4);

  ['a', 'b', 'c', 'd'].forEach(id => assert.equal(isPaperKnown(profile, id), true));
  assert.equal(isPaperKnown(profile, 'e'), false);
});

test('undoing an interaction removes it from the curated set and the affinity', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'a', kind: 'like', category: 'cs.AI' }, NOW);
  assert.ok(categoryAffinities(profile)['cs.AI'] > 4.9);

  recordInteractionEvent(profile, { paperId: 'a', kind: 'unlike', category: 'cs.AI' }, NOW);
  assert.deepEqual(curatedIds(profile, 'liked'), []);
  assert.ok(Math.abs(categoryAffinities(profile)['cs.AI']) < 1e-9);

  recordInteractionEvent(profile, { paperId: 'r', kind: 'read', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'r', kind: 'unread' }, NOW);
  assert.deepEqual(curatedIds(profile, 'read'), []);
});

test('unsaving takes the paper out of the saved set and gives the affinity back', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 's', kind: 'save', category: 'cs.AI' }, NOW);
  assert.deepEqual(curatedIds(profile, 'saved'), ['s']);
  assert.ok(categoryAffinities(profile)['cs.AI'] > 7.9);

  recordInteractionEvent(profile, { paperId: 's', kind: 'unsave', category: 'cs.AI' }, NOW);
  assert.deepEqual(curatedIds(profile, 'saved'), []);
  assert.ok(Math.abs(categoryAffinities(profile)['cs.AI']) < 1e-9);
});

test('a rejection lands on the paper\'s concepts and authors, and only lightly on its category', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, {
    paperId: 'p',
    kind: 'notInterested',
    category: 'cs.CL',
    concepts: [{ id: 'C-benchmarks', score: 1 }],
    authorIds: ['A1'],
  }, NOW);
  const signals = readProfileSignals(profile, NOW);

  assertClose(signals.categoryAffinities['cs.CL'], -3);
  assert.equal(signals.categoryAffinities['cs.AI'], undefined, 'a sibling category is left alone');
  assertClose(signals.conceptAffinities['C-benchmarks'], -10);
  assertClose(signals.authorAffinities.A1, -10);
  assertClose(signals.sessionAffinities['cs.CL'], -3, 'nor does the session sink the whole category');
  assertClose(signals.sessionAffinities['C-benchmarks'], -10);
});

test('undoing a rejection gives back everything it took', () => {
  const profile = createEmptyInteractionProfile();
  const rejection = {
    paperId: 'p',
    category: 'cs.CL',
    concepts: [{ id: 'C-benchmarks', score: 1 }],
    authorIds: ['A1'],
  };
  recordInteractionEvent(profile, { ...rejection, kind: 'like' }, NOW);
  recordInteractionEvent(profile, { ...rejection, kind: 'notInterested' }, NOW);
  assert.deepEqual(positiveExamples(profile), [], 'a rejected paper is no example');

  recordInteractionEvent(profile, { ...rejection, kind: 'undoNotInterested' }, NOW);
  const signals = readProfileSignals(profile, NOW);
  assert.deepEqual(curatedIds(profile, 'notInterested'), []);
  assertClose(signals.categoryAffinities['cs.CL'], 5, 'only the like is left on the category');
  assertClose(signals.conceptAffinities['C-benchmarks'], 5);
  assertClose(signals.authorAffinities.A1, 5);
  assert.deepEqual(positiveExamples(profile).map(example => example.id), ['p'], 'still liked, so an example again');
});

test('reproduces the affinities of the full subcollection scan', () => {
  const documents = makeDocuments(3000, { spanDays: 40 });
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });

  assertMapsClose(categoryAffinities(profile), referenceFullScan(documents, NOW), 1e-9, 'recent history');
});

test('reproduces the full scan across a two year history, floor included', () => {
  const documents = makeDocuments(3000, { spanDays: 730, seed: 7 });
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });

  // Interactions past the 0.2 decay floor are aggregated a day-bucket at a time
  // rather than one by one, which costs a fraction of a percent at the boundary.
  assertMapsClose(categoryAffinities(profile), referenceFullScan(documents, NOW), 0.01, 'long history');
});

test('the incremental path agrees with a rebuild from the same interactions', () => {
  const documents = makeDocuments(400, { spanDays: 20, seed: 3 });
  const rebuilt = categoryAffinities(buildProfileFromInteractionDocuments(documents, { now: NOW }));

  // The events arrive oldest first, as they happened.
  const incremental = createEmptyInteractionProfile();
  [...documents].reverse().forEach(({ id, data }) => {
    const shared = { paperId: id, category: data.paperCategory, timestamp: data.timestamp };
    if (data.liked) recordInteractionEvent(incremental, { ...shared, kind: 'like' }, NOW);
    if (data.saved) recordInteractionEvent(incremental, { ...shared, kind: 'save' }, NOW);
    if (data.openedPdf) recordInteractionEvent(incremental, { ...shared, kind: 'openedPdf' }, NOW);
    if (data.notInterested) {
      recordInteractionEvent(incremental, { ...shared, kind: 'notInterested' }, NOW);
    }
    if (data.skip) recordInteractionEvent(incremental, { ...shared, kind: 'skip' }, NOW);
    if (data.viewTime) {
      recordInteractionEvent(incremental, { ...shared, kind: 'viewTime', viewTime: data.viewTime }, NOW);
    }
  });

  assertMapsClose(categoryAffinities(incremental), rebuilt, 1e-9, 'incremental vs rebuild');
});

test('a rebuild keeps the newest like first, as the incremental path does', () => {
  // Newest first, the order the loader and the backfill script pass.
  const documents = ['c', 'b', 'a'].map((id, index) => ({
    id,
    data: { liked: true, paperCategory: 'cs.AI', timestamp: new Date(NOW - index * DAY_MS).toISOString() },
  }));
  const rebuilt = buildProfileFromInteractionDocuments(documents, { now: NOW });

  const incremental = createEmptyInteractionProfile();
  [...documents].reverse().forEach(({ id, data }) => {
    recordInteractionEvent(
      incremental,
      { paperId: id, kind: 'like', category: data.paperCategory, timestamp: data.timestamp },
      NOW,
    );
  });

  assert.deepEqual(curatedIds(rebuilt, 'liked'), ['c', 'b', 'a']);
  assert.deepEqual(curatedIds(rebuilt, 'liked'), curatedIds(incremental, 'liked'));
});

test('a rebuild over the cap keeps the newest likes', () => {
  const overflow = 5;
  const total = CURATED_ID_CAPS.liked + overflow;
  // Newest first: p0 is the latest like.
  const documents = Array.from({ length: total }, (_, index) => ({ id: `p${index}`, data: { liked: true } }));
  const liked = curatedIds(buildProfileFromInteractionDocuments(documents, { now: NOW }), 'liked');

  assert.equal(liked.length, CURATED_ID_CAPS.liked);
  assert.equal(liked[0], 'p0');
  assert.equal(liked.includes(`p${CURATED_ID_CAPS.liked - 1}`), true);
  assert.equal(liked.includes(`p${CURATED_ID_CAPS.liked}`), false);
});

test('affinities stay inside the clamp however lopsided the history', () => {
  const profile = createEmptyInteractionProfile();
  for (let index = 0; index < 500; index += 1) {
    recordInteractionEvent(profile, { paperId: `p${index}`, kind: 'save', category: 'cs.AI' }, NOW);
    recordInteractionEvent(
      profile,
      { paperId: `n${index}`, kind: 'notInterested', category: 'math.NT' },
      NOW,
    );
  }
  Object.values(categoryAffinities(profile)).forEach((value) => {
    assert.ok(value >= AFFINITY_MIN && value <= AFFINITY_MAX, `${value} escaped the clamp`);
  });
});

test('survives serialisation and reload', () => {
  const documents = makeDocuments(500, { spanDays: 25, seed: 11 });
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });
  const stored = serializeInteractionProfile(profile);
  const reloaded = deserializeInteractionProfile(stored);

  assert.equal(stored.schemaVersion, INTERACTION_PROFILE_SCHEMA_VERSION);
  assertMapsClose(categoryAffinities(reloaded), categoryAffinities(profile), 1e-4, 'after a round trip');
  assert.deepEqual(
    curatedIds(reloaded, 'liked').sort(),
    curatedIds(profile, 'liked').sort(),
  );
});

test('a document from another schema version is rejected so it gets rebuilt', () => {
  const stored = serializeInteractionProfile(
    buildProfileFromInteractionDocuments(makeDocuments(10), { now: NOW }),
  );

  assert.ok(deserializeInteractionProfile(stored));
  assert.equal(interactionProfileNeedsRebuild(stored), false);

  assert.equal(deserializeInteractionProfile({ ...stored, schemaVersion: 0 }), null);
  assert.equal(interactionProfileNeedsRebuild({ ...stored, schemaVersion: 0 }), true);
  assert.equal(interactionProfileNeedsRebuild({ ...stored, affinities: '{oops' }), true);
  assert.equal(interactionProfileNeedsRebuild(null), true);
  assert.equal(interactionProfileNeedsRebuild({}), true);
});

test('overflowing a curated cap moves the oldest ids into the seen filter', () => {
  const profile = createEmptyInteractionProfile();
  const overflow = 50;
  const total = CURATED_ID_CAPS.liked + overflow;

  for (let index = 0; index < total; index += 1) {
    recordInteractionEvent(profile, { paperId: `p${index}`, kind: 'like', category: 'cs.AI' }, NOW);
  }

  assert.equal(curatedIds(profile, 'liked').length, CURATED_ID_CAPS.liked);
  assert.equal(profile.counters.evicted, overflow);
  // Evicted or not, the feed must never offer any of them again.
  for (let index = 0; index < total; index += 1) {
    assert.equal(isPaperKnown(profile, `p${index}`), true, `p${index} came back`);
  }
});

test('stays well inside the 1 MiB document limit at every cap', () => {
  const profile = createEmptyInteractionProfile();
  Object.entries(CURATED_ID_CAPS).forEach(([name, cap]) => {
    const kind = { liked: 'like', saved: 'save', read: 'read', notInterested: 'notInterested', readLater: 'readLater' }[name];
    for (let index = 0; index < cap; index += 1) {
      recordInteractionEvent(
        profile,
        { paperId: `10.1000/journal.${name}.${index}`, kind: kind!, category: 'cs.AI' },
        NOW,
      );
    }
  });
  for (let index = 0; index < 60000; index += 1) {
    profile.seenFilter?.add(`evicted:${index}`);
  }

  const stored = serializeInteractionProfile(profile);
  const bytes = Object.entries(stored)
    .reduce((sum, [key, value]) => sum + key.length + (typeof value === 'string' ? value.length : 8), 0);

  assert.ok(stored.curated.length <= MAX_CURATED_JSON_BYTES, `curated is ${stored.curated.length}`);
  assert.ok(bytes < 1048576 * 0.75, `document would be ${bytes} bytes, too close to the 1 MiB limit`);
});

test('a view counts against the reader\'s median dwell, not in raw seconds', () => {
  const viewOf = (seconds: number) => {
    const profile = createEmptyInteractionProfile();
    recordInteractionEvent(profile, { paperId: 'p', kind: 'viewTime', category: 'cs.AI', viewTime: seconds }, NOW);
    return categoryAffinities(profile)['cs.AI'];
  };

  // A new reader's median is six seconds.
  assertClose(viewOf(6), 0, 'a view at the median says nothing');
  assertClose(viewOf(12), 7.5, 'twice the median');
  assertClose(viewOf(24), 15, 'four times the median');
  assertClose(viewOf(600), 15, 'a tab left open is worth no more than a long read');
  assertClose(viewOf(3), -1, 'half the median weighs what a skip does');
  assertClose(viewOf(1), -1, 'and no more');
});

test('the median follows the reader, so a habitual pace stops counting as interest', () => {
  const profile = createEmptyInteractionProfile();
  for (let index = 0; index < 100; index += 1) {
    recordInteractionEvent(profile, { paperId: `p${index}`, kind: 'viewTime', category: 'cs.LG', viewTime: 20 }, NOW);
  }
  recordInteractionEvent(profile, { paperId: 'q', kind: 'viewTime', category: 'cs.AI', viewTime: 20 }, NOW);

  // Against a fresh six-second median, twenty seconds would be worth +13.
  assert.ok(Math.abs(categoryAffinities(profile)['cs.AI']) < 1, `${categoryAffinities(profile)['cs.AI']}`);
  assert.ok(Math.abs(readProfileSignals(profile, NOW).dwellMedianSeconds - 20) < 1.5);
});

test('likes, saves and long reads become examples, newest first; undoing or rejecting takes them back', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'liked', kind: 'like', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'glanced', kind: 'viewTime', category: 'cs.LG', viewTime: 7 }, NOW);
  recordInteractionEvent(profile, { paperId: 'read', kind: 'viewTime', category: 'q-bio.NC', viewTime: 30 }, NOW);
  recordInteractionEvent(profile, { paperId: 'saved', kind: 'save', category: 'quant-ph' }, NOW);

  assert.deepEqual(positiveExamples(profile), [
    { id: 'saved', category: 'quant-ph' },
    { id: 'read', category: 'q-bio.NC' },
    { id: 'liked', category: 'cs.AI' },
  ]);

  recordInteractionEvent(profile, { paperId: 'liked', kind: 'unlike', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'read', kind: 'notInterested', category: 'q-bio.NC' }, NOW);
  assert.deepEqual(positiveExamples(profile), [{ id: 'saved', category: 'quant-ph' }]);

  // Still liked, so still an example after the save is undone.
  recordInteractionEvent(profile, { paperId: 'saved', kind: 'like', category: 'quant-ph' }, NOW);
  recordInteractionEvent(profile, { paperId: 'saved', kind: 'unsave', category: 'quant-ph' }, NOW);
  assert.deepEqual(positiveExamples(profile), [{ id: 'saved', category: 'quant-ph' }]);
});

test('a rebuild recovers the examples and the exposure from the documents', () => {
  const documents = [
    { id: 'skipped', data: { skip: 2, paperCategory: 'cs.LG', timestamp: NOW - 1000 } },
    { id: 'liked', data: { liked: true, viewTime: 4, paperCategory: 'cs.AI', timestamp: NOW - 2000 } },
    { id: 'rejected', data: { notInterested: true, viewTime: 40, paperCategory: 'cs.AI', timestamp: NOW - 3000 } },
  ];
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });

  assert.deepEqual(positiveExamples(profile), [{ id: 'liked', category: 'cs.AI' }]);
  assert.deepEqual(readProfileSignals(profile, NOW).categoryExposure, {
    'cs.AI': { shown: 2, engaged: 1 },
    'cs.LG': { shown: 1, engaged: 0 },
  });
});

/*
 * PAP-60. An old like kept the category the feed showed beside the paper's
 * copy, and the feed showed the category it had been asked for. The copy says
 * which of those values a rebuild can trust: the primary arXiv lists first for
 * a paper stored under its arXiv id, nothing for a Europe PMC copy.
 */
test('a rebuild counts an old like under the category its stored copy can show', () => {
  const documents = [
    { id: '2605.02209', data: {
      liked: true, paperCategory: 'cs.LG', timestamp: NOW - 1000,
      paper: { id: '2605.02209', title: 'T', primaryCategory: 'cs.LG', categories: ['cs.AI', 'cs.LG'] },
    } },
    { id: 'pmid:42820985', data: {
      liked: true, paperCategory: 'bio.gen', timestamp: NOW - 2000,
      paper: { id: 'pmid:42820985', title: 'T', primaryCategory: 'bio.gen', categories: ['bio.gen'] },
    } },
  ];
  const signals = readProfileSignals(buildProfileFromInteractionDocuments(documents, { now: NOW }), NOW);
  assert.deepEqual(Object.keys(signals.categoryAffinities), ['cs.AI']);
  assert.ok(signals.categoryAffinities['cs.AI'] > 0);
});

// OpenAlex cards carried a concept name where a category belongs, and the
// profile learned it as one.
test('a concept name the profile learned is not read back as a category', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'openalex:W2120490784', kind: 'like', category: 'Somatic cell nuclear transfer' }, NOW);
  recordInteractionEvent(profile, { paperId: '2605.02209', kind: 'like', category: 'cs.AI' }, NOW);
  assert.deepEqual(Object.keys(readProfileSignals(profile, NOW).categoryAffinities), ['cs.AI']);
});

test('exposure counts every card shown and the ones read past the median', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'a', kind: 'skip', category: 'math.NT' }, NOW);
  recordInteractionEvent(profile, { paperId: 'b', kind: 'viewTime', category: 'math.NT', viewTime: 2 }, NOW);
  recordInteractionEvent(profile, { paperId: 'c', kind: 'viewTime', category: 'math.NT', viewTime: 30 }, NOW);

  assert.deepEqual(readProfileSignals(profile, NOW).categoryExposure, { 'math.NT': { shown: 3, engaged: 1 } });
});

test('concepts and authors decay over thirty days', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, {
    paperId: 'old',
    kind: 'like',
    category: 'cs.AI',
    timestamp: NOW - 30 * DAY_MS,
    concepts: [{ id: 'C1', score: 0.5 }],
    authorIds: ['A1'],
  }, NOW);
  const signals = readProfileSignals(profile, NOW);

  assertClose(signals.conceptAffinities.C1, 2.5 * Math.exp(-1), 'a like weighs the concept by its score');
  assertClose(signals.authorAffinities.A1, 5 * Math.exp(-1));
});

test('the session remembers the last few cards and fades with every new one', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, {
    paperId: 'liked', kind: 'like', category: 'cs.AI', concepts: [{ id: 'C1', score: 1 }],
  }, NOW);
  assertClose(readProfileSignals(profile, NOW).sessionAffinities['cs.AI'], 5);
  assertClose(readProfileSignals(profile, NOW).sessionAffinities.C1, 5);

  for (let index = 0; index < 10; index += 1) {
    recordInteractionEvent(profile, { paperId: `s${index}`, kind: 'skip', category: 'math.NT' }, NOW);
  }
  assertClose(readProfileSignals(profile, NOW).sessionAffinities['cs.AI'], 5 * 0.85 ** 10);

  const reloaded = deserializeInteractionProfile(serializeInteractionProfile(profile));
  assert.deepEqual(readProfileSignals(reloaded, NOW).sessionAffinities, {}, 'a session does not outlive the tab');
});

test('the learned maps, the examples, the exposure and the median survive a reload', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, {
    paperId: 'a', kind: 'save', category: 'cs.AI', concepts: [{ id: 'C1', score: 0.8 }], authorIds: ['A1'],
  }, NOW - DAY_MS);
  recordInteractionEvent(profile, { paperId: 'b', kind: 'viewTime', category: 'cs.LG', viewTime: 30 }, NOW);
  const reloaded = deserializeInteractionProfile(serializeInteractionProfile(profile));
  const before = readProfileSignals(profile, NOW);
  const after = readProfileSignals(reloaded, NOW);

  assert.ok(Math.abs(after.conceptAffinities.C1 - before.conceptAffinities.C1) < 1e-3);
  assert.ok(Math.abs(after.authorAffinities.A1 - before.authorAffinities.A1) < 1e-3);
  assert.deepEqual(after.categoryExposure, before.categoryExposure);
  assert.equal(after.dwellMedianSeconds, before.dwellMedianSeconds);
  assert.deepEqual(positiveExamples(reloaded), positiveExamples(profile));
});

test('an aggregate stored before the examples existed takes its likes and saves as examples', () => {
  const stored = serializeInteractionProfile(buildProfileFromInteractionDocuments([
    { id: 'saved', data: { saved: true, paperCategory: 'cs.AI', timestamp: NOW } },
    { id: 'liked', data: { liked: true, paperCategory: 'cs.LG', timestamp: NOW - DAY_MS } },
  ], { now: NOW }));
  const legacy = JSON.parse(stored.affinities);
  delete legacy.positives;
  legacy.cooldowns = { 'cs.LG': NOW };

  const reloaded = deserializeInteractionProfile({ ...stored, affinities: JSON.stringify(legacy) });
  assert.deepEqual(positiveExamples(reloaded), [
    { id: 'liked', category: '' },
    { id: 'saved', category: '' },
  ]);
});

test('the liked papers seed learned affinities as likes, joining what the reader added meanwhile', () => {
  const profile = createEmptyInteractionProfile();
  assert.equal(lacksLearnedAffinities(profile), true);

  // The reader likes a paper while the enrichment of the old likes is in flight.
  recordInteractionEvent(profile, { paperId: 'new', kind: 'like', category: 'cs.AI', concepts: [{ id: 'C1', score: 1 }] }, NOW);
  seedLearnedAffinities(profile, [{ concepts: [{ id: 'C1', score: 1 }], authorIds: ['A1'] }], NOW);

  assertClose(readProfileSignals(profile, NOW).conceptAffinities.C1, 10);
  assertClose(readProfileSignals(profile, NOW).authorAffinities.A1, 5);
  assert.equal(lacksLearnedAffinities(profile), false);
});

test('a heavily used profile keeps its learned maps inside the stored budget', () => {
  const profile = createEmptyInteractionProfile();
  for (let index = 0; index < 2000; index += 1) {
    recordInteractionEvent(profile, {
      paperId: `p${index}`,
      kind: 'like',
      category: `cat.${index % 120}`,
      timestamp: NOW - (index % 45) * DAY_MS,
      concepts: Array.from({ length: 12 }, (_, offset) => ({ id: `C${index * 12 + offset}`, score: 0.5 })),
      authorIds: Array.from({ length: 10 }, (_, offset) => `A${index * 10 + offset}`),
    }, NOW);
  }

  const stored = serializeInteractionProfile(profile);
  assert.ok(stored.affinities.length <= MAX_AFFINITY_JSON_BYTES, `affinities are ${stored.affinities.length}`);
  assert.ok(Object.keys(readProfileSignals(deserializeInteractionProfile(stored), NOW).conceptAffinities).length > 0);
});

// The ring of papers the reader really viewed: what lets a second device skip
// them. A view and a skip both leave an interaction document, so both count; a
// like of a paper never shown does not, and the ring is never a reason to hide
// a paper for good.
const viewEvent = (paperId: string, kind = 'viewTime') => ({ paperId, kind, category: 'cs.AI', viewTime: 4 });
const ringId = (index: number, width = 24) => `10.1000/${String(index).padStart(width - 8, '0')}`;
const CURATED_NAMES = ['liked', 'saved', 'read', 'notInterested', 'readLater'] as const;

test('a viewed or skipped paper joins the viewed ring, newest first, and a like alone does not', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, viewEvent('read-for-4s'), NOW);
  recordInteractionEvent(profile, viewEvent('flicked-past', 'skip'), NOW);
  recordInteractionEvent(profile, { paperId: 'liked-from-search', kind: 'like', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, viewEvent('read-again'), NOW);
  recordInteractionEvent(profile, viewEvent('read-for-4s'), NOW);

  assert.deepEqual(viewedIds(profile), ['read-for-4s', 'read-again', 'flicked-past']);
});

test('the viewed ring keeps the last 500 papers, outside the known papers and the seen filter', () => {
  const profile = createEmptyInteractionProfile();
  const total = MAX_VIEWED_IDS + 100;
  for (let index = 0; index < total; index += 1) recordInteractionEvent(profile, viewEvent(ringId(index)), NOW);

  assert.equal(MAX_VIEWED_IDS, 500);
  const ring = viewedIds(profile);
  assert.equal(ring.length, 500);
  assert.equal(ring[0], ringId(total - 1));
  assert.equal(ring[499], ringId(100));
  // A viewed paper may be skipped, never hidden for good: it is not known, and the
  // ring's overflow does not go to the filter the way a curated overflow does.
  assert.equal(isPaperKnown(profile, ringId(total - 1)), false);
  assert.equal(isPaperKnown(profile, ringId(0)), false);
  assert.equal(profile.counters.evicted, 0);
  assert.equal(serializeInteractionProfile(profile).seenFilter, undefined);
});

test('a paper viewed on one device is in the aggregate another device loads, and is still not known there', () => {
  const deviceA = createEmptyInteractionProfile();
  recordInteractionEvent(deviceA, viewEvent('paper-a1'), NOW);
  recordInteractionEvent(deviceA, viewEvent('paper-a2', 'skip'), NOW);
  const stored = serializeInteractionProfile(deviceA);

  const deviceB = deserializeInteractionProfile(stored)!;
  assert.deepEqual(viewedIds(deviceB), ['paper-a2', 'paper-a1']);
  assert.equal(isPaperKnown(deviceB, 'paper-a1'), false);
  // B keeps adding on top of what A saw.
  recordInteractionEvent(deviceB, viewEvent('paper-b1'), NOW);
  assert.deepEqual(viewedIds(deserializeInteractionProfile(serializeInteractionProfile(deviceB))), ['paper-b1', 'paper-a2', 'paper-a1']);
});

test('an aggregate stored before the viewed ring existed loads with an empty ring', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'liked', kind: 'like', category: 'cs.AI' }, NOW);
  const stored = serializeInteractionProfile(profile);

  assert.equal('viewed' in JSON.parse(stored.curated), false);
  const reloaded = deserializeInteractionProfile(stored)!;
  assert.deepEqual(viewedIds(reloaded), []);
  assert.deepEqual(curatedIds(reloaded, 'liked'), ['liked']);
});

test('another account\'s ring is not carried into a fresh profile', () => {
  const accountA = createEmptyInteractionProfile();
  recordInteractionEvent(accountA, viewEvent('private-to-a'), NOW);

  assert.deepEqual(viewedIds(createEmptyInteractionProfile()), []);
  assert.deepEqual(viewedIds(deserializeInteractionProfile(serializeInteractionProfile(createEmptyInteractionProfile()))), []);
  assert.deepEqual(viewedIds(null), []);
});

test('a rebuild from the documents recovers the ring the incremental path built', () => {
  const documents: InteractionDocument[] = ['newest', 'viewed-twice', 'liked-only', 'skipped', 'oldest-view']
    .map((id, index) => {
      const data: InteractionDocumentData = { paperCategory: 'cs.AI', timestamp: new Date(NOW - index * DAY_MS).toISOString() };
      if (id === 'liked-only') data.liked = true;
      else if (id === 'skipped') data.skip = 1;
      else data.viewTime = 5;
      return { id, data };
    });

  const rebuilt = buildProfileFromInteractionDocuments(documents, { now: NOW });
  assert.deepEqual(viewedIds(rebuilt), ['newest', 'viewed-twice', 'skipped', 'oldest-view']);

  const incremental = createEmptyInteractionProfile();
  [...documents].reverse().forEach(({ id, data }) => {
    if (data.viewTime) recordInteractionEvent(incremental, viewEvent(id), NOW);
    if (data.skip) recordInteractionEvent(incremental, viewEvent(id, 'skip'), NOW);
    if (data.liked) recordInteractionEvent(incremental, { paperId: id, kind: 'like', category: 'cs.AI' }, NOW);
  });
  assert.deepEqual(viewedIds(incremental), viewedIds(rebuilt));
});

test('a rebuild over 500 views keeps the newest 500', () => {
  const documents = Array.from({ length: 700 }, (_, index) => ({
    id: ringId(index),
    data: { viewTime: 5, paperCategory: 'cs.AI', timestamp: new Date(NOW - index * 1000).toISOString() },
  }));
  const ring = viewedIds(buildProfileFromInteractionDocuments(documents, { now: NOW }));
  assert.equal(ring.length, 500);
  assert.equal(ring[0], ringId(0));
  assert.equal(ring[499], ringId(499));
});

// The ring is the first thing the curated budget gives up: a reader's likes,
// saves and rejections are what the feed must never repeat, the ring only helps.
test('over the curated budget the viewed ring is trimmed before any curated set', () => {
  const profile = createEmptyInteractionProfile();
  const kinds = { liked: 'like', saved: 'save', read: 'read' } as const;
  Object.entries(kinds).forEach(([name, kind]) => {
    for (let index = 0; index < CURATED_ID_CAPS[name as keyof typeof kinds]; index += 1) {
      recordInteractionEvent(profile, { paperId: `${name}:${ringId(index)}`, kind, category: 'cs.AI' }, NOW);
    }
  });
  const curatedBytes = () => JSON.stringify(Object.fromEntries(CURATED_NAMES.map(name => [name, curatedIds(profile, name)]))).length;
  // Fill the room below the budget, leaving 8 kB: the 500 views need about 17 kB.
  let index = 0;
  while (curatedBytes() < MAX_CURATED_JSON_BYTES - 8000) {
    recordInteractionEvent(profile, { paperId: `notInterested:${ringId(index)}`, kind: 'notInterested', category: 'cs.AI' }, NOW);
    index += 1;
  }
  assert.ok(index > 0 && index < CURATED_ID_CAPS.notInterested, `the fixture needs ${index} rejections`);
  const before = CURATED_NAMES.map(name => curatedIds(profile, name).length);
  for (let view = 0; view < MAX_VIEWED_IDS; view += 1) recordInteractionEvent(profile, viewEvent(ringId(view)), NOW);

  const curated = JSON.parse(serializeInteractionProfile(profile).curated);
  assert.deepEqual(CURATED_NAMES.map(name => curated[name].length), before, 'no curated set lost an id to make room for the ring');
  assert.ok(curated.viewed.length > 0 && curated.viewed.length < MAX_VIEWED_IDS, `the ring was trimmed to ${curated.viewed.length}`);
  assert.deepEqual(curated.viewed, viewedIds(profile).slice(0, curated.viewed.length), 'the newest views are the ones kept');
  assert.ok(JSON.stringify(curated).length <= MAX_CURATED_JSON_BYTES);
  assert.equal(profile.counters.evicted, 0, 'nothing trimmed went to the seen filter');
});

test('a ring on top of curated sets already past the budget is dropped before they are cut, and is not known afterwards', () => {
  const profile = createEmptyInteractionProfile();
  const kinds = { liked: 'like', saved: 'save', read: 'read', notInterested: 'notInterested' } as const;
  Object.entries(kinds).forEach(([name, kind]) => {
    for (let index = 0; index < CURATED_ID_CAPS[name as keyof typeof kinds]; index += 1) {
      recordInteractionEvent(profile, { paperId: `${name}:${ringId(index, 40)}`, kind, category: 'cs.AI' }, NOW);
    }
  });
  for (let view = 0; view < 20; view += 1) recordInteractionEvent(profile, viewEvent(ringId(view)), NOW);

  const stored = serializeInteractionProfile(profile);
  const curated = JSON.parse(stored.curated);
  assert.ok(stored.curated.length <= MAX_CURATED_JSON_BYTES);
  assert.equal(curated.viewed, undefined, 'the ring went first');
  assert.equal(isPaperKnown(deserializeInteractionProfile(stored), ringId(0)), false, 'the dropped ring is not in the filter');
});
