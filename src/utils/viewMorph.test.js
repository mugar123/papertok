import test from 'node:test';
import assert from 'node:assert/strict';
import { viewMorph } from './viewMorph.js';

test('sections cross sideways by default and up and down on the y axis', () => {
  assert.equal(viewMorph(false).enter(1).transform, 'translateX(16px)');
  assert.equal(viewMorph(false).exit(1).transform, 'translateX(-16px)');

  const vertical = viewMorph(false, 'y');
  assert.equal(vertical.enter(1).transform, 'translateY(16px)', 'forward rises from below');
  assert.equal(vertical.exit(1).transform, 'translateY(-16px)');
  assert.equal(vertical.center.transform, 'translateY(0px)');
});

test('reduced motion keeps the cross-fade and drops the travel on either axis', () => {
  for (const axis of ['x', 'y']) {
    const reduced = viewMorph(true, axis);
    assert.match(reduced.enter(1).transform, /\(0px\)/);
    assert.equal(reduced.enter(1).opacity, 0);
  }
});
