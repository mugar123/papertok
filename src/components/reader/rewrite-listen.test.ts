import assert from 'node:assert/strict';
import test from 'node:test';
import { rewriteListen } from './rewrite-listen.ts';

test('the plain-words voice reads the displayed explanation and keeps its paragraph anchors', () => {
  const spoken = rewriteListen([
    { id: 'why', kind: 'intro', heading: 'Why it matters', originalHeading: 'Original heading', paragraphs: ['An accessible explanation.', '', 'The next idea.'], highlights: [] },
    { id: 'result', kind: 'results', heading: 'What they found', originalHeading: '', paragraphs: ['A different explanation.'], highlights: [] },
  ]);
  assert.deepEqual(spoken.chapters, [
    { number: '1', title: 'Why it matters', first: 0 },
    { number: '2', title: 'What they found', first: 2 },
  ]);
  assert.deepEqual(spoken.queue, [
    { passage: 'why:0', heading: '1. Why it matters.', utterances: ['1. Why it matters.', 'An accessible explanation.'] },
    { passage: 'why:2', utterances: ['The next idea.'] },
    { passage: 'result:0', heading: '2. What they found.', utterances: ['2. What they found.', 'A different explanation.'] },
  ]);
});

test('an explanation without paragraphs has no playable audio or chapters', () => {
  assert.deepEqual(rewriteListen([]), { queue: [], chapters: [] });
  assert.deepEqual(rewriteListen([{ id: 'empty', kind: 'other', heading: 'Empty', originalHeading: '', paragraphs: [' '], highlights: [] }]), { queue: [], chapters: [] });
});
