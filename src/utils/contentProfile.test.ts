import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTENT_TEXT_CHARS,
  MAX_TERMS_PER_PAPER,
  contentSimilarity,
  paperTermCounts,
  poolTermStats,
} from './contentProfile.ts';

const rlPaper = {
  id: 'rl',
  title: 'Offline reinforcement learning with conservative value estimates',
  abstract: 'We study offline reinforcement learning, where a policy is learned from a fixed dataset. '
    + 'Conservative value estimates keep the learned policy close to the data.',
};
const visionPaper = {
  id: 'vision',
  title: 'Masked autoencoders for image segmentation',
  abstract: 'We pretrain a vision transformer on images by masking patches. Segmentation of images improves.',
};

test('a paper contributes the words and word pairs of its title and abstract, without stop words', () => {
  const terms = [...paperTermCounts(rlPaper).keys()];

  assert.ok(terms.includes('reinforcement'));
  assert.ok(terms.includes('reinforcement learning'));
  assert.ok(terms.includes('conservative value'));
  assert.ok(!terms.includes('the') && !terms.includes('with') && !terms.includes('where'));
  assert.ok(terms.length <= MAX_TERMS_PER_PAPER);
});

test('the title counts for more than the abstract', () => {
  const counts = paperTermCounts({
    title: 'Quasar',
    abstract: 'Pulsar pulsar.',
  });

  assert.equal(counts.get('quasar'), 2);
  assert.equal(counts.get('pulsar'), 2);
});

test('only the stored part of a long abstract counts, as a rebuild from the stored copy would see it', () => {
  const filler = 'word '.repeat(CONTENT_TEXT_CHARS / 5);
  const counts = paperTermCounts({ title: 'Title', abstract: `${filler}lateterm` });

  assert.ok(!counts.has('lateterm'));
});

test('a placeholder abstract adds nothing, and a paper with no text has no terms', () => {
  assert.deepEqual([...paperTermCounts({ title: 'Quasar survey', abstract: 'No abstract available.' }).keys()].sort(), ['quasar', 'quasar survey', 'survey']);
  assert.equal(paperTermCounts({ title: '', abstract: '' }).size, 0);
  assert.equal(paperTermCounts({}).size, 0);
});

test('similarity follows the profile: a paper like the liked ones scores up, an unrelated one stays near zero', () => {
  const pool = [rlPaper, visionPaper];
  const stats = poolTermStats(pool);
  const likesRl = { 'reinforcement learning': 10, reinforcement: 10, policy: 8, 'offline reinforcement': 6 };

  const onTopic = contentSimilarity(paperTermCounts(rlPaper), likesRl, stats);
  const offTopic = contentSimilarity(paperTermCounts(visionPaper), likesRl, stats);

  assert.ok(onTopic > 0.15, `on-topic similarity ${onTopic}`);
  assert.equal(offTopic, 0);
});

test('a term the reader rejected pulls a paper below zero, and the result stays inside [-1, 1]', () => {
  const stats = poolTermStats([rlPaper, visionPaper]);
  const rejectsImages = { image: -10, 'image segmentation': -10, vision: -10 };

  const rejected = contentSimilarity(paperTermCounts(visionPaper), rejectsImages, stats);
  const huge = contentSimilarity(paperTermCounts(visionPaper), { image: -1e9, segmentation: 1e9 }, stats);

  assert.ok(rejected < -0.2, `rejected similarity ${rejected}`);
  assert.ok(huge >= -1 && huge <= 1);
});

test('a term every paper in the pool carries says less than a rare one', () => {
  const topic = (id: string, subject: string) => ({ id, title: `Neural ${subject}`, abstract: `Neural networks for ${subject}.` });
  const pool = [topic('a', 'protein folding'), topic('b', 'galaxy surveys'), topic('c', 'weather')];
  const stats = poolTermStats(pool);
  const folding = paperTermCounts(pool[0]);

  const common = contentSimilarity(folding, { neural: 10 }, stats);
  const rare = contentSimilarity(folding, { protein: 10 }, stats);

  assert.ok(rare > common, `rare ${rare} against common ${common}`);
});

test('similarity is zero for a paper with no terms or a reader with none', () => {
  const stats = poolTermStats([rlPaper]);

  assert.equal(contentSimilarity(new Map(), { policy: 5 }, stats), 0);
  assert.equal(contentSimilarity(paperTermCounts(rlPaper), {}, stats), 0);
});
