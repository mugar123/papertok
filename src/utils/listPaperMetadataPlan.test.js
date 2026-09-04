import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRESTORE_IN_FILTER_MAX,
  PAPER_METADATA_BATCH_SIZE,
  isFetchableDocumentId,
  planMetadataRequests,
  planRetryRequests,
} from './listPaperMetadataPlan.js';

/**
 * The cap is the one number here that cannot be checked by reading code: the
 * client SDK accepts any array length and the backend decides. Measured against
 * the emulator — 30 returns 30 documents, 31 comes back `invalid-argument:
 * 'IN' supports up to 30 comparison values.` — so this test is what stops the
 * constant drifting past a limit nothing else in the process enforces.
 */
test('the batch never exceeds the cap the backend actually enforces', () => {
  assert.equal(FIRESTORE_IN_FILTER_MAX, 30);
  assert.ok(PAPER_METADATA_BATCH_SIZE <= FIRESTORE_IN_FILTER_MAX,
    'a batch over the cap is rejected by the server, not by the SDK');
  assert.ok(PAPER_METADATA_BATCH_SIZE >= 1);

  // A caller asking for more is clamped rather than trusted: the failure it
  // would otherwise cause is asynchronous and looks like a flaky network.
  const { requests } = planMetadataRequests({
    missingIds: Array.from({ length: 100 }, (_, i) => `id${i}`),
    batchSize: 500,
  });
  for (const request of requests) {
    assert.ok(request.paperIds.length <= FIRESTORE_IN_FILTER_MAX,
      `a batch of ${request.paperIds.length} would be refused by the backend`);
  }
});

/**
 * arXiv ids from before 2007 carry the archive as a path segment. One of them
 * inside an `in` filter does not skip that id — it rejects the whole query, so
 * every paper sharing the batch loses its metadata to a neighbour's id.
 */
test('an id that cannot be a document id never reaches a batch', () => {
  assert.equal(isFetchableDocumentId('2401.01234'), true);
  assert.equal(isFetchableDocumentId('math/0309285'), false, 'raw, a legacy arXiv id carries a slash');
  assert.equal(isFetchableDocumentId(''), false);
  assert.equal(isFetchableDocumentId('.'), false);
  assert.equal(isFetchableDocumentId('..'), false);
  assert.equal(isFetchableDocumentId('__name__'), false);
  assert.equal(isFetchableDocumentId(null), false);
  assert.equal(isFetchableDocumentId(undefined), false);
  assert.equal(isFetchableDocumentId('x'.repeat(1501)), false);
  assert.equal(isFetchableDocumentId('x'.repeat(1500)), true);

  const { requests, unfetchable } = planMetadataRequests({
    missingIds: ['2401.01234', '__name__', '2402.09876', '..'],
  });
  assert.deepEqual(unfetchable, ['__name__', '..']);
  for (const request of requests) {
    assert.ok(!request.paperIds.includes('__name__') && !request.paperIds.includes('..'),
      'one bad id must not be able to poison a batch');
  }
  assert.deepEqual(requests[0].paperIds, ['2401.01234', '2402.09876']);
});

// The documents of slash-bearing papers are stored under an encoded name
// (utils/firestoreDocId.js), so the plan judges the ENCODED form: a legacy
// arXiv id is a batch member, and only what no encoding can save is dropped.
test('a legacy arXiv id reaches a batch, because its document name is encoded', () => {
  const { requests, unfetchable } = planMetadataRequests({
    missingIds: ['2401.01234', 'math/0309285', 'doi:10.1103/physrevb.42.892'],
  });
  assert.deepEqual(unfetchable, []);
  assert.deepEqual(requests[0].paperIds, ['2401.01234', 'math/0309285', 'doi:10.1103/physrevb.42.892'],
    'the plan keeps the paper ids; the caller encodes at query time and decodes what comes back');
});

test('both collections are asked for every batch, and the arithmetic holds', () => {
  const ids = Array.from({ length: 47 }, (_, i) => `id${i}`);
  const { requests } = planMetadataRequests({ missingIds: ids });

  // 47 ids at 30 a batch is two batches, each asked of both collections.
  assert.equal(requests.length, 4, 'ceil(47/30) * 2 = 4 round trips, down from ceil(47/10) * 2 = 10');
  assert.deepEqual(requests.map(r => r.source), ['saved', 'interaction', 'saved', 'interaction']);
  assert.equal(requests[0].paperIds.length, 30);
  assert.equal(requests[2].paperIds.length, 17);

  // Every id is asked for exactly once per source, and none is dropped.
  for (const source of ['saved', 'interaction']) {
    const asked = requests.filter(r => r.source === source).flatMap(r => r.paperIds);
    assert.deepEqual([...asked].sort(), [...ids].sort());
  }
});

test('nothing to ask for produces no requests at all', () => {
  assert.deepEqual(planMetadataRequests({ missingIds: [] }).requests, []);
  assert.deepEqual(planMetadataRequests({}).requests, []);
  assert.deepEqual(planMetadataRequests().requests, []);
  // All unfetchable is not "ask for nothing and call it a success": the ids
  // come back so the caller can stop those rows waiting.
  const allBad = planMetadataRequests({ missingIds: ['..', '__x__'] });
  assert.deepEqual(allBad.requests, []);
  assert.deepEqual(allBad.unfetchable, ['..', '__x__']);
});

/**
 * The retry used to replay the stored request objects verbatim, and the filter
 * that narrowed them to the ids still missing ran AFTER the branch that chose
 * them — so a retry could end up with nothing to send, send it, and clear the
 * banner as though it had worked.
 */
test('a retry is a fresh plan over what is still missing, or it is empty', () => {
  const failedRequests = [
    { source: 'saved', paperIds: ['a', 'b', 'c'] },
    { source: 'saved', paperIds: ['d'] },
  ];

  // Only 'a' and 'd' are still missing: the retry asks for those two, in one
  // batch, and only of the source that failed.
  const { requests } = planRetryRequests({ failedRequests, missingIds: ['a', 'd', 'z'] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, 'saved');
  assert.deepEqual(requests[0].paperIds, ['a', 'd']);

  // Everything the failure covered has since arrived: there is nothing to ask
  // for, and the caller can tell that from an empty plan.
  assert.deepEqual(planRetryRequests({ failedRequests, missingIds: ['z'] }).requests, []);
  assert.deepEqual(planRetryRequests({}).requests, []);
});

test('a retry rebatches rather than reissuing the shape that failed', () => {
  // A single stored request holding more than the cap — the shape that fails
  // identically however many times it is retried.
  const overCap = [{ source: 'interaction', paperIds: Array.from({ length: 45 }, (_, i) => `id${i}`) }];
  const missingIds = overCap[0].paperIds;
  const { requests } = planRetryRequests({ failedRequests: overCap, missingIds });

  assert.equal(requests.length, 2, '45 ids rebatch into two legal requests');
  for (const request of requests) {
    assert.ok(request.paperIds.length <= FIRESTORE_IN_FILTER_MAX);
    assert.equal(request.source, 'interaction');
  }
});

/* --- The library read shares the same rule ------------------------------- */

test('planLibraryBatches keeps a legacy arXiv id out of every batch', async () => {
  const { planLibraryBatches } = await import('./listPaperMetadataPlan.js');
  const { batches, unfetchable } = planLibraryBatches(
    ['openalex:W1', 'hep-th/0603001', '1807.10247', 'openalex:W2'],
    2,
  );
  assert.deepEqual(batches, [['openalex:W1', '1807.10247'], ['openalex:W2']]);
  assert.deepEqual(unfetchable, ['hep-th/0603001']);
});

test('planLibraryBatches has nothing to ask for when every id is illegal', async () => {
  const { planLibraryBatches } = await import('./listPaperMetadataPlan.js');
  assert.deepEqual(planLibraryBatches(['hep-th/0603001'], 30), { batches: [], unfetchable: ['hep-th/0603001'] });
  assert.deepEqual(planLibraryBatches(undefined, 30), { batches: [], unfetchable: [] });
});

// One liked paper with a pre-2007 arXiv id (`hep-th/0603001`) used to reject
// the `in` query it rode in, and with it every other liked paper of the batch
// — the whole Liked tab sat on a skeleton, retrying the same rejection.
test('the library read plans its batches through planLibraryBatches', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../services/interactionProfileStore.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function fetchLibraryRecords'));
  assert.match(body, /planLibraryBatches\(/, 'the batches must come from the plan that drops illegal ids');
  assert.doesNotMatch(body, /paperIds\.slice\(/, 'and never from slicing the raw id list');
});
