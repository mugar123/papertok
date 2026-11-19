import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionsForConnection, orcidWorkDecisionWrite } from './orcid-work-decisions-service.ts';

const CONNECTED_AT = '2026-11-18T10:00:00.000Z';
const snapshotOf = (data: Record<string, unknown>) => ({ get: (field: string) => data[field] });

test('a decision names the connection it was made for', () => {
  assert.equal(orcidWorkDecisionWrite(CONNECTED_AT, ['doi:10.1000/a'], 'mine').connectedAt, CONNECTED_AT);
  assert.equal(orcidWorkDecisionWrite(CONNECTED_AT, ['doi:10.1000/a'], null).connectedAt, CONNECTED_AT);
});

test('decisions made for another connection, or for none, are not read as this one\'s', () => {
  const stored = { connectedAt: CONNECTED_AT, mine: ['doi:10.1000/a'], notMine: ['openalex:W2'] };
  assert.deepEqual(decisionsForConnection(snapshotOf(stored), CONNECTED_AT), { mine: ['doi:10.1000/a'], notMine: ['openalex:W2'] });
  const none = { mine: [], notMine: [] };
  assert.deepEqual(decisionsForConnection(snapshotOf(stored), '2026-11-18T11:00:00.000Z'), none);
  assert.deepEqual(decisionsForConnection(snapshotOf({ ...stored, connectedAt: undefined }), CONNECTED_AT), none);
  assert.deepEqual(decisionsForConnection(snapshotOf({ ...stored, connectedAt: undefined }), null), none);
  assert.deepEqual(decisionsForConnection(snapshotOf({}), CONNECTED_AT), none);
});
