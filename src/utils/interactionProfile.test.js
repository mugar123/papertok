import test from 'node:test';
import assert from 'node:assert/strict';

import { CATEGORIES, getCategorySimilarity } from '../data/categories.js';
import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  CURATED_ID_CAPS,
  INTERACTION_PROFILE_SCHEMA_VERSION,
  MAX_CURATED_JSON_BYTES,
  buildProfileFromInteractionDocuments,
  createEmptyInteractionProfile,
  curatedIds,
  deserializeInteractionProfile,
  interactionProfileNeedsRebuild,
  isPaperKnown,
  readCategorySignals,
  recordInteractionEvent,
  serializeInteractionProfile,
} from './interactionProfile.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

/**
 * The affinity maths exactly as FeedContext computed it while reading the whole
 * interactions subcollection. The incremental aggregate has to reproduce this,
 * because reproducing it is what "the ranking does not change" means.
 */
function legacyFullScan(documents, now) {
  const affinities = {};
  const cooldowns = {};

  documents.forEach(({ data }) => {
    const category = data.paperCategory;
    if (!category) return;
    if (!affinities[category]) affinities[category] = 0;

    let decayFactor = 1;
    if (data.timestamp) {
      const timestamp = new Date(data.timestamp).getTime();
      const daysOld = (now - timestamp) / DAY_MS;
      decayFactor = Math.max(0.2, Math.exp(-daysOld / 30));
      if (data.notInterested && (!cooldowns[category] || timestamp > cooldowns[category])) {
        cooldowns[category] = timestamp;
      }
    }

    let impact = 0;
    if (data.liked) impact += 5;
    if (data.saved) impact += 8;
    if (data.openedPdf) impact += 4;
    if (data.viewTime) impact += Math.min(data.viewTime, 60) * 0.25;
    if (data.skip) impact -= 1;
    if (data.pdfBounce) impact -= 2;
    if (data.notInterested) impact -= 10;

    affinities[category] += impact * decayFactor;

    if (data.notInterested) {
      Object.keys(CATEGORIES).forEach((areaKey) => {
        Object.keys(CATEGORIES[areaKey].subcategories).forEach((otherCategory) => {
          if (otherCategory === category) return;
          const similarity = getCategorySimilarity(category, otherCategory);
          if (similarity <= 0) return;
          if (!affinities[otherCategory]) affinities[otherCategory] = 0;
          const penalty = similarity >= 0.8 ? -5 : similarity >= 0.4 ? -3 : -1;
          affinities[otherCategory] += penalty * decayFactor;
        });
      });
    }
  });

  Object.keys(affinities).forEach((category) => {
    affinities[category] = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, affinities[category]));
  });
  return { affinities, cooldowns };
}

function makeDocuments(count, { spanDays = 30, seed = 1 } = {}) {
  const categories = ['cs.AI', 'cs.LG', 'quant-ph', 'math.NT', 'q-bio.NC'];
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };

  return Array.from({ length: count }, (_unused, index) => {
    const ageDays = random() * spanDays;
    const data = {
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
  });
}

function assertMapsClose(actual, expected, tolerance, label) {
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

test('a new profile is empty and at the current schema version', () => {
  const profile = createEmptyInteractionProfile();
  assert.equal(profile.version, INTERACTION_PROFILE_SCHEMA_VERSION);
  assert.deepEqual(readCategorySignals(profile, NOW), { affinities: {}, cooldowns: {} });
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
  assert.ok(readCategorySignals(profile, NOW).affinities['cs.AI'] > 4.9);

  recordInteractionEvent(profile, { paperId: 'a', kind: 'unlike', category: 'cs.AI' }, NOW);
  assert.deepEqual(curatedIds(profile, 'liked'), []);
  assert.ok(Math.abs(readCategorySignals(profile, NOW).affinities['cs.AI']) < 1e-9);

  recordInteractionEvent(profile, { paperId: 'r', kind: 'read', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'r', kind: 'unread' }, NOW);
  assert.deepEqual(curatedIds(profile, 'read'), []);
});

test('not interested spreads a penalty across the same research area only', () => {
  const profile = createEmptyInteractionProfile();
  recordInteractionEvent(profile, { paperId: 'p', kind: 'notInterested', category: 'cs.AI' }, NOW);
  const { affinities, cooldowns } = readCategorySignals(profile, NOW);

  assert.ok(affinities['cs.AI'] < 0);
  assert.ok(affinities['cs.LG'] < 0, 'a sibling cs category should be penalised');
  assert.equal(affinities['q-bio.NC'], undefined, 'another area must be untouched');
  assert.equal(cooldowns['cs.AI'], NOW);
});

test('reproduces the affinities of the full subcollection scan', () => {
  const documents = makeDocuments(3000, { spanDays: 40 });
  const expected = legacyFullScan(documents, NOW);
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });
  const actual = readCategorySignals(profile, NOW);

  assertMapsClose(actual.affinities, expected.affinities, 1e-9, 'recent history');
  assert.deepEqual(actual.cooldowns, expected.cooldowns);
});

test('reproduces the full scan across a two year history, floor included', () => {
  const documents = makeDocuments(3000, { spanDays: 730, seed: 7 });
  const expected = legacyFullScan(documents, NOW);
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });
  const actual = readCategorySignals(profile, NOW);

  // Interactions past the 0.2 decay floor are aggregated a day-bucket at a time
  // rather than one by one, which costs a fraction of a percent at the boundary.
  assertMapsClose(actual.affinities, expected.affinities, 0.01, 'long history');
  assert.deepEqual(actual.cooldowns, expected.cooldowns);
});

test('the incremental path agrees with a rebuild from the same interactions', () => {
  const documents = makeDocuments(400, { spanDays: 20, seed: 3 });
  const rebuilt = readCategorySignals(
    buildProfileFromInteractionDocuments(documents, { now: NOW }),
    NOW,
  );

  const incremental = createEmptyInteractionProfile();
  documents.forEach(({ id, data }) => {
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

  assertMapsClose(
    readCategorySignals(incremental, NOW).affinities,
    rebuilt.affinities,
    1e-9,
    'incremental vs rebuild',
  );
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
  Object.values(readCategorySignals(profile, NOW).affinities).forEach((value) => {
    assert.ok(value >= AFFINITY_MIN && value <= AFFINITY_MAX, `${value} escaped the clamp`);
  });
});

test('survives serialisation and reload', () => {
  const documents = makeDocuments(500, { spanDays: 25, seed: 11 });
  const profile = buildProfileFromInteractionDocuments(documents, { now: NOW });
  const stored = serializeInteractionProfile(profile);
  const reloaded = deserializeInteractionProfile(stored);

  assert.equal(stored.schemaVersion, INTERACTION_PROFILE_SCHEMA_VERSION);
  assertMapsClose(
    readCategorySignals(reloaded, NOW).affinities,
    readCategorySignals(profile, NOW).affinities,
    1e-4,
    'after a round trip',
  );
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
        { paperId: `10.1000/journal.${name}.${index}`, kind, category: 'cs.AI' },
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
