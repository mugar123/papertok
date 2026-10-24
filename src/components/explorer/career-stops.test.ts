import test from 'node:test';
import assert from 'node:assert/strict';
import { careerStops, stopWidth, stopYears } from './career-stops.ts';

test('studies and work merge into one line ordered by start, undated first', () => {
  const career = careerStops({
    educations: [
      { organization: 'Oxford', role: 'DPhil', startDate: '2010', endDate: '2014' },
      { organization: 'Oxford' },
    ],
    employments: [
      { organization: 'DeepMind', startDate: '2014' },
      { organization: 'Oxford', role: 'Lecturer', startDate: '2014', endDate: '2016' },
    ],
  });
  assert.deepEqual(career.map((stop) => [stop.kind, stop.organization, stop.startDate]), [
    ['study', 'Oxford', undefined],
    ['study', 'Oxford', '2010'],
    ['work', 'Oxford', '2014'],
    ['work', 'DeepMind', '2014'],
  ]);
});

test('years stay unknown when ORCID gives none, and only a job is current', () => {
  assert.equal(stopYears({ kind: 'study', organization: 'Oxford' }), null);
  assert.equal(stopYears({ kind: 'study', organization: 'Oxford', startDate: '2010' }), '2010');
  assert.equal(stopYears({ kind: 'study', organization: 'Oxford', endDate: '2014' }), 'Until 2014');
  assert.equal(stopYears({ kind: 'work', organization: 'DeepMind', startDate: '2014' }), '2014 → Present');
  assert.equal(stopYears({ kind: 'work', organization: 'CONICET', startDate: '1991', endDate: '1995' }), '1991 → 1995');
});

test('a career wider than the line cuts the next stop at the edge', () => {
  assert.equal(stopWidth(3, 301, 86, 20), null);
  const width = stopWidth(11, 301, 86, 20)!;
  assert.ok(width >= 86);
  const shown = (301 + 20) / (width + 20);
  assert.ok(shown % 1 > 0.3 && shown % 1 < 0.6, `cut stop shows ${shown % 1}`);
});
