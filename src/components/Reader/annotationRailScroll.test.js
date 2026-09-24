import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The annotations column has to scroll on its own.
 *
 * The rail is `position: sticky` inside `.rd-scroll`. A list taller than the
 * viewport used to pin its header and leave every note below the fold
 * unreachable: scrolling moved the paper, not the notes. The sheet has the
 * same failure at `max-height: 72vh` — the cap clipped the notes and nothing
 * became the scroller. Both surfaces keep the header and the filters put,
 * and give the leftover height to `.rd-rail-list`.
 */

const ANNOTATIONS_CSS = new URL('./Annotations.css', import.meta.url);

const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(css, selector) {
  const pattern = new RegExp(`(?:^|[};])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `expected a \`${selector}\` rule in Annotations.css`);
  return match[1];
}

const annotations = readFile(ANNOTATIONS_CSS, 'utf8').then(stripComments);

test('the margin is capped to the scrollport so its list can scroll', async () => {
  const css = await annotations;
  const rail = ruleBody(css, ".rd-rail[data-surface='rail']");
  assert.match(rail, /min-height:\s*0/);
  assert.match(rail, /max-height:\s*100%/);
  assert.match(rail, /overflow:\s*hidden/);

  const list = ruleBody(css, '.rd-rail-list');
  assert.match(list, /flex:\s*1 1 auto/);
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
});

test('the sheet clips to its cap and scrolls the notes, not the page', async () => {
  const css = await annotations;
  const sheet = ruleBody(css, ".rd-rail[data-surface='sheet']");
  assert.match(sheet, /max-height:\s*72vh/);
  assert.match(sheet, /overflow:\s*hidden/);

  assert.match(ruleBody(css, '.rd-rail-head'), /flex-shrink:\s*0/);
  assert.match(ruleBody(css, '.rd-rail-filters'), /flex-shrink:\s*0/);
});
