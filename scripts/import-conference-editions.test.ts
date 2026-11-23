import assert from 'node:assert/strict';
import test from 'node:test';
import { convertConferenceEdition } from './import-conference-editions.ts';

const row = {
  field: 'engineering',
  acronym: 'Example2027',
  series: 'Example Conference',
  edition: '2027',
  startsOn: '2027-03-01',
  endsOn: null,
  dateText: null,
  city: null,
  country: null,
  placeText: 'in Chicago and online',
  online: false,
  url: 'https://example.org/2027?trk=ad&lang=en',
  sourceUrl: 'https://example.org/2027?trk=ad',
  sourceLicense: 'official-site',
  checkedOn: '2026-11-23',
  notes: null,
};

test('normalizes a verified event without repeating the year or retaining tracking', () => {
  assert.deepEqual(convertConferenceEdition(row, 'engineering'), {
    id: 'example2027', name: 'Example2027', series: 'Example Conference', field: 'engineering',
    dates: [{ start: '2027-03-01', end: null }], placeText: 'Chicago and online', online: true,
    url: 'https://example.org/2027?lang=en', sourceUrl: 'https://example.org/2027',
    checkedOn: '2026-11-23', source: undefined, dateText: undefined,
  });
});

test('rejects wrong fields, impossible or reversed dates, and missing or unsafe sources', () => {
  for (const invalid of [
    { field: 'biology' }, { startsOn: '2027-02-29' }, { endsOn: '2027-02-27' }, { startsOn: null, endsOn: '2027-03-01' },
    { sourceUrl: null }, { sourceUrl: 'https://name@example.org' }, { sourceLicense: 'unknown' }, { checkedOn: '2026-02-29' },
  ]) assert.equal(convertConferenceEdition({ ...row, ...invalid }, 'engineering'), null);
});

test('keeps a PDF or dataset as a source without promoting it to an event website', () => {
  const pdf = 'https://example.org/bulletin.pdf';
  const bulletin = convertConferenceEdition({ ...row, url: pdf, sourceUrl: pdf }, 'engineering');
  assert.equal(bulletin?.url, undefined);
  assert.equal(bulletin?.sourceUrl, pdf);
  const source = 'https://conferences.databio.org/';
  const converted = convertConferenceEdition({ ...row, field: 'biology', url: source, sourceUrl: source, sourceLicense: 'CC BY 4.0 (databio/conferences)' }, 'biology');
  assert.equal(converted?.url, undefined);
  assert.equal(converted?.sourceUrl, source);
  assert.equal(converted?.source, 'databio');
});
