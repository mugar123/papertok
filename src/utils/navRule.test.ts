import test from 'node:test';
import assert from 'node:assert/strict';
import { RULE_BASE_WIDTH_PX, ruleTransform } from './navRule.ts';

test('the rule is translated to the label and scaled to its width', () => {
  assert.equal(ruleTransform({ left: 300, width: 100 }, 200, 10), 'translateX(110px) scaleX(1)');
  assert.equal(ruleTransform({ left: 300, width: 60 }, 200, 10, 80), 'translateX(110px) scaleX(0.5)');
  assert.equal(ruleTransform({ left: 884, width: 83.8 }, 880, 10), `translateX(14px) scaleX(${(63.8 / RULE_BASE_WIDTH_PX).toFixed(4).replace(/0+$/, '')})`);
});

test('nothing to mark yields no transform', () => {
  assert.equal(ruleTransform(null!, 0, 10), '');
  assert.equal(ruleTransform({ left: 0, width: 10 }, 0, 10), '', 'a label narrower than its insets');
  assert.equal(ruleTransform({ left: NaN, width: 10 }, 0, 0), '');
});
