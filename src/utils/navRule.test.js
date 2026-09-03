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
