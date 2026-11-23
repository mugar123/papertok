import assert from 'node:assert/strict';
import test from 'node:test';
import { convertConferenceDetails, convertConferenceEdition } from './import-conference-editions.ts';

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
    id: 'example2027', name: 'Example2027', series: 'Example Conference', acronym: 'Example2027', year: 2027, field: 'engineering',
    dates: [{ start: '2027-03-01', end: null }], placeText: 'Chicago', format: 'hybrid',
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

test('starts a place at its name, whatever article the organizer wrote before it', () => {
  const placeOf = (placeText: string) => convertConferenceEdition({ ...row, placeText }, 'engineering')?.placeText;
  assert.equal(placeOf('at the San Diego Convention Center in San Diego, CA'), 'San Diego Convention Center in San Diego, CA');
  assert.equal(placeOf('the Ernest N. Morial Convention Center in New Orleans, Louisiana, and virtually'), 'Ernest N. Morial Convention Center in New Orleans, Louisiana');
  assert.equal(placeOf('The Hague'), 'The Hague');
  for (const place of ['Chicago / Online', 'Chicago – online', 'Chicago (hybrid)', 'Chicago, and virtually', 'Chicago (in person and online)', 'Chicago or online']) assert.equal(placeOf(place), 'Chicago', place);
  assert.equal(placeOf('on campus'), 'on campus');
});

test('does not repeat a dotted year in the name and keeps the published ID', () => {
  const converted = convertConferenceEdition({ ...row, field: 'medicine', acronym: 'ACC.27', series: 'ACC Annual Scientific Session' }, 'medicine');
  assert.equal(converted?.name, 'ACC.27');
  assert.equal(converted?.id, 'acc-27-2027');
});

test('records a format only when the source says it', () => {
  const formatOf = (fields: object) => convertConferenceEdition({ ...row, placeText: 'Chicago', online: null, ...fields }, 'engineering')?.format;
  assert.equal(formatOf({}), undefined);
  assert.equal(formatOf({ online: false }), 'in-person');
  assert.equal(formatOf({ online: true }), 'hybrid');
  assert.equal(formatOf({ notes: 'Online attendance is available.' }), 'hybrid');
  assert.equal(formatOf({ placeText: 'Vienna, Austria & Online' }), 'hybrid');
  assert.equal(formatOf({ placeText: 'Boston, MA (hybrid)' }), 'hybrid');
  assert.equal(formatOf({ notes: 'There is no virtual option in 2027.' }), undefined);
  assert.equal(formatOf({ notes: "There isn't a virtual option." }), undefined);
  assert.equal(formatOf({ online: false, notes: 'Partially hybrid.' }), 'in-person');
  assert.equal(formatOf({ online: false, acronym: 'EcoSta', notes: 'Partially hybrid.' }), 'hybrid');
  assert.equal(formatOf({ placeText: 'Chicago (in person and online)' }), 'hybrid');
  for (const placeText of ['Fully Virtual', 'Virtual Event', 'Online via Zoom', 'Online']) assert.equal(formatOf({ placeText }), 'online', placeText);
  assert.equal(convertConferenceEdition({ ...row, placeText: 'Fully Virtual' }, 'engineering')?.placeText, undefined);
});

test('keeps venue and deadlines in date order and rejects unusable ones', () => {
  const sourceUrl = 'https://example.org/dates';
  const details = { venue: ' Coex ', checkedOn: '2026-11-23', deadlines: [
    { label: 'Papers due', date: '2026-12-20', timeText: 'AoE', sourceUrl: sourceUrl + '?trk=ad' },
    { label: 'Abstracts due', date: '2026-12-10', timeText: null, sourceUrl },
  ] };
  assert.deepEqual(convertConferenceDetails(details), { venue: 'Coex', deadlines: [
    { label: 'Abstracts due', date: '2026-12-10', sourceUrl },
    { label: 'Papers due', date: '2026-12-20', timeText: 'AoE', sourceUrl },
  ] });
  assert.deepEqual(convertConferenceDetails({ venue: null, deadlines: [], checkedOn: '2026-11-23' }), {});
  for (const invalid of [
    { venue: ' ' }, { venue: { name: 'Coex' } }, { deadlines: 'soon' }, { deadlines: [null] }, { checkedOn: null },
    { deadlines: [{ label: 'Papers due', date: 'December', timeText: null, sourceUrl }] },
    { deadlines: [{ label: 'Papers due', date: '2026-12-20', timeText: null, sourceUrl: 'http://example.org' }] },
  ]) assert.equal(convertConferenceDetails({ ...details, ...invalid }), null);
});

test('keeps the hour of a deadline and drops a zone that comes without one', () => {
  const timeOf = (timeText: string) => convertConferenceDetails({ venue: null, checkedOn: '2026-11-23', deadlines: [{ label: 'Papers due', date: '2026-12-20', timeText, sourceUrl: 'https://example.org' }] })?.deadlines?.[0].timeText;
  for (const timeText of ['AoE', '11:59 PM ET', '2 p.m. ET', '23.55 GMT', 'midnight PST']) assert.equal(timeOf(timeText), timeText);
  for (const timeText of ['PT', 'UTC', 'UTC+0', 'UTC-8', 'Eastern Time', 'Europe/Paris']) assert.equal(timeOf(timeText), undefined, timeText);
});

test('drops the remarks a deadline label ends with and keeps that a date is tentative', () => {
  const labelOf = (label: string) => convertConferenceDetails({ venue: null, checkedOn: '2026-11-23', deadlines: [{ label, date: '2026-12-20', timeText: null, sourceUrl: 'https://example.org' }] })?.deadlines?.[0].label;
  assert.equal(labelOf('Papers due (Summer; author rebuttal date tentative; )'), 'Papers due (Summer)');
  assert.equal(labelOf('Rebuttal period ends (Summer; author rebuttal date tentative; )'), 'Rebuttal period ends (Summer, tentative)');
  assert.equal(labelOf('Decisions (Fall; decision is final major-revision n)'), 'Decisions (Fall)');
  assert.equal(labelOf('Papers due (Cycle 1 Deadline)'), 'Papers due (Cycle 1)');
  assert.equal(labelOf('Abstracts due (preliminary)'), 'Abstracts due (preliminary)');
});
