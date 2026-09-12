import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RULE_BASE_WIDTH_PX, ruleTransform } from './navRule.js';

test('the rule is translated to the label and scaled to its width', () => {
  assert.equal(ruleTransform({ left: 300, width: 100 }, 200, 10), 'translateX(110px) scaleX(1)');
  assert.equal(ruleTransform({ left: 300, width: 60 }, 200, 10, 80), 'translateX(110px) scaleX(0.5)');
  assert.equal(ruleTransform({ left: 884, width: 83.8 }, 880, 10), `translateX(14px) scaleX(${(63.8 / RULE_BASE_WIDTH_PX).toFixed(4).replace(/0+$/, '')})`);
});

test('nothing to mark yields no transform', () => {
  assert.equal(ruleTransform(null, 0, 10), '');
  assert.equal(ruleTransform({ left: 0, width: 10 }, 0, 10), '', 'a label narrower than its insets');
  assert.equal(ruleTransform({ left: NaN, width: 10 }, 0, 0), '');
});

test('SOURCE: the navbar rule is one compositor-driven element, not a framer layoutId', async () => {
  // Comments are prose, not code: the hook's own comment explains the
  // `layoutId` it replaced, so only real code is scanned for it.
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const jsx = stripComments(await readFile(new URL('../components/Layout/Navbar.jsx', import.meta.url), 'utf8'));
  const css = await readFile(new URL('../components/Layout/Navbar.css', import.meta.url), 'utf8');
  assert.doesNotMatch(jsx, /layoutId/, 'a JS-driven layout animation freezes with the main thread');
  assert.match(jsx, /ruleTransform\(/);
  assert.match(css, /\.navbar-link-rule\.is-measured \{[\s\S]*?transition:[^;]*transform[^;]*;/, 'the travel is a CSS transition on transform, armed once the rule has been placed');
  assert.match(css, /\.navbar-link-rule \{[\s\S]*?transform-origin: 0 50%;/);
});

/**
 * The mark and the page it marks are one gesture, so they run one clock.
 *
 * Measured by frame 2026-09-12, pressing back from Research to the feed while
 * they did not: at 75ms the page had faded to 0.69 and covered half its travel,
 * and the rule had moved 9.5px of its 95 — a tenth — because it ran 280ms on
 * `cubic-bezier(0.4, 0, 0.2, 1)`, which eases IN and barely moves for its first
 * frames. What a reader sees is the page arriving and the yellow mark strolling
 * after it. Two files, so a test is the only thing that can hold them together.
 */
test('SOURCE: the navbar rule travels on the route transition\'s clock and curve', async () => {
  const css = await readFile(new URL('../components/Layout/Navbar.css', import.meta.url), 'utf8');
  const pageCss = await readFile(new URL('../components/Layout/PageTransition.css', import.meta.url), 'utf8');
  const lateral = pageCss.match(/--page-lateral-ms: (\d+)ms;/);
  assert.ok(lateral, 'the lateral step declares its duration');

  const armed = css.match(/\.navbar-link-rule\.is-measured \{([^}]*)\}/);
  assert.ok(armed, 'the transition lives behind the arming class');
  const travel = armed[1].match(/transform (\d+)ms (var\(--[a-z-]+\))/);
  assert.ok(travel, `the travel is <duration> <token>, not a literal curve: ${armed[1].trim()}`);
  assert.equal(Number(travel[1]), Number(lateral[1]), 'the mark and the page it marks end on the same frame');
  assert.equal(travel[2], 'var(--ease-out-cubic)', 'and they decelerate the same way');
  // A fade is not a travel: it goes in a straight line, like every other fade
  // in a route change (PageTransition.css says why).
  assert.match(armed[1], /opacity 0\.16s linear/);
  assert.doesNotMatch(armed[1], /cubic-bezier\(/, 'the curve is the token, not a literal');

  // The Explorer's tab strip is the same mark in a smaller place, and has
  // always shared this declaration.
  const explorer = await readFile(new URL('../components/Explorer/EntityExplorer.css', import.meta.url), 'utf8');
  const twin = explorer.match(/\.ee-tab-rule\.is-measured \{([^}]*)\}/);
  assert.ok(twin, 'the Explorer arms its rule the same way');
  assert.equal(twin[1].trim(), armed[1].trim(), 'one gesture, one clock, in both places');
});
