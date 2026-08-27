import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatYMD,
  monthWindowStart,
  monthsInWindow,
  getDaysArray,
  resolveCustomPeriod,
  prettyDate,
  MONTHS_VISIBLE,
} from './customPeriod.js';

/* The month index crosses two counting systems here — `Date` counts from zero,
   ISO counts from one — so every month of a year is walked rather than spot
   checked. A picker that says January and asks for February is the classic
   failure, and this is where it would have to happen. */

const MONTH_NAMES_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

test('a day clicked in month N is written as month N, all twelve months', () => {
  for (let month = 0; month < 12; month += 1) {
    const iso = formatYMD(1981, month, 10);
    assert.equal(iso, `1981-${String(month + 1).padStart(2, '0')}-10`);
    // And read back out in words it is still that month, not the next one.
    assert.match(prettyDate(iso, 'en-US'), new RegExp(`^${MONTH_NAMES_EN[month]} 10, 1981$`));
  }
});

test('the day the user reported reads back as the day they picked', () => {
  const iso = formatYMD(1981, 0, 10);
  assert.equal(iso, '1981-01-10');
  assert.equal(prettyDate(iso, 'en-US'), 'January 10, 1981');
  assert.equal(prettyDate(iso, 'es-ES'), '10 de enero de 1981');
});

test('reading out a date does not slip a day west of Greenwich', () => {
  // `new Date('1981-01-10')` is UTC midnight, which is 9 January in New York.
  // Parsing at midday is what keeps the calendar day the same everywhere.
  assert.equal(prettyDate('1981-01-10', 'en-US'), 'January 10, 1981');
  assert.equal(prettyDate('2026-12-31', 'en-US'), 'December 31, 2026');
  assert.equal(prettyDate('2026-01-01', 'en-US'), 'January 1, 2026');
});

test('a single day is a period of that one day at both ends', () => {
  const period = resolveCustomPeriod({
    yearRange: [1981, 1981], startDateStr: '1981-01-10', endDateStr: null, todayStr: '2026-08-27',
  });
  assert.deepEqual(period, { from: '1981-01-10', to: '1981-01-10', cappedAtToday: false });
});

test('two days picked in either order describe the same span', () => {
  const forwards = resolveCustomPeriod({
    yearRange: [1981, 1981], startDateStr: '1981-01-10', endDateStr: '1981-03-04', todayStr: '2026-08-27',
  });
  const backwards = resolveCustomPeriod({
    yearRange: [1981, 1981], startDateStr: '1981-03-04', endDateStr: '1981-01-10', todayStr: '2026-08-27',
  });
  assert.deepEqual(forwards, backwards);
  assert.equal(forwards.from, '1981-01-10');
  assert.equal(forwards.to, '1981-03-04');
});

test('a whole year opens on 1 January and closes on 31 December', () => {
  const period = resolveCustomPeriod({
    yearRange: [2019, 2021], startDateStr: null, endDateStr: null, todayStr: '2026-08-27',
  });
  assert.deepEqual(period, { from: '2019-01-01', to: '2021-12-31', cappedAtToday: false });
});

test('a year that has not finished closes at today, and says so', () => {
  const period = resolveCustomPeriod({
    yearRange: [2026, 2026], startDateStr: null, endDateStr: null, todayStr: '2026-08-27',
  });
  assert.deepEqual(period, { from: '2026-01-01', to: '2026-08-27', cappedAtToday: true });
});

test('the day step shows whole quarters, so a month never straddles two windows', () => {
  assert.equal(MONTHS_VISIBLE, 3);
  for (const [month, start] of [[0, 0], [1, 0], [2, 0], [3, 3], [7, 6], [11, 9]]) {
    assert.equal(monthWindowStart(month), start, `month ${month}`);
  }
  assert.deepEqual(monthsInWindow(0), [0, 1, 2]);
  assert.deepEqual(monthsInWindow(9), [9, 10, 11]);
  // Every month belongs to exactly one window, and the four windows cover the year.
  const covered = [0, 3, 6, 9].flatMap(monthsInWindow);
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
});

test('a month grid starts on the right weekday and holds the right number of days', () => {
  // January 1981 opened on a Thursday: three blanks before it in a Monday-first grid.
  const jan81 = getDaysArray(1981, 0);
  assert.deepEqual(jan81.slice(0, 4), [null, null, null, 1]);
  assert.equal(jan81.filter(Boolean).length, 31);

  // February in a leap year, and in one that is not.
  assert.equal(getDaysArray(2024, 1).filter(Boolean).length, 29);
  assert.equal(getDaysArray(2023, 1).filter(Boolean).length, 28);
  // 2000 is a leap year; 1900 was not.
  assert.equal(getDaysArray(2000, 1).filter(Boolean).length, 29);

  // A month that opens on a Monday has no blanks at all.
  const sep2024 = getDaysArray(2024, 8);
  assert.equal(sep2024[0], null, 'September 2024 opened on a Sunday');
  assert.equal(getDaysArray(2024, 6)[0], 1, 'July 2024 opened on a Monday');
});
