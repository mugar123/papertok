import assert from 'node:assert/strict';
import test from 'node:test';
import { conferenceSubtitle, coverAcronym, coverSaysName, deadlineCloses, deadlineSources, formatConferenceDates, formatConferenceMonth, formatDeadline, nextDeadline, usesCcfDeadlines } from './conference-text.ts';

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
  const edition = { deadlines: [{ label: 'Abstracts', date: '2026-12-01', sourceUrl: 'https://example.org' }, { label: 'Papers', date: '2026-12-08', sourceUrl: 'https://example.org' }] };
  assert.equal(nextDeadline(edition, Date.parse('2026-12-01T20:00:00Z'))?.label, 'Abstracts');
  assert.equal(nextDeadline(edition, Date.parse('2026-12-02T12:00:00Z'))?.label, 'Papers');
  assert.equal(nextDeadline(edition, Date.parse('2026-12-09T12:00:00Z')), undefined);
});

test('names each source of the deadlines once and credits CCF Deadlines for its own', () => {
  const ccf = { label: 'Papers', date: '2026-12-08', timeText: 'AoE', sourceUrl: 'https://github.com/ccfddl/ccf-deadlines/blob/main/conference/AI/acl.yml' };
  const official = { label: 'Abstracts', date: '2026-12-01', sourceUrl: 'https://www.example.org/dates' };
  assert.deepEqual(deadlineSources([ccf, official, official]), [{ url: ccf.sourceUrl, name: 'CCF Deadlines' }, { url: official.sourceUrl, name: 'example.org' }]);
  assert.equal(usesCcfDeadlines({ deadlines: [official, ccf] }), true);
  assert.equal(usesCcfDeadlines({ deadlines: [official] }), false);
  assert.equal(usesCcfDeadlines({ source: 'ccf' }), true);
  assert.equal(formatDeadline(ccf), 'Dec 8, 2026 · AoE');
  assert.equal(formatDeadline(official), 'Dec 1, 2026');
});

test('two pages of one host are told apart', () => {
  const at = (sourceUrl: string) => ({ label: 'Papers', date: '2026-12-08', sourceUrl });
  assert.deepEqual(deadlineSources([at('https://example.org/abstracts'), at('https://www.example.org/fees?y=2027'), at('https://other.org/')]).map(source => source.name), ['example.org/abstracts', 'example.org/fees?y=2027', 'other.org']);
});

test('a deadline stays open until its day ends everywhere on Earth', () => {
  const edition = { deadlines: [{ label: 'Papers due', date: '2027-01-04', timeText: 'AoE', sourceUrl: 'https://example.org' }] };
  // Already January 5 in Tokyo and Paris, still January 4 in AoE.
  assert.equal(nextDeadline(edition, Date.parse('2027-01-05T11:59:00Z'))?.label, 'Papers due');
  assert.equal(nextDeadline(edition, Date.parse('2027-01-05T12:00:00Z')), undefined);
  // A date with no hour closes at the same instant.
  assert.equal(deadlineCloses({ date: '2027-01-04' }), Date.parse('2027-01-05T12:00:00Z'));
});

test('a deadline with an hour and a zone closes at that instant', () => {
  const closes = (date: string, timeText: string) => new Date(deadlineCloses({ date, timeText })).toISOString();
  // EGU: 13:00 CET is 12:00 UTC, so it has passed at 14:00 CET.
  assert.equal(closes('2026-12-01', '13:00 CET'), '2026-12-01T12:00:00.000Z');
  const egu = { deadlines: [{ label: 'Support applications due', date: '2026-12-01', timeText: '13:00 CET', sourceUrl: 'https://example.org' }] };
  assert.equal(nextDeadline(egu, Date.parse('2026-12-01T11:59:00Z'))?.label, 'Support applications due');
  assert.equal(nextDeadline(egu, Date.parse('2026-12-01T13:00:00Z')), undefined);
  assert.equal(closes('2027-04-12', '23.55 BST'), '2027-04-12T22:55:00.000Z');
  assert.equal(closes('2027-03-10', '18:30 UTC+05:30'), '2027-03-10T13:00:00.000Z');
  assert.equal(closes('2027-03-10', '23:59 UTC-3'), '2027-03-11T02:59:00.000Z');
  assert.equal(closes('2027-03-10', '23:59 AoE'), '2027-03-11T11:59:00.000Z');
  // A regional zone follows summer time on that date.
  assert.equal(closes('2027-01-15', '11:59 PM ET'), '2027-01-16T04:59:00.000Z');
  assert.equal(closes('2027-07-15', '11:59pm ET'), '2027-07-16T03:59:00.000Z');
  assert.equal(closes('2027-07-15', '5:00 PM Pacific Time'), '2027-07-16T00:00:00.000Z');
  assert.equal(closes('2027-07-15', '2 p.m. ET'), '2027-07-15T18:00:00.000Z');
  assert.equal(closes('2027-07-15', '23:59 Eastern Time'), '2027-07-16T03:59:00.000Z');
  assert.equal(closes('2027-07-15', '23:59 Europe/Paris'), '2027-07-15T21:59:00.000Z');
  assert.equal(closes('2027-01-15', '11:59 PM CST'), '2027-01-16T05:59:00.000Z');
  assert.equal(closes('2027-01-15', 'midnight PST'), '2027-01-16T08:00:00.000Z');
  assert.equal(closes('2027-03-10', '23:59 UTC\u22123'), '2027-03-11T02:59:00.000Z');
  assert.equal(closes('2027-03-10', '23:59 Etc/GMT+12'), '2027-03-11T11:59:00.000Z');
  // A summer-time zone out of season is read as that zone's local time, the later reading.
  assert.equal(closes('2026-11-04', '11:59 pm EDT'), '2026-11-05T04:59:00.000Z');
  assert.equal(closes('2027-01-15', '23:59 BST'), '2027-01-15T23:59:00.000Z');
  assert.equal(closes('2027-07-15', '11:59 pm EDT'), '2027-07-16T03:59:00.000Z');
  // 12 AM and 00:00 end the day, as midnight does; 12 PM is noon.
  assert.equal(closes('2027-03-10', '12:00 AM ET'), '2027-03-11T05:00:00.000Z');
  assert.equal(closes('2027-03-10', '00:00 CET'), '2027-03-10T23:00:00.000Z');
  assert.equal(closes('2027-03-10', '12 PM PT'), '2027-03-10T20:00:00.000Z');
  assert.equal(closes('2027-03-10', '00:30 CET'), '2027-03-10T23:30:00.000Z');
  assert.equal(closes('2027-03-10', '12:30 AM ET'), '2027-03-11T05:30:00.000Z');
  // An hour without a zone, a zone this does not know, or several times or zones end
  // with the day in AoE, so no deadline is shown as passed early.
  for (const timeText of ['11:59 PM PT (2:59 AM ET next day)', '11:59 PM Pacific / 2:59 AM Eastern', '23:59 PST (07:59 GMT next day)', '11:59 PM ET (04:59 UTC)', '23:59 UTC+530', '23:59 Central European Time', '23:59 Mars/Olympus', '11:59 PM Mountain Standard Time', '11:59 PM Pacific Time (Hawaii)']) {
    assert.equal(closes('2027-03-10', timeText), '2027-03-11T12:00:00.000Z', timeText);
  }
  assert.equal(closes('2027-03-10', 'AoE'), '2027-03-11T12:00:00.000Z');
  assert.equal(closes('2027-03-10', '17:00'), '2027-03-11T12:00:00.000Z');
  assert.equal(closes('2027-03-10', '17:00 IST'), '2027-03-11T12:00:00.000Z');
});
