import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRIFT_MIN_MISSING_DOCS,
  INTERACTION_PROFILE_STATUS,
  REBUILD_MAX_DOCUMENTS,
  driftRebuildThreshold,
  hasInteractionProfile,
  loadInteractionProfile,
  rebuildInteractionProfile,
} from './interactionProfileLoader.js';
import {
  createEmptyInteractionProfile,
  curatedIds,
  recordInteractionEvent,
  isPaperKnown,
  readCategorySignals,
  serializeInteractionProfile,
} from './interactionProfile.js';

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const LIKED_EVERY = 20;

function makeInteractions(count) {
  const categories = ['cs.AI', 'cs.LG', 'quant-ph'];
  return Array.from({ length: count }, (_unused, index) => ({
    id: `arxiv:24${String(index).padStart(5, '0')}`,
    data: {
      paperCategory: categories[index % categories.length],
      timestamp: new Date(NOW - (index % 60) * DAY_MS).toISOString(),
      ...(index % LIKED_EVERY === 0 ? { liked: true } : { skip: 1, viewTime: 12 }),
    },
  }));
}

/**
 * Stand-in for Firestore that counts what a feed load actually costs. Every
 * document handed back is one billed read, which is the whole point of the
 * assertions below.
 */
function createFirestoreStub({ aggregate = null, interactions = [], failWrite = false } = {}) {
  const stub = {
    aggregate,
    interactions,
    aggregateReads: 0,
    interactionReads: 0,
    pageCalls: 0,
    writes: 0,
    written: null,
    get totalReads() {
      return this.aggregateReads + this.interactionReads;
    },
    async readAggregate() {
      stub.aggregateReads += 1;
      return { exists: Boolean(stub.aggregate), data: stub.aggregate };
    },
    async listInteractionPage({ pageSize, startAfterId }) {
      stub.pageCalls += 1;
      const ordered = [...stub.interactions].sort((a, b) => (a.id < b.id ? -1 : 1));
      const start = startAfterId ? ordered.findIndex(item => item.id === startAfterId) + 1 : 0;
      const documents = ordered.slice(start, start + pageSize);
      stub.interactionReads += documents.length;
      return { documents, hasMore: start + documents.length < ordered.length };
    },
    async writeAggregate(document) {
      if (failWrite) throw new Error('permission-denied');
      stub.writes += 1;
      stub.written = document;
      stub.aggregate = document;
    },
    countCalls: 0,
    async countInteractions() {
      stub.countCalls += 1;
      const reads = Math.max(1, Math.ceil(stub.interactions.length / 1000));
      stub.countReads = (stub.countReads || 0) + reads;
      return { count: stub.interactions.length, reads };
    },
  };
  return stub;
}

/**
 * Builds an aggregate that has fallen behind its subcollection by `missing`
 * documents, which is what a session that could not write the aggregate leaves
 * behind: the interaction documents exist, the aggregate has never seen them.
 */
function staleAggregate(interactions, missing) {
  const seen = interactions.slice(0, interactions.length - missing);
  const profile = createEmptyInteractionProfile();
  seen.forEach(({ id, data }) => {
    if (data.liked) profile.curated.get('liked').members.add(id);
    if (data.liked) profile.curated.get('liked').order.push(id);
  });
  profile.sourceDocCount = seen.length;
  profile.counters.interactions = seen.length;
  profile.updatedAt = new Date(NOW).toISOString();
  return serializeInteractionProfile(profile);
}

function freshCache() {
  return new Map();
}

test('COST: a feed load for a 3000 interaction account is ONE Firestore read', async () => {
  const interactions = makeInteractions(3000);
  const stub = createFirestoreStub({ interactions });

  // First ever load: no aggregate yet, so the bounded rebuild runs once.
  const cold = await loadInteractionProfile({
    ...stub, userId: 'u1', now: NOW, rebuildCache: freshCache(),
  });
  assert.equal(cold.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(cold.rebuilt, true);
  assert.equal(stub.writes, 1, 'the rebuild has to persist the aggregate');

  // Every load after that, which is every load for the rest of the account's
  // life. If anyone reinstates the full subcollection scan, this fails.
  const warm = createFirestoreStub({ aggregate: stub.written, interactions });
  const result = await loadInteractionProfile({
    ...warm, userId: 'u1', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(warm.totalReads, 1, `a feed load cost ${warm.totalReads} reads, it must cost 1`);
  assert.equal(warm.aggregateReads, 1);
  assert.equal(warm.interactionReads, 0);
  assert.equal(warm.pageCalls, 0, 'the interactions subcollection must not be touched');
  assert.equal(result.reads, 1);
  assert.equal(result.rebuilt, false);

  // And it is the same profile, not an empty one bought cheaply.
  assert.equal(result.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(curatedIds(result.profile, 'liked').length, 3000 / LIKED_EVERY);
  assert.ok(Object.keys(readCategorySignals(result.profile, NOW).affinities).length > 0);
});

test('the cold rebuild reads each interaction once and no more', async () => {
  const stub = createFirestoreStub({ interactions: makeInteractions(3000) });
  const result = await loadInteractionProfile({
    ...stub, userId: 'u2', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(result.reads, 3001, 'one aggregate read plus one per interaction');
  assert.equal(stub.interactionReads, 3000);
  assert.equal(result.truncated, false);
});

test('the rebuild stops at the hard document ceiling', async () => {
  const stub = createFirestoreStub({ interactions: makeInteractions(REBUILD_MAX_DOCUMENTS * 4) });
  const result = await loadInteractionProfile({
    ...stub, userId: 'u3', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(stub.interactionReads, REBUILD_MAX_DOCUMENTS);
  assert.equal(result.reads, REBUILD_MAX_DOCUMENTS + 1);
  assert.equal(result.truncated, true);
  assert.equal(stub.written.truncated, true);
  // Truncated or not, the result is persisted, so the ceiling is paid once.
  assert.equal(stub.writes, 1);
});

test('a failed write keeps the cost bounded AND still returns the real profile', async () => {
  // The regression this replaces: the second load short circuited to an empty
  // profile that was indistinguishable from a new account's, so FeedContext
  // rendered it and the user watched their likes vanish. Bounding the cost was
  // never enough on its own; the payload has to survive too.
  const cache = freshCache();
  const interactions = makeInteractions(3000);
  const expectedLikes = 3000 / LIKED_EVERY;
  const stub = createFirestoreStub({ interactions, failWrite: true });

  const first = await loadInteractionProfile({ ...stub, userId: 'u4', now: NOW, rebuildCache: cache });
  assert.equal(first.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(first.rebuilt, true);
  assert.equal(stub.interactionReads, 3000);
  assert.equal(curatedIds(first.profile, 'liked').length, expectedLikes);

  const second = await loadInteractionProfile({ ...stub, userId: 'u4', now: NOW, rebuildCache: cache });

  // Cost: no second scan.
  assert.equal(stub.interactionReads, 3000, 'the scan must not run a second time this session');
  assert.equal(second.reads, 1);
  assert.equal(second.reusedRebuild, true);

  // Payload: the real profile, not a plausible looking empty one.
  assert.ok(hasInteractionProfile(second), 'a reused rebuild still carries a profile');
  assert.equal(second.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(
    curatedIds(second.profile, 'liked').length,
    expectedLikes,
    'a suppressed rebuild handed back an empty profile passing as real',
  );
  assert.deepEqual(
    curatedIds(second.profile, 'liked').sort(),
    curatedIds(first.profile, 'liked').sort(),
  );
});

test('concurrent loads of one account share a single rebuild and both get it', async () => {
  // React StrictMode mounts effects twice, so two loads of the same account race
  // on every development page load. Neither may be fobbed off with an empty
  // profile, and only one of them may pay for the scan.
  const cache = freshCache();
  const interactions = makeInteractions(1200);
  const expectedLikes = 1200 / LIKED_EVERY;
  const stub = createFirestoreStub({ interactions });

  const [a, b] = await Promise.all([
    loadInteractionProfile({ ...stub, userId: 'u5', now: NOW, rebuildCache: cache }),
    loadInteractionProfile({ ...stub, userId: 'u5', now: NOW, rebuildCache: cache }),
  ]);

  assert.equal(stub.interactionReads, 1200, 'the subcollection must be scanned exactly once');
  assert.equal(stub.aggregateReads, 2, 'each load still reads the aggregate once');
  assert.equal(stub.writes, 1, 'and the aggregate is written once');

  [a, b].forEach((result, index) => {
    assert.ok(hasInteractionProfile(result), `load ${index} lost its profile`);
    assert.equal(result.status, INTERACTION_PROFILE_STATUS.LOADED);
    assert.equal(
      curatedIds(result.profile, 'liked').length,
      expectedLikes,
      `load ${index} came back empty instead of with the real profile`,
    );
  });
  assert.equal(a.rebuilt !== b.rebuilt, true, 'exactly one of them owns the rebuild');
});

test('an unavailable result carries no profile at all', async () => {
  const stub = createFirestoreStub({ interactions: makeInteractions(50) });
  stub.listInteractionPage = async () => { throw new Error('unavailable'); };

  const result = await loadInteractionProfile({
    ...stub, userId: 'u6', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(result.status, INTERACTION_PROFILE_STATUS.UNAVAILABLE);
  assert.equal(hasInteractionProfile(result), false);
  // Structural, not conventional: there is nothing to read by mistake.
  assert.equal('profile' in result, false);
  assert.equal(result.profile, undefined);
  assert.match(result.reason, /rebuild-failed/);
});

test('a failing aggregate read is unavailable, not an empty account', async () => {
  const stub = createFirestoreStub({ interactions: makeInteractions(50) });
  stub.readAggregate = async () => { throw new Error('offline'); };

  const result = await loadInteractionProfile({
    ...stub, userId: 'u7', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(result.status, INTERACTION_PROFILE_STATUS.UNAVAILABLE);
  assert.equal('profile' in result, false);
  assert.equal(stub.interactionReads, 0, 'a failed aggregate read must not trigger a scan');
});

test('a repeatedly failing rebuild never rescans', async () => {
  const cache = freshCache();
  const stub = createFirestoreStub({ interactions: makeInteractions(3000) });
  stub.listInteractionPage = async () => { throw new Error('unavailable'); };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await loadInteractionProfile({
      ...stub, userId: 'u8', now: NOW, rebuildCache: cache,
    });
    assert.equal(result.status, INTERACTION_PROFILE_STATUS.UNAVAILABLE);
  }
  assert.equal(stub.interactionReads, 0);
  assert.equal(stub.aggregateReads, 3, 'each attempt costs its own aggregate read and nothing else');
});

test('a genuinely new account is EMPTY, and a stored empty aggregate is LOADED', async () => {
  const newAccount = createFirestoreStub({ interactions: [] });
  const fresh = await loadInteractionProfile({
    ...newAccount, userId: 'u9', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(fresh.status, INTERACTION_PROFILE_STATUS.EMPTY);
  assert.ok(hasInteractionProfile(fresh), 'an empty account still has a usable profile');
  assert.deepEqual(readCategorySignals(fresh.profile, NOW), { affinities: {}, cooldowns: {} });
  assert.equal(newAccount.aggregateReads, 1);
  assert.equal(newAccount.interactionReads, 0);

  // Stored data is real data even when its lists are empty.
  const stored = createFirestoreStub({
    aggregate: serializeInteractionProfile(createEmptyInteractionProfile()),
  });
  const reloaded = await loadInteractionProfile({
    ...stored, userId: 'u9', now: NOW, rebuildCache: freshCache(),
  });
  assert.equal(reloaded.status, INTERACTION_PROFILE_STATUS.LOADED);
});

test('an aggregate from an older schema version is rebuilt once, then reused', async () => {
  const interactions = makeInteractions(200);
  const stale = { schemaVersion: 0, updatedAt: '2020-01-01T00:00:00.000Z', affinities: '{}', curated: '{}' };
  const stub = createFirestoreStub({ aggregate: stale, interactions });

  const rebuilt = await loadInteractionProfile({
    ...stub, userId: 'u10', now: NOW, rebuildCache: freshCache(),
  });
  assert.equal(rebuilt.rebuilt, true);
  assert.equal(stub.written.schemaVersion, 1);

  const warm = createFirestoreStub({ aggregate: stub.written, interactions });
  const reused = await loadInteractionProfile({
    ...warm, userId: 'u10', now: NOW, rebuildCache: freshCache(),
  });
  assert.equal(reused.rebuilt, false);
  assert.equal(warm.totalReads, 1);
});

test('a corrupt aggregate self-heals instead of degrading the feed silently', async () => {
  const interactions = makeInteractions(120);
  const corrupt = {
    schemaVersion: 1,
    updatedAt: '2026-08-01T00:00:00.000Z',
    affinities: 'not json at all',
    curated: '{}',
  };
  const stub = createFirestoreStub({ aggregate: corrupt, interactions });

  const result = await loadInteractionProfile({
    ...stub, userId: 'u11', now: NOW, rebuildCache: freshCache(),
  });
  assert.equal(result.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(result.rebuilt, true);
  assert.equal(curatedIds(result.profile, 'liked').length, 120 / LIKED_EVERY);
});

test('the rebuild paginates instead of asking for everything at once', async () => {
  const stub = createFirestoreStub({ interactions: makeInteractions(1200) });
  const result = await rebuildInteractionProfile({
    listInteractionPage: stub.listInteractionPage,
    now: NOW,
    pageSize: 500,
  });

  assert.equal(stub.pageCalls, 3);
  assert.equal(result.documentsRead, 1200);
  assert.equal(result.truncated, false);
});

test('a rebuilt profile keeps every interacted paper out of the feed', async () => {
  const interactions = makeInteractions(500);
  const stub = createFirestoreStub({ interactions });
  const result = await loadInteractionProfile({
    ...stub, userId: 'u12', now: NOW, rebuildCache: freshCache(),
  });

  interactions
    .filter(({ data }) => data.liked)
    .forEach(({ id }) => assert.equal(isPaperKnown(result.profile, id), true, `${id} would repeat`));
  assert.equal(isPaperKnown(result.profile, 'arxiv:2499999'), false);
});


test('an aggregate that has fallen behind its subcollection is rebuilt', async () => {
  const interactions = makeInteractions(1000);
  const missing = 200;
  const stub = createFirestoreStub({
    aggregate: staleAggregate(interactions, missing),
    interactions,
  });

  const result = await loadInteractionProfile({
    ...stub, userId: 'd1', now: NOW, checkDrift: true, rebuildCache: freshCache(),
  });

  assert.equal(stub.countCalls, 1);
  assert.equal(result.repairedDrift, true);
  assert.equal(result.rebuilt, true);
  assert.equal(result.drift.missing, missing);
  assert.equal(result.drift.actual, 1000);
  // The whole point: the likes the stale aggregate never saw are back.
  assert.equal(curatedIds(result.profile, 'liked').length, 1000 / LIKED_EVERY);
  assert.equal(stub.written.sourceDocCount, 1000);
});

test('a small lag does not buy an expensive rebuild', async () => {
  const interactions = makeInteractions(1000);
  const missing = DRIFT_MIN_MISSING_DOCS - 1;
  const stub = createFirestoreStub({
    aggregate: staleAggregate(interactions, missing),
    interactions,
  });

  const result = await loadInteractionProfile({
    ...stub, userId: 'd2', now: NOW, checkDrift: true, rebuildCache: freshCache(),
  });

  assert.equal(stub.countCalls, 1);
  assert.equal(result.rebuilt, false);
  assert.equal(result.repairedDrift, undefined);
  assert.equal(stub.interactionReads, 0, 'a lag under the threshold must not trigger a scan');
  assert.equal(result.drift.missing, missing);
});

test('the drift threshold scales with the size of the profile', () => {
  assert.equal(driftRebuildThreshold(0), DRIFT_MIN_MISSING_DOCS);
  assert.equal(driftRebuildThreshold(100), DRIFT_MIN_MISSING_DOCS);
  // 2% once that is the larger number.
  assert.equal(driftRebuildThreshold(5000), 100);
});

test('the drift check is off unless the caller asks for it', async () => {
  const interactions = makeInteractions(1000);
  const stub = createFirestoreStub({
    aggregate: staleAggregate(interactions, 500),
    interactions,
  });

  const result = await loadInteractionProfile({
    ...stub, userId: 'd3', now: NOW, rebuildCache: freshCache(),
  });

  assert.equal(stub.countCalls, 0, 'the ordinary feed load must not pay for a count');
  assert.equal(result.reads, 1, 'and still costs exactly one read');
  assert.equal(result.rebuilt, false);
});

test('a failed count leaves the stored profile alone', async () => {
  const interactions = makeInteractions(1000);
  const stub = createFirestoreStub({
    aggregate: staleAggregate(interactions, 500),
    interactions,
  });
  stub.countInteractions = async () => { throw new Error('unavailable'); };

  const result = await loadInteractionProfile({
    ...stub, userId: 'd4', now: NOW, checkDrift: true, rebuildCache: freshCache(),
  });

  assert.equal(result.status, INTERACTION_PROFILE_STATUS.LOADED);
  assert.equal(result.rebuilt, false);
  assert.equal(stub.interactionReads, 0, 'a broken count must never trigger a scan');
  assert.equal(curatedIds(result.profile, 'liked').length, 500 / LIKED_EVERY);
});

test('an aggregate ahead of its subcollection is never rebuilt', async () => {
  // sourceDocCount is biased upwards on purpose, so it can exceed the real
  // count. That must read as "no drift", not as a negative to act on.
  const interactions = makeInteractions(100);
  const profile = createEmptyInteractionProfile();
  profile.sourceDocCount = 500;
  profile.updatedAt = new Date(NOW).toISOString();
  const stub = createFirestoreStub({
    aggregate: serializeInteractionProfile(profile),
    interactions,
  });

  const result = await loadInteractionProfile({
    ...stub, userId: 'd5', now: NOW, checkDrift: true, rebuildCache: freshCache(),
  });

  assert.equal(result.rebuilt, false);
  assert.equal(stub.interactionReads, 0);
  assert.ok(result.drift.missing < 0);
});

test('recording a new paper raises the profile own document count', async () => {
  const profile = createEmptyInteractionProfile();
  assert.equal(profile.sourceDocCount, 0);

  recordInteractionEvent(profile, { paperId: 'p1', kind: 'skip', category: 'cs.AI' }, NOW);
  recordInteractionEvent(profile, { paperId: 'p2', kind: 'like', category: 'cs.AI' }, NOW);
  assert.equal(profile.sourceDocCount, 2);

  // One document per paper: further interactions with the same papers are the
  // same documents and must not inflate the count.
  recordInteractionEvent(profile, { paperId: 'p1', kind: 'viewTime', viewTime: 9 }, NOW);
  recordInteractionEvent(profile, { paperId: 'p2', kind: 'save', category: 'cs.AI' }, NOW);
  assert.equal(profile.sourceDocCount, 2);
});
