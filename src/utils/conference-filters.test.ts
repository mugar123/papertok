import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceFormatsOf, conferenceMonths, filterConferences, filterLabels, readConferenceFilters, withConferenceParam } from './conference-filters.ts';
import type { ConferenceEdition } from '../data/conferences.ts';

const none = { field: null, month: null, format: null };
const base: ConferenceEdition = { id: 'base', name: 'Base 2027', series: 'Base', year: 2027, field: 'cs', dates: [] };
const summit: ConferenceEdition = { ...base, id: 'summit', field: 'physics', format: 'hybrid', dates: [{ start: '2027-04-28', end: '2027-05-02' }] };
const remote: ConferenceEdition = { ...base, id: 'remote', field: 'physics', format: 'online', dates: [{ start: '2027-06-21', end: null }] };
const placed: ConferenceEdition = { ...base, id: 'placed', placeText: 'Athens, Greece', dates: [{ start: '2027-06-21', end: null }] };
const all = [base, summit, remote, placed];

test('reads a shared link and ignores values it does not know', () => {
  assert.deepEqual(readConferenceFilters(new URLSearchParams('field=physics&month=2027-04&format=online')), { field: 'physics', month: '2027-04', format: 'online' });
  assert.deepEqual(readConferenceFilters(new URLSearchParams('field=toString&month=2027-13&format=all')), none);
  assert.deepEqual(readConferenceFilters(new URLSearchParams()), none);
});

test('names the active filters', () => {
  assert.deepEqual(filterLabels(none), []);
  assert.deepEqual(filterLabels({ field: 'physics', month: '2027-04', format: 'online' }), ['Physics', 'April 2027', 'Online']);
});

test('changes one parameter and drops an empty one', () => {
  const params = new URLSearchParams('field=physics&month=2027-04');
  assert.equal(withConferenceParam(params, 'month', '2027-05').toString(), 'field=physics&month=2027-05');
  assert.equal(withConferenceParam(params, 'field', null).toString(), 'month=2027-04');
  assert.equal(params.toString(), 'field=physics&month=2027-04');
});

test('filters combine, and no filter keeps undated editions', () => {
  assert.deepEqual(filterConferences(all, none), all);
  assert.deepEqual(filterConferences(all, { field: 'physics', month: '2027-06', format: 'online' }).map(edition => edition.id), ['remote']);
  assert.deepEqual(filterConferences(all, { field: 'cs', month: '2027-06', format: 'online' }), []);
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
