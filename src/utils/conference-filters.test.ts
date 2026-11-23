import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceFormatsOf, conferenceMonths, conferenceRegionsOf, filterConferences, filterLabels, isCalendarView, matchingSites, readConferenceDay, readConferenceFilters, withConferenceParam } from './conference-filters.ts';
import type { ConferenceEdition } from '../data/conferences.ts';

const none = { field: null, region: null, month: null, format: null };
const base: ConferenceEdition = { id: 'base', name: 'Base 2027', series: 'Base', year: 2027, field: 'cs', dates: [] };
const summit: ConferenceEdition = { ...base, id: 'summit', field: 'physics', format: 'hybrid', dates: [{ start: '2027-04-28', end: '2027-05-02' }] };
const remote: ConferenceEdition = { ...base, id: 'remote', field: 'physics', format: 'online', dates: [{ start: '2027-06-21', end: null }] };
const placed: ConferenceEdition = { ...base, id: 'placed', placeText: 'Athens, Greece', dates: [{ start: '2027-06-21', end: null }] };
const all = [base, summit, remote, placed];

test('reads a shared link and ignores values it does not know', () => {
  assert.deepEqual(readConferenceFilters(new URLSearchParams('field=physics&region=latin-america&month=2027-04&format=online')), { field: 'physics', region: 'latin-america', month: '2027-04', format: 'online' });
  assert.deepEqual(readConferenceFilters(new URLSearchParams('field=toString&region=mars&month=2027-13&format=all')), none);
  assert.deepEqual(readConferenceFilters(new URLSearchParams()), none);
});

test('names the active filters', () => {
  assert.deepEqual(filterLabels(none), []);
  assert.deepEqual(filterLabels({ field: 'physics', region: 'latin-america', month: '2027-04', format: 'online' }), ['Physics', 'Latin America & the Caribbean', 'April 2027', 'Online']);
});

test('changes one parameter and drops an empty one', () => {
  const params = new URLSearchParams('field=physics&month=2027-04');
  assert.equal(withConferenceParam(params, 'month', '2027-05').toString(), 'field=physics&month=2027-05');
  assert.equal(withConferenceParam(params, 'field', null).toString(), 'month=2027-04');
  assert.equal(params.toString(), 'field=physics&month=2027-04');
});

test('filters combine, and no filter keeps undated editions', () => {
  assert.deepEqual(filterConferences(all, none), all);
  assert.deepEqual(filterConferences(all, { ...none, field: 'physics', month: '2027-06', format: 'online' }).map(edition => edition.id), ['remote']);
  assert.deepEqual(filterConferences(all, { ...none, field: 'cs', month: '2027-06', format: 'online' }), []);
});

test('a conference counts in every month it touches', () => {
  assert.deepEqual(filterConferences(all, { ...none, month: '2027-04' }).map(edition => edition.id), ['summit']);
  assert.deepEqual(filterConferences(all, { ...none, month: '2027-05' }).map(edition => edition.id), ['summit']);
  assert.deepEqual(filterConferences(all, { ...none, month: '2027-03' }), []);
});

test('a hybrid meeting is in person and online, and an unstated format stays unstated beside a known place', () => {
  assert.deepEqual(conferenceFormatsOf(summit), ['in-person', 'online']);
  assert.deepEqual(conferenceFormatsOf(remote), ['online']);
  assert.deepEqual(conferenceFormatsOf(placed), ['in-person', 'unknown']);
  assert.deepEqual(conferenceFormatsOf(base), ['unknown']);
});

test('lists the months that start a conference and keeps a chosen empty one', () => {
  assert.deepEqual(conferenceMonths(all, null), ['2027-04', '2027-06']);
  assert.deepEqual(conferenceMonths(all, '2027-05'), ['2027-04', '2027-05', '2027-06']);
});

const sites: ConferenceEdition = { ...base, id: 'sites', dates: [
  { start: '2026-12-06', end: '2026-12-12', city: 'Sydney, Australia', country: 'AU' },
  { start: '2027-01-09', end: '2027-01-13', city: 'Paris, France', country: 'FR' },
] };

test('an edition belongs to every region it meets in', () => {
  assert.deepEqual(conferenceRegionsOf(sites), ['oceania', 'europe']);
  assert.deepEqual(conferenceRegionsOf({ ...summit, country: 'MX' }), ['latin-america', 'online']);
  assert.deepEqual(conferenceRegionsOf({ ...sites, dates: [sites.dates[0], { start: '2027-01-09', end: null, city: 'Somewhere' }] }), ['oceania', 'unknown']);
});

test('an uncertain place has its own choice, unless everyone meets online', () => {
  assert.deepEqual(conferenceRegionsOf(base), ['unknown']);
  assert.deepEqual(conferenceRegionsOf({ ...placed, country: undefined }), ['unknown']);
  assert.deepEqual(conferenceRegionsOf(summit), ['unknown', 'online']);
  assert.deepEqual(conferenceRegionsOf(remote), ['online']);
  assert.deepEqual(filterConferences([base, remote, sites], { ...none, region: 'unknown' }), [base]);
});

test('region and month must hold at the same site', () => {
  assert.deepEqual(matchingSites(sites, { region: 'europe', month: null }), [sites.dates[1]]);
  assert.deepEqual(filterConferences([sites], { ...none, region: 'europe', month: '2027-01' }), [sites]);
  assert.deepEqual(filterConferences([sites], { ...none, region: 'europe', month: '2026-12' }), []);
});

test('reads the view and a real day of the month', () => {
  assert.equal(isCalendarView(new URLSearchParams('view=calendar')), true);
  assert.equal(isCalendarView(new URLSearchParams('view=grid')), false);
  assert.equal(readConferenceDay(new URLSearchParams('day=28'), '2027-02'), '2027-02-28');
  for (const day of ['29', '00', '7', 'x']) assert.equal(readConferenceDay(new URLSearchParams({ day }), '2027-02'), null, day);
  assert.equal(readConferenceDay(new URLSearchParams(), '2027-02'), null);
});
