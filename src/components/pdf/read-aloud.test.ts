import assert from 'node:assert/strict';
import test from 'node:test';
import type { Block, FullText, Inline } from '../../utils/full-text.ts';
import { chapterAt, fullTextListen, locateInListen, matchSpokenWords, readAloudStart, readAloudTimeline, spokenInlines, spokenWordAt, wordStarts } from './read-aloud.ts';

const text = (value: string) => ({ t: 'text' as const, text: value });
const p = (...children: Inline[]): Block => ({ t: 'p', children });
const heading = (label: string, title: string): Block => ({ t: 'heading', level: label.includes('.') ? 3 : 2, label, children: [text(title)] });

const doc = (body: Block[], abstract: Block[] = []): FullText => ({
  source: 'arxiv', sourceUrl: 'https://arxiv.org/html/2610.00001', abstract, body, references: [], notes: [], conversionErrors: 0,
});

test('spoken text keeps inline maths as words and drops citation marks', () => {
  assert.equal(spokenInlines([
    text('The rate '),
    { t: 'math', mathml: '<math/>', tex: '\\alpha' },
    text(' doubles '),
    { t: 'ref', target: 'bib.bib4', cites: true, children: [text('[4]')] },
    text(', as in '),
    { t: 'ref', target: 'S2.F3', children: [text('Figure 3')] },
    text('.'),
  ]), 'The rate α doubles , as in Figure 3.');
});

test('the listen reads headings before their text, announces display formulas and skips figures and tables', () => {
  const { queue, chapters } = fullTextListen(doc([
    heading('1', 'Introduction'),
    p(text('Agents read untrusted text.')),
    { t: 'equation', tex: 'E = mc^2' },
    { t: 'figure', images: [], caption: [text('A diagram.')] },
    heading('1.2', 'Contributions'),
    { t: 'list', ordered: false, items: [[text('A test bed')], [text('A split by outcome')]] },
    { t: 'table', caption: [text('Scores.')], rows: [] },
  ], [p(text('We compare five detectors.'))]), { withAbstract: true });

  assert.deepEqual(queue, [
    { passage: 'a0', utterances: ['We compare five detectors.'] },
    { passage: 'b1', utterances: ['1. Introduction.', 'Agents read untrusted text.', 'Formula omitted.'], heading: '1. Introduction.' },
    { passage: 'b5', utterances: ['1.2. Contributions.', 'A test bed.', 'A split by outcome'], heading: '1.2. Contributions.' },
  ]);
  assert.deepEqual(chapters, [
    { number: '', title: 'Abstract', first: 0 },
    { number: '1', title: 'Introduction', first: 1 },
    { number: '1.2', title: 'Contributions', first: 2 },
  ]);
});

test('a formula right after a heading, or before any text, is announced after the heading', () => {
  const eq: Block = { t: 'equation', tex: 'E = mc^2' };
  const { queue } = fullTextListen(doc([eq, heading('2', 'Method'), eq, p(text('We fit the model.'))]), { withAbstract: false });
  assert.deepEqual(queue, [
    { passage: 'b3', utterances: ['2. Method.', 'Formula omitted.', 'Formula omitted.', 'We fit the model.'], heading: '2. Method.' },
  ]);
});

test('a sentence longer than one request is read in full, cut between words', () => {
  const sentence = Array.from({ length: 700 }, (_, index) => `w${index}`).join(' ') + '.';
  const { queue } = fullTextListen(doc([p(text(sentence))]), { withAbstract: false });
  assert.ok(queue.length > 1);
  assert.ok(queue.every(item => item.utterances.every(line => line.length <= 2_500)));
  assert.equal(queue.map(item => item.utterances.join(' ')).join(' '), sentence);
});

test('a hidden abstract is not read, and a paragraph longer than one request is split in parts', () => {
  const long = Array.from({ length: 60 }, (_, index) => `Sentence number ${index} says something about the method.`).join(' ');
  const { queue, chapters } = fullTextListen(doc([p(text(long))], [p(text('Hidden.'))]), { withAbstract: false });
  assert.ok(queue.length > 1);
  assert.ok(queue.every(part => part.passage === 'b0' && part.utterances.join(' ').length <= 2_500));
  assert.equal(queue.map(part => part.utterances.join(' ')).join(' '), long);
  assert.deepEqual(chapters, []);
});

test('the timeline places chapters by estimated speaking time, and a moment maps back to its passage', () => {
  const queue = [
    { passage: 'b1', utterances: ['x'.repeat(150)] },
    { passage: 'b2', utterances: ['y'.repeat(300)] },
  ];
  const timeline = readAloudTimeline(queue, [{ number: '2', title: 'Method', first: 1 }]);
  assert.deepEqual(timeline.chapters, [
    { number: '', title: 'Introduction', start: 0, end: 10 },
    { number: '2', title: 'Method', start: 10, end: 30 },
  ]);
  assert.deepEqual(locateInListen(timeline, 15), { index: 1, fraction: 0.25 });
  assert.deepEqual(locateInListen(timeline, 99), { index: 1, fraction: 1 });
  assert.equal(chapterAt(timeline, 12).title, 'Method');
});

test('reading from the current position starts at the first passage on screen, or carries on from a pause there', () => {
  assert.equal(readAloudStart(null, null), 0);
  assert.equal(readAloudStart(4, null), 4);
  assert.equal(readAloudStart(null, { first: 3, last: 5 }), 3);
  assert.equal(readAloudStart(4, { first: 3, last: 5 }), 4);
  assert.equal(readAloudStart(1, { first: 3, last: 5 }), 3);
});

test('a clip that has arrived replaces its estimate, and everything after it moves', () => {
  const queue = [
    { passage: 'b1', utterances: ['x'.repeat(150)] },
    { passage: 'b2', utterances: ['y'.repeat(300)] },
  ];
  const timeline = readAloudTimeline(queue, [{ number: '2', title: 'Method', first: 1 }], item => (item.passage === 'b1' ? 12.5 : undefined));
  assert.deepEqual(timeline.passages, [{ start: 0, end: 12.5 }, { start: 12.5, end: 32.5 }]);
  assert.equal(timeline.chapters[1].start, 12.5);
  assert.equal(timeline.duration, 32.5);
});

test('the word being spoken follows ElevenLabs\' timings, and is estimated from the position without them', () => {
  const text = 'Language models learn';
  const timings = { characters: [...text], character_start_times_seconds: [...text].map((_, index) => index * 0.1) };
  const starts = wordStarts(text, timings);
  assert.deepEqual(starts?.map(start => Math.round(start * 10) / 10), [0, 0.9, 1.6]);
  assert.equal(spokenWordAt(text, starts, { seconds: 0.5, fraction: 0 }), 0);
  assert.equal(spokenWordAt(text, starts, { seconds: 1.2, fraction: 0 }), 1);
  assert.equal(spokenWordAt(text, starts, { seconds: 9, fraction: 0 }), 2);
  // Without timings, or with another text's, the share of the clip played says where it is.
  assert.equal(wordStarts(text, { characters: [...'Other text'], character_start_times_seconds: [] }), null);
  assert.equal(spokenWordAt(text, null, { seconds: null, fraction: 0.5 }), 1);
  assert.equal(spokenWordAt(text, null, { seconds: null, fraction: 1 }), 2);
});

test('spoken words find their word on the page past citation marks and formulas read out', () => {
  const page = 'learned using word vectors [82, 102] and fed to $x^2$ models'.split(' ');
  const spoken = 'learned using word vectors and fed to x squared models'.split(' ');
  assert.deepEqual(
    matchSpokenWords(spoken, page).map(index => page[index]),
    ['learned', 'using', 'word', 'vectors', 'and', 'fed', 'to', 'to', 'to', 'models'],
  );
});

test('spoken words catch up past long runs of citations, and a heading read first is not matched', () => {
  const words = (text: string) => text.split(' ');
  const onPage = (spoken: string[], page: string[]) => matchSpokenWords(spoken, page).map(index => page[index]);

  const numbered = words('we use Adam [1, 2, 3, 4, 5, 6, 7, 8, 9] to train the network');
  assert.deepEqual(onPage(words('we use Adam to train the network'), numbered), ['we', 'use', 'Adam', 'to', 'train', 'the', 'network']);

  const authorYear = words('as shown before (Smith et al., 2019; Jones et al., 2020; Lee et al., 2021) the models learn fast');
  assert.deepEqual(onPage(words('as shown before the models learn fast'), authorYear), ['as', 'shown', 'before', 'the', 'models', 'learn', 'fast']);

  // A citation between two words does not send them to the same pair in a later sentence.
  const repeated = words('Language models [3] are powerful. Such models are used widely.');
  assert.deepEqual(
    onPage(words('Language models are powerful. Such models are used widely.'), repeated),
    ['Language', 'models', 'are', 'powerful.', 'Such', 'models', 'are', 'used', 'widely.'],
  );
  assert.deepEqual(matchSpokenWords(words('Language models are powerful.'), repeated), [0, 1, 3, 4]);

  // The heading "Methods." is said first; the caller blanks its words, as they are not in the block.
  const paragraph = words('Methods matter. We describe methods here');
  assert.deepEqual(onPage(['', ...words('Methods matter. We describe methods here')], paragraph), ['Methods', 'Methods', 'matter.', 'We', 'describe', 'methods', 'here']);
});



test('a long sentence keeps its ending and every word across speech requests', () => {
  const sentence = 'word '.repeat(700) + 'END.';
  const { queue } = fullTextListen(doc([p(text(sentence))]), { withAbstract: false });
  assert.equal(queue.flatMap(item => item.utterances).join(' '), sentence);
  assert.ok(queue.length > 1);
  assert.ok(queue.every(item => item.utterances.join(' ').length <= 2500));
  const unbroken = 'a'.repeat(2499) + '🧪' + 'b'.repeat(501);
  const parts = fullTextListen(doc([p(text(unbroken))]), { withAbstract: false }).queue.flatMap(item => item.utterances);
  assert.equal(parts.join(''), unbroken);
  assert.deepEqual(parts, ['a'.repeat(2499), '🧪' + 'b'.repeat(501)]);
});
