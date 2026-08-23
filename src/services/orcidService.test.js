import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadlineHarness.js';
import { extractOrcid, fetchWithTimeout } from './orcidService.js';

test('extracts a clean ORCID from a bare id, a URL and a checksum ending in X', () => {
  assert.equal(extractOrcid('0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(extractOrcid('https://orcid.org/0000-0002-1825-0097'), '0000-0002-1825-0097');
  assert.equal(extractOrcid('0000-0002-1825-009x'), '0000-0002-1825-009X');
  assert.equal(extractOrcid('not an orcid'), null);
  assert.equal(extractOrcid(''), null);
});

test('the deadline covers an ORCID body that never finishes', async () => {
  // This helper hands the response back unread — `getOrcidRecord` and its
  // siblings call `response.json()` further down. It used to clear its timer
  // before returning, in both the success and the failure path, so every one of
  // those reads ran with no deadline on it at all.
  await withStubbedFetch(dribblingFetch(), async () => {
    assert.equal(
      await settleWithin(1000, async () => {
        const response = await fetchWithTimeout('https://pub.orcid.org/v3.0/0000-0002-1825-0097/record', {}, 50);
        await response.json();
      }),
      'TimeoutError',
    );
  });
});
