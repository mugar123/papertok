import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFiguresFromHtml, isArxivFigureId } from './paper-figures.js';

const ARXIV = 'https://arxiv.org';
const BASE = 'https://arxiv.org/html/2608.20340';

test('accepts only well-formed arXiv identifiers', () => {
  assert.equal(isArxivFigureId('2608.20340'), true);
  assert.equal(isArxivFigureId('1706.03762'), true);
  assert.equal(isArxivFigureId('math/0211159'), false);
  assert.equal(isArxivFigureId('../../etc/passwd'), false);
  assert.equal(isArxivFigureId(''), false);
});

test('extracts an image figure with its caption', () => {
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_figure"><img src="2608.20340v1/Fig1.jpg"><figcaption>Figure 1: Schematic of the system.</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures.length, 1);
  assert.equal(figures[0].url, 'https://arxiv.org/html/2608.20340v1/Fig1.jpg');
  assert.equal(figures[0].caption, 'Figure 1: Schematic of the system.');
});

test('extracts vector figures published as <object>', () => {
  // The best diagrams are often SVG, which arXiv emits as an object rather
  // than an img; matching only images lost exactly the figures worth showing.
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_figure"><object type="image/svg+xml" data="2608.20337v1/coalescent_tree.svg"></object><figcaption>Figure 2: A tree.</figcaption></figure>',
    'https://arxiv.org/html/2608.20337', ARXIV,
  );
  assert.equal(figures.length, 1);
  assert.match(figures[0].url, /coalescent_tree\.svg$/);
});

test('skips equations dressed up as figures', () => {
  const figures = extractFiguresFromHtml(
    '<figure class="ltx_equation"><img src="2608.20340v1/eq1.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('skips the page furniture arXiv serves from /static', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="/static/base/1.0.1/images/funders/simons-foundation.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('refuses assets from another origin', () => {
  // A rewritten page must not be able to point the feed at an arbitrary host.
  const figures = extractFiguresFromHtml(
    '<figure><img src="https://evil.example/tracker.png"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('refuses assets that are not images', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/script.js"></figure>',
    BASE, ARXIV,
  );
  assert.deepEqual(figures, []);
});

test('falls back to alt text when a figure has no caption', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg" alt="Energy levels"></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Energy levels');
});

test('deduplicates a figure repeated across blocks', () => {
  const block = '<figure><img src="2608.20340v1/Fig1.jpg"></figure>';
  assert.equal(extractFiguresFromHtml(block + block, BASE, ARXIV).length, 1);
});

test('caps the number of figures returned', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    `<figure><img src="2608.20340v1/Fig${i}.jpg"></figure>`).join('');
  assert.equal(extractFiguresFromHtml(many, BASE, ARXIV).length, 6);
});

test('a paper with no figures yields an empty list, not an error', () => {
  assert.deepEqual(extractFiguresFromHtml('<p>No figures here.</p>', BASE, ARXIV), []);
  assert.deepEqual(extractFiguresFromHtml('', BASE, ARXIV), []);
});

test('strips markup out of captions', () => {
  const figures = extractFiguresFromHtml(
    '<figure><img src="2608.20340v1/Fig1.jpg"><figcaption>Figure <span class="ltx_tag">1</span>: A <em>bold</em> claim &amp; more.</figcaption></figure>',
    BASE, ARXIV,
  );
  assert.equal(figures[0].caption, 'Figure 1 : A bold claim & more.');
});
