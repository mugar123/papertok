import assert from 'node:assert/strict';
import test from 'node:test';
import { addMonths, calendarEntries as entriesOf, dayAfterKey, entriesBetween, entriesInMonth, layoutWeek, monthWeeks, nearestMonth, openingDay } from './conference-month.ts';
import type { ConferenceEdition } from '../data/conferences.ts';

function edition(id: string, ...dates: ConferenceEdition['dates'][number][]): ConferenceEdition {
  return { id, name: id, series: id, year: 2027, field: 'cs', dates };
}

function calendarEntries(editions: ConferenceEdition[]) {
  return entriesOf(editions.map(row => ({ edition: row, sites: row.dates })));
}

// Sunday June 20 to Saturday June 26, 2027.
const week = ['2027-06-20', '2027-06-21', '2027-06-22', '2027-06-23', '2027-06-24', '2027-06-25', '2027-06-26'];

test('a month is whole weeks from Sunday', () => {
  const june = monthWeeks('2027-06');
  assert.equal(june.length, 5);
  assert.equal(june[0][0], '2027-05-30');
  assert.equal(june[4][6], '2027-07-03');
  assert.deepEqual(june[3], week);
  assert.equal(monthWeeks('2026-11').length, 5);
  assert.equal(monthWeeks('2027-02').length, 5);
  const may = monthWeeks('2027-05');
  assert.equal(may.length, 6);
  assert.equal(may[0][0], '2027-04-25');
  assert.equal(may[5][6], '2027-06-05');
  assert.equal(monthWeeks('2027-01')[0][0], '2026-12-27');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2027-01', -1), '2026-12');
});

test('every site is its own entry, and an edition without dates is none', () => {
  const entries = calendarEntries([
    edition('multi', { start: '2026-12-09', end: '2026-12-13', city: 'Paris, France' }, { start: '2026-12-06', end: '2026-12-12', city: 'Sydney, Australia' }),
    edition('undated'),
    edition('one-day', { start: '2026-12-07', end: null }),
  ]);
  assert.deepEqual(entries.map(({ edition: { id }, start, end, city }) => [id, start, end, city]), [
    ['multi', '2026-12-06', '2026-12-12', 'Sydney, Australia'],
    ['one-day', '2026-12-07', '2026-12-07', undefined],
    ['multi', '2026-12-09', '2026-12-13', 'Paris, France'],
  ]);
});

test('a long conference takes part of each week it crosses', () => {
  const entries = calendarEntries([edition('long', { start: '2027-06-18', end: '2027-06-28' })]);
  const [segment] = layoutWeek(week, entries).segments;
  assert.deepEqual([segment.column, segment.span, segment.startsHere, segment.endsHere], [0, 7, false, false]);
  const [last] = layoutWeek(monthWeeks('2027-06')[4], entries).segments;
  assert.deepEqual([last.column, last.span, last.startsHere, last.endsHere], [0, 2, false, true]);
});

test('bars that do not meet share a row and bars that do take another', () => {
  const layout = layoutWeek(week, calendarEntries([
    edition('a', { start: '2027-06-20', end: '2027-06-21' }),
    edition('b', { start: '2027-06-21', end: '2027-06-23' }),
    edition('c', { start: '2027-06-22', end: null }),
  ]));
  assert.deepEqual(layout.segments.map(({ entry, column, span, lane }) => [entry.edition.id, column, span, lane]), [['a', 0, 2, 0], ['b', 1, 3, 1], ['c', 2, 1, 0]]);
  assert.equal(layout.rows, 2);
  assert.deepEqual(layout.hidden, [0, 0, 0, 0, 0, 0, 0]);
});

test('four rows fit, and a fifth folds into what each day hides', () => {
  const days = (count: number) => Array.from({ length: count }, (_, index) => edition(`e${index}`, { start: '2027-06-22', end: '2027-06-23' }));
  assert.equal(layoutWeek(week, calendarEntries(days(4))).segments.length, 4);
  const busy = layoutWeek(week, calendarEntries([...days(5), edition('later', { start: '2027-06-25', end: null })]));
  assert.equal(busy.segments.length, 4);
  assert.equal(busy.rows, 4);
  assert.deepEqual(busy.hidden, [0, 0, 2, 2, 0, 0, 0]);
});

test('finds the conferences of a day and of a month, edges included', () => {
  const entries = calendarEntries([edition('edge', { start: '2027-05-30', end: '2027-06-01' }), edition('july', { start: '2027-07-01', end: null })]);
  const ids = (found: readonly { edition: ConferenceEdition }[]) => found.map(entry => entry.edition.id);
  assert.deepEqual(ids(entriesInMonth(entries, '2027-06')), ['edge']);
  assert.deepEqual(ids(entriesInMonth(entries, '2027-05')), ['edge']);
  assert.deepEqual(ids(entriesBetween(entries, '2027-06-01', '2027-06-01')), ['edge']);
  assert.deepEqual(ids(entriesBetween(entries, '2027-06-02', '2027-06-02')), []);
});

test('an empty month offers the next one with a conference, or else the last', () => {
  const entries = calendarEntries([edition('a', { start: '2026-10-06', end: null }), edition('b', { start: '2026-12-01', end: null })]);
  assert.equal(nearestMonth(entries, '2026-11'), '2026-12');
  assert.equal(nearestMonth(entries, '2027-03'), '2026-12');
  assert.equal(nearestMonth([], '2027-03'), undefined);
});

test('the phone calendar opens on the linked day, today, or the first conference', () => {
  const entries = calendarEntries([edition('a', { start: '2027-06-13', end: null }), edition('b', { start: '2027-05-30', end: '2027-06-01' })]);
  assert.equal(openingDay('2027-06', '2027-06-22', '2026-11-23', entries), '2027-06-22');
  assert.equal(openingDay('2027-06', '2027-05-22', '2027-06-05', entries), '2027-06-05');
  assert.equal(openingDay('2027-06', null, '2026-11-23', entries), '2027-06-01');
  assert.equal(openingDay('2027-07', null, '2026-11-23', entries), '2027-07-01');
  assert.equal(openingDay('2027-06', null, '2026-11-23', calendarEntries([edition('a', { start: '2027-06-13', end: null })])), '2027-06-13');
});

test('keys move by day, week and month and never past a month\'s end', () => {
  const moves: Record<string, string> = {
    ArrowLeft: '2027-01-30', ArrowRight: '2027-02-01', ArrowUp: '2027-01-24', ArrowDown: '2027-02-07',
    Home: '2027-01-31', End: '2027-02-06', PageUp: '2026-12-31', PageDown: '2027-02-28',
  };
  for (const [key, expected] of Object.entries(moves)) assert.equal(dayAfterKey('2027-01-31', key), expected, key);
  assert.equal(dayAfterKey('2027-01-31', 'Enter'), null);
});
