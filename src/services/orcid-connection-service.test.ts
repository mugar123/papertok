import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrcidConnection, orcidRecordUrl } from './orcid-connection-service.ts';

const STORED = { id: '0000-0002-1825-0097', name: 'Josiah Carberry', host: 'orcid.org', connectedAt: '2026-11-18T10:00:00.000Z' } as const;

test('reads the iD the Worker stored, with a private name left unknown', () => {
  assert.deepEqual(normalizeOrcidConnection(STORED), STORED);
  assert.deepEqual(normalizeOrcidConnection({ ...STORED, name: null }), { ...STORED, name: null });
  assert.deepEqual(normalizeOrcidConnection({ ...STORED, name: '   ' }), { ...STORED, name: null });
});

test('a field that is not a valid iD on a known registry counts as no connection', () => {
  for (const value of [null, undefined, 'x', { ...STORED, id: '0000-0002-1825-0098' }, { ...STORED, host: 'evil.example' }, { ...STORED, host: undefined }]) {
    assert.equal(normalizeOrcidConnection(value), null, JSON.stringify(value));
  }
});

test('shows the iD as the full https address of its record, on its own registry', () => {
  assert.equal(orcidRecordUrl(STORED), 'https://orcid.org/0000-0002-1825-0097');
  assert.equal(orcidRecordUrl({ ...STORED, host: 'sandbox.orcid.org' }), 'https://sandbox.orcid.org/0000-0002-1825-0097');
});
