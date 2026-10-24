import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dribblingFetch,
  settleWithin,
  withStubbedFetch,
} from '../test-support/deadline-harness.ts';
import { extractOrcid, fetchWithTimeout, getOrcidRecord } from './orcid-service.ts';

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

test('a job ORCID gives no end year keeps its end unknown', async () => {
  const summary = (end?: string) => ({
    'employment-summary': {
      organization: { name: 'DataCite' },
      'start-date': { year: { value: '2015' } },
      ...(end ? { 'end-date': { year: { value: end } } } : {}),
    },
  });
  const payload = {
    'activities-summary': { employments: { 'affiliation-group': [{ summaries: [summary('2021')] }, { summaries: [summary()] }] } },
  };
  const record = await withStubbedFetch(async () => Response.json(payload), () => getOrcidRecord('0000-0003-1419-2405'));
  assert.deepEqual(record?.employments.map((job) => job.endDate), ['2021', undefined]);
});
