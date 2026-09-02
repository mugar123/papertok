import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { seedPaintsWhole } from './paperSeed.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('a handed-over copy paints only when it carries a title and a real abstract', () => {
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'Despite growing interest in open access…' }), true);
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'No abstract available.' }), false,
    'the legacy adapter\'s placeholder is not an abstract');
  assert.equal(seedPaintsWhole({ title: 'T', abstract: 'Resumen no disponible.' }), false);
  assert.equal(seedPaintsWhole({ title: 'T', abstract: '' }), false);
  assert.equal(seedPaintsWhole({ title: 'T' }), false);
  assert.equal(seedPaintsWhole({ title: '', abstract: 'Words.' }), false);
  assert.equal(seedPaintsWhole(null), false);
});

/**
 * SOURCE: the paper page keeps the copy for the fallback but paints it on
 * arrival only when it is whole; otherwise it shows the skeleton and waits.
 */
test('SOURCE: the paper page paints an incomplete copy as a skeleton, not as "Abstract unavailable"', async () => {
  const code = stripComments(await read('../components/Public/PublicPaperPage.jsx'));
  assert.match(code, /const seedPainted = seedPaintsWhole\(seededPaper\)/);
  assert.match(code, /const paper = hasCurrentResult \? result\.paper : \(seedPainted \? seededPaper : null\)/,
    'nothing is painted from a copy that lacks its abstract');
  assert.match(code, /: \(seedPainted \? 'ready' : \(identity \? 'loading' : 'not-found'\)\)/,
    'the page waits on the providers instead, skeleton up');
  assert.match(code, /useState\(\(\) => seedPainted\)/,
    'the cover on arrival follows what was actually painted');
  const failures = code.match(/paper: seededPaper, status: seededPaper \? 'ready'/g) || [];
  assert.equal(failures.length, 2, 'both failure paths still fall back to the copy, whole or not');
});
