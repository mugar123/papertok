import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CITATION_GATE_MAX_WAIT_MS } from '../../utils/feedCitationGate.ts';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code: string, from: string, to: string, label: string, maxLines: number) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  assert.ok(block.split('\n').length <= maxLines, `${label} capture spans past what it names`);
  return block;
}

// Automatic pagination can produce the first visible page after exclusions.
test('SOURCE: the re-entry the guard was widened for still exists', async () => {
  const code = stripComments(await read('../../context/FeedContext.tsx'));
  assert.match(code, /loadPapersRef\.current\?\.\(false, activeMode, false, nextPage\)/,
    'a first page emptied after the wait continues with `reset` false');
});

test('the cap is short enough to be a loading screen and long enough to be worth it', () => {
  assert.ok(CITATION_GATE_MAX_WAIT_MS <= 1500, 'past this the veil is the feature the reader notices');
  assert.ok(CITATION_GATE_MAX_WAIT_MS >= 600, 'under this it would rarely catch a normal response');
});

/**
 * What the cap lets through: a chip landing in a row that is already on
 * screen. It cannot be given reserved space — the width depends on a number
 * nobody has yet — so the fade is the whole remedy, and it has to cover the
 * separator too or the flicker just moves into the dot.
 */
test('SOURCE: a late citation chip fades in, and so does its separator', async () => {
  const css = stripComments(await read('./PaperCard.css'));
  const rule = bounded(css, '.pc-citations,\n.pc-meta-dot--citations {', '}', 'the citation fade', 5);

  assert.match(rule, /\.pc-meta-dot--citations/, 'the dot in front of the chip fades with it');
  assert.match(rule, /animation:\s*appear\s+var\(--motion-base\)\s+linear/, 'a plain fade on the shared content duration');
  // An expo over an opacity is not a fade, it is a flash with a tail. Measured
  // twice on this project; it must not come back through this rule.
  assert.doesNotMatch(rule, /cubic-bezier|--ease-out-expo|ease-in-out/,
    'the curve of a fade is linear');

  const shared = stripComments(await read('../../styles/variables.css'));
  const frames = bounded(shared, '@keyframes appear', '}', 'appear', 4);
  assert.match(frames, /from\s*\{\s*opacity:\s*0;/, 'it starts from invisible');
  assert.doesNotMatch(frames, /\bto\b|100%/,
    'one end only: the browser synthesises the other from the resting pose, so the chip cannot end up pinned at an opacity the stylesheet did not choose');

  const reduced = css.slice(css.indexOf('.pc-citations,\n.pc-meta-dot--citations {'));
  assert.match(reduced, /@media \(prefers-reduced-motion: reduce\) \{\s*\.pc-citations,\s*\.pc-meta-dot--citations \{\s*animation: none;/,
    'reduced motion gives up the fade');
});

test('SOURCE: a notable card says why it is shown, "Highly cited", then its own year and a count grouped in English', async () => {
  const code = stripComments(await read('./PaperCard.tsx'));
  const masthead = bounded(code, '<div className="pc-meta">', '<TitleTag', 'the masthead', 90);
  const label = bounded(masthead, '{paper._notable && (', '</>', 'the notable label', 8);
  assert.match(label, />\s*\{'Highly cited'\}\s*</, 'visible text, read as it is shown');
  const [labelAt, yearAt, countAt] = ['{paper._notable && (', 'className="pc-date"', 'className="pc-citations"'].map(mark => masthead.indexOf(mark));
  assert.ok(labelAt >= 0 && labelAt < yearAt && yearAt < countAt, 'Highly cited · 2016 · 12,400 citations');
  // The year and the count are the paper's own, and the count still needs a
  // known or positive number (the chip's guard above): an unknown is no number.
  assert.match(masthead, /\{paper\.year\}/);
  const counts = [...masthead.matchAll(/\{paper\.citationCount!?\.toLocaleString\('en-US'\)\}/g)];
  assert.equal(counts.length, 3, 'the Scopus link, its name and the plain chip group thousands alike');
  assert.doesNotMatch(masthead, /\{paper\.citationCount\} /, 'no ungrouped count is left');
});

test('SOURCE: the dot before the chip is the one that carries the modifier', async () => {
  const code = stripComments(await read('./PaperCard.tsx'));
  const chip = bounded(code, '{(paper.citationCountKnown || paper.citationCount! > 0) && (', 'pc-citations', 'the citation chip', 8);

  assert.match(chip, /className="pc-meta-dot pc-meta-dot--citations"/,
    'the separator inside this fragment, and no other, gets the fade');
  // Every other dot on the row belongs to metadata that was there from the
  // first paint and must not fade on its own.
  const dots = [...code.matchAll(/className="pc-meta-dot pc-meta-dot--citations"/g)];
  assert.equal(dots.length, 1, 'exactly one dot fades');
});
