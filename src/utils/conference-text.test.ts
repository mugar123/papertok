import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceSubtitle, coverAcronym, coverSaysName, formatConferenceDates, formatConferenceMonth, nextDeadline } from './conference-text.ts';

test('one date style for a range, a range across months and a single day', () => {
  // Intl separates a range with thin spaces.
  const plain = (text: string) => text.replace(/\s/g, ' ');
  assert.equal(plain(formatConferenceDates('2026-12-06', '2026-12-12')), 'Dec 6 – 12, 2026');
  assert.equal(plain(formatConferenceDates('2027-07-31', '2027-08-06')), 'Jul 31 – Aug 6, 2027');
  assert.equal(plain(formatConferenceDates('2027-06-21', null)), 'Jun 21, 2027');
  assert.equal(formatConferenceMonth('2027-05'), 'May 2027');
});

test('the series shows only when the name does not already say it', () => {
  assert.equal(conferenceSubtitle({ name: 'SIGGRAPH Asia 2026', series: 'SIGGRAPH Asia' }), undefined);
  assert.equal(conferenceSubtitle({ name: 'Gordon Research Conference: Photochemistry (GRC 2027)', series: 'Gordon Research Conference: Photochemistry' }), undefined);
  assert.equal(conferenceSubtitle({ name: 'ICLR 2027', series: 'International Conference on Learning Representations' }), 'International Conference on Learning Representations');
});

test('a cover acronym drops the year printed beside it and nothing else', () => {
  assert.equal(coverAcronym({ acronym: 'CSE27', year: 2027 }), 'CSE');
  assert.equal(coverAcronym({ acronym: 'ACC.27', year: 2027 }), 'ACC');
  assert.equal(coverAcronym({ acronym: 'ASCE2027', year: 2027 }), 'ASCE');
  assert.equal(coverAcronym({ acronym: 'ISMB/ECCB', year: 2027 }), 'ISMB/ECCB');
  assert.equal(coverAcronym({ acronym: '2027', year: 2027 }), '2027');
  assert.equal(coverAcronym({ year: 2027 }), undefined);
});

test('a cover makes the name only when nothing else tells two editions apart', () => {
  assert.equal(coverSaysName({ name: 'ICLR 2027', acronym: 'ICLR', year: 2027 }), true);
  assert.equal(coverSaysName({ name: 'ACC.27', acronym: 'ACC.27', year: 2027 }), true);
  assert.equal(coverSaysName({ name: 'AAS 249 (2027)', acronym: 'AAS', year: 2027 }), false);
  assert.equal(coverSaysName({ name: 'CSHL Network Biology 2027', year: 2027 }), false);
});

test('the next deadline is the first that has not passed, its own day included', () => {
  const edition = { deadlines: [{ label: 'Abstracts', date: '2026-12-01' }, { label: 'Papers', date: '2026-12-08' }] };
  assert.equal(nextDeadline(edition, '2026-12-01')?.label, 'Abstracts');
  assert.equal(nextDeadline(edition, '2026-12-02')?.label, 'Papers');
  assert.equal(nextDeadline(edition, '2026-12-09'), undefined);
});
