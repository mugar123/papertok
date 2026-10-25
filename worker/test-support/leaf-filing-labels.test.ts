import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { compareWithDataset, labelsFromReviews } from './leaf-filing-labels.ts';

const works = (...ids: string[]) => ids.map(id => ({ id: `https://openalex.org/${id}` }));
const call = (id: string, label?: 'on-target' | 'off-target', extra: { uncertain?: true; leaf?: string } = {}) => ({ workId: `https://openalex.org/${id}`, ...(label ? { label } : {}), ...extra });
interface OtherSample { leaf?: string; works: ReturnType<typeof works>; labels: Array<ReturnType<typeof call>> }
const venues = (otherSamples: OtherSample[] = []) => ({ leaves: {}, otherSamples });

test('a pair two samples call differently is doubted, and so is one called uncertain in any sample', () => {
  const labels = labelsFromReviews(
    { 'hep-th': { works: works('W1', 'W2', 'W3'), labels: [call('W1', 'on-target'), call('W2', 'on-target'), call('W3', 'off-target', { uncertain: true })] } },
    venues([{
      leaf: 'hep-th',
      works: works('W1', 'W2', 'W3'),
      labels: [call('W1', 'on-target'), call('W2', 'off-target'), call('W3', 'on-target')],
    }]),
  );
  assert.deepEqual([...labels], [['W1', { 'hep-th': 'on' }], ['W2', { 'hep-th': 'doubt' }], ['W3', { 'hep-th': 'doubt' }]]);
});

test('a sample that names no leaf takes each label\'s own, and a leaf of an area without an area lane is left out', () => {
  const labels = labelsFromReviews(
    { 'stat.ME': { works: works('W1'), labels: [call('W1', 'on-target')] } },
    venues([{ works: works('W2', 'W3'), labels: [call('W2', 'on-target', { leaf: 'q-fin.ST' }), call('W3', 'off-target', { leaf: 'q-fin.PR' })] }]),
  );
  assert.deepEqual([...labels], [['W2', { 'q-fin.ST': 'on' }], ['W3', { 'q-fin.PR': 'off' }]]);
});

test('a sample whose labels do not cover its works once each, or that names no known leaf, is refused', () => {
  const refused = (otherSample: OtherSample, message: RegExp) => assert.throws(() => labelsFromReviews({}, venues([otherSample])), message);
  refused({ leaf: 'hep-th', works: works('W1', 'W2'), labels: [call('W1', 'on-target')] }, /label every sampled work/);
  refused({ leaf: 'hep-th', works: works('W1'), labels: [call('W1', 'on-target'), call('W1', 'off-target')] }, /invalid label for W1/);
  refused({ leaf: 'hep-th', works: works('W1'), labels: [call('W9', 'on-target')] }, /invalid label for W9/);
  refused({ leaf: 'hep-th', works: works('W1'), labels: [call('W1')] }, /invalid label for W1/);
  refused({ leaf: 'hep-thx', works: works('W1'), labels: [call('W1', 'on-target')] }, /invalid label for W1/);
  refused({ works: works('W1'), labels: [call('W1', 'on-target')] }, /invalid label for W1/);
});

test('the comparison names an article whose labels differ from the reviews and counts the pairs it holds no vector for', () => {
  const labels = labelsFromReviews(
    { 'hep-th': { works: works('W1', 'W2', 'W3'), labels: [call('W1', 'on-target'), call('W2', 'on-target'), call('W3', 'off-target')] } },
    venues(),
  );
  const report = compareWithDataset(labels, { labelled: [
    { id: 'W1', labels: { 'hep-th': 'on' } },
    { id: 'W2', labels: { 'hep-th': 'doubt' } },
    { id: 'W4', labels: { 'hep-th': 'on' } },
  ] });
  assert.deepEqual(report, { articles: 3, pairs: 3, differing: ['W2', 'W4'], pairsWithoutVector: 1 });
});

test('the repository\'s review files give one label per pair across the topic reviews and the venue samples', () => {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../scripts/data/${name}`, import.meta.url), 'utf8'));
  const labels = labelsFromReviews(read('openalex-topic-reviews.json'), read('openalex-venue-reviews.json'));
  // Called on target by the economics topic review, doubted by three samples of other topic filters.
  assert.equal(labels.get('W7223173143')?.['econ.GN'], 'doubt');
  // From the q-fin sample of one journal that names no leaf: the best fit its label names.
  assert.equal(labels.get('W7223108949')?.['q-fin.GN'], 'on');
});
