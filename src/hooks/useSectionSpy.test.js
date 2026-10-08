import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionForScrollProgress } from './useSectionSpy.js';

const sections = (...tops) => tops.map((top, index) => ({
  id: `section-${index + 1}`,
  getBoundingClientRect: () => ({ top }),
}));

test('each section owns a distinct interval of the scrollable journey', () => {
  const documentTops = [196, 500, 900, 1300];
  const activeAt = scrollTop => sectionForScrollProgress(
    sections(...documentTops.map(top => top - scrollTop)), {
    readingLine: 96,
    scrollTop,
    viewportHeight: 800,
    documentHeight: 2500,
    },
  );
  assert.deepEqual(
    [100, 499, 500, 900, 1300, 1700].map(activeAt),
    ['section-1', 'section-1', 'section-2', 'section-3', 'section-4', 'section-4'],
  );
});

test('the first section remains active above the indexed content', () => {
  assert.equal(sectionForScrollProgress(sections(300, 600, 900), {
    readingLine: 96,
    scrollTop: 20,
    viewportHeight: 800,
    documentHeight: 3000,
  }), 'section-1');
});

test('the final section owns the bottom even when its heading cannot reach the top', () => {
  assert.equal(sectionForScrollProgress(sections(-1000, -400, 300), {
    readingLine: 96,
    scrollTop: 2200,
    viewportHeight: 800,
    documentHeight: 3000,
  }), 'section-3');
});
