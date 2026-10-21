import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createLongPress } from './longPress.ts';

const touch = (clientX = 100, clientY = 100) => ({ pointerType: 'touch', clientX, clientY });

function setup() {
  mock.timers.enable({ apis: ['setTimeout'] });
  const fired: number[] = [];
  const hold = createLongPress(() => fired.push(1));
  return { hold, fired };
}

test.afterEach(() => mock.timers.reset());

test('a finger held still for half a second fires once, and swallows its click once', () => {
  const { hold, fired } = setup();
  hold.onPointerDown(touch());
  hold.onPointerMove(touch(104, 103));
  mock.timers.tick(499);
  assert.equal(fired.length, 0);
  mock.timers.tick(1);
  assert.equal(fired.length, 1);
  hold.onPointerUp();
  assert.equal(hold.consumeHold(), true, 'the click ending the hold is not a tap');
  assert.equal(hold.consumeHold(), false, 'the next click is');
});

test('a tap, a swipe and a mouse press never fire', () => {
  const { hold, fired } = setup();

  hold.onPointerDown(touch());
  mock.timers.tick(200);
  hold.onPointerUp();

  hold.onPointerDown(touch());
  hold.onPointerMove(touch(100, 130));
  mock.timers.tick(1000);

  hold.onPointerDown(touch());
  hold.onPointerCancel();
  mock.timers.tick(1000);

  hold.onPointerDown({ pointerType: 'mouse', clientX: 100, clientY: 100 });
  mock.timers.tick(1000);

  assert.equal(fired.length, 0);
  assert.equal(hold.consumeHold(), false);
});

test('a hold that ended without a click does not swallow the next tap', () => {
  const { hold, fired } = setup();
  hold.onPointerDown(touch());
  mock.timers.tick(500);
  hold.onPointerUp();
  hold.onPointerDown(touch());
  hold.onPointerUp();
  assert.equal(fired.length, 1);
  assert.equal(hold.consumeHold(), false);
});

test('the browser menu is held back only while a finger is on the button or just held it', () => {
  const { hold } = setup();
  let prevented = 0;
  const menu = { preventDefault: () => { prevented += 1; } };

  hold.onContextMenu(menu);
  assert.equal(prevented, 0, 'a right click keeps its menu');

  hold.onPointerDown(touch());
  hold.onContextMenu(menu);
  mock.timers.tick(500);
  hold.onContextMenu(menu);
  assert.equal(prevented, 2);
});
