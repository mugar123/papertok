import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowKeyMovesFeed } from './feed-arrow-keys.ts';

// A stand-in for the page. A node knows the simple selectors it answers to,
// its parent, its box and its scroll, which is all the rule reads.
type Box = { top: number; bottom: number };
type PageNode = {
  parent: PageNode | null;
  matches: (selectors: string) => boolean;
  closest: (selectors: string) => PageNode | null;
  contains: (other: PageNode) => boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect: () => Box;
};

function node(parent: PageNode | null, own: string[] = [], { box = { top: 0, bottom: 0 }, scrollTop = 0, scrollHeight = 0, clientHeight = 0 } = {}): PageNode {
  const self: PageNode = {
    parent,
    scrollTop,
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => box,
    matches: selectors => selectors.split(',').some(selector => own.includes(selector.trim())),
    closest: (selectors) => {
      for (let at: PageNode | null = self; at; at = at.parent) if (at.matches(selectors)) return at;
      return null;
    },
    contains: (other) => {
      for (let at: PageNode | null = other; at; at = at.parent) if (at === self) return true;
      return false;
    },
  };
  return self;
}

// The feed under a 52px bar on a 740x360 phone, and on the card in view a
// no-abstract state of 68px of words in a 20px panel: 48px to scroll.
const body = node(null);
const feed = node(body, [], { box: { top: 52, bottom: 360 } });
const card = node(feed);
const state = (scrollTop: number, { top = 250, scrollHeight = 68, clientHeight = 20, parent = card } = {}) => node(
  parent,
  ['.pc-abstract-empty'],
  { box: { top, bottom: top + clientHeight }, scrollTop, scrollHeight, clientHeight },
);
const press = (target: PageNode | null, key: 'ArrowDown' | 'ArrowUp', inFeed = feed) => arrowKeyMovesFeed({ target, key, feed: inFeed });

test('with the focus on nothing the arrows go to the next or the previous paper', () => {
  assert.equal(press(body, 'ArrowDown'), true, 'the page itself');
  assert.equal(press(card, 'ArrowUp'), true, 'a card that was clicked on');
  assert.equal(press(null, 'ArrowDown'), true, 'a key whose target is not an element');
});

test('a control or a field keeps the arrows pressed on it', () => {
  for (const selector of ['button', 'a', 'input', 'textarea', 'select', 'summary', '[role="textbox"]', '[role="button"]', '[role="link"]', '[contenteditable="true"]']) {
    assert.equal(press(node(card, [selector]), 'ArrowDown'), false, selector);
  }
  assert.equal(press(node(node(card, ['button'])), 'ArrowDown'), false, 'the glyph inside a button');
});

test('the focused no-abstract state keeps the arrows while it can still scroll their way', () => {
  assert.equal(press(state(0), 'ArrowDown'), false, 'at its heading there are words below');
  assert.equal(press(state(24), 'ArrowDown'), false);
  assert.equal(press(state(24), 'ArrowUp'), false);
  assert.equal(press(state(48), 'ArrowUp'), false, 'at its end there are words above');
  assert.equal(press(node(state(0)), 'ArrowDown'), false, 'the focus inside it');
});

test('at the end of the state, or within a pixel of it, the arrow goes to the next or the previous paper', () => {
  assert.equal(press(state(48), 'ArrowDown'), true);
  assert.equal(press(state(0), 'ArrowUp'), true);
  // Chrome stopped this state at 14 of its 15px and then moved nothing.
  assert.equal(press(state(14, { scrollHeight: 35, clientHeight: 20 }), 'ArrowDown'), true);
  assert.equal(press(state(47.5), 'ArrowDown'), true, 'half a pixel short of the end');
  assert.equal(press(state(0.5), 'ArrowUp'), true, 'half a pixel under the heading');
});

test('the focused head rows of a card with the publisher\'s page keep the arrows while they can scroll their way', () => {
  // A record with no authors and no topic gives the rows no control, so
  // where they scroll (41px here) the box itself is the Tab stop.
  const head = (scrollTop: number) => node(card, ['.pc-head-rows'], { box: { top: 60, bottom: 344 }, scrollTop, scrollHeight: 325, clientHeight: 284 });
  assert.equal(press(head(0), 'ArrowDown'), false, 'at their top there are rows below');
  assert.equal(press(head(41), 'ArrowUp'), false, 'at their end there are rows above');
  assert.equal(press(head(41), 'ArrowDown'), true, 'at their end the arrow goes to the next paper');
  assert.equal(press(head(0), 'ArrowUp'), true, 'at their top it goes to the previous one');
});

test('a state that fits its panel leaves the arrows to the feed', () => {
  const fits = state(0, { scrollHeight: 74, clientHeight: 74 });
  assert.equal(press(fits, 'ArrowDown'), true);
  assert.equal(press(fits, 'ArrowUp'), true);
});

test('a state left on the card the feed moved away from does not keep the arrows', () => {
  // The feed went to the next card with the focus still on the state at its
  // end; the state is now one card above the feed's box.
  assert.equal(press(state(48, { top: 250 - 308 }), 'ArrowUp'), true, 'one card above');
  assert.equal(press(state(0, { top: 250 + 308 }), 'ArrowDown'), true, 'one card below');
  // At 360x640 with text at 200%, the state of the card just left ended 3px
  // inside the feed's box, behind the bar, and took four ArrowUp presses.
  const behindBar = state(174, { top: 9, scrollHeight: 220, clientHeight: 46 });
  assert.equal(press(behindBar, 'ArrowUp'), true, 'an edge behind the bar');
});

test('a popup over the feed keeps its arrows, and the Similar layer gives them to the feed it holds', () => {
  const privacyPanel = node(body, ['[role="dialog"]']);
  assert.equal(press(node(privacyPanel), 'ArrowDown'), false, 'a dialog that does not hold this feed');

  const similarLayer = node(body, ['[role="dialog"]']);
  const similarFeed = node(similarLayer, [], { box: { top: 0, bottom: 360 } });
  const similarCard = node(similarFeed);
  assert.equal(press(similarCard, 'ArrowDown', similarFeed), true, 'a card of the feed inside the layer');
  assert.equal(press(node(similarCard, ['button']), 'ArrowDown', similarFeed), false, 'a control of that card');
  assert.equal(press(state(0, { parent: similarCard }), 'ArrowDown', similarFeed), false, 'the scrolling state of that card');
  assert.equal(press(state(48, { parent: similarCard }), 'ArrowDown', similarFeed), true, 'and that state at its end');
  assert.equal(press(similarCard, 'ArrowDown'), false, 'the feed under the layer keeps still');
});
