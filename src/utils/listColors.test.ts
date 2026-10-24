import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_COLORS,
  listColorVarById,
  randomListColorId,
  resolveListColor,
  resolveListColorId,
} from './listColors.ts';

test('the built-in lists keep colours of their own, and only Favourites is red', () => {
  assert.equal(resolveListColor({ id: '__favorites__' }), 'var(--accent-like)');
  assert.equal(resolveListColor({ id: '__read__' }), 'var(--list-ochre)');
  // A queue, not a shelf: no colour is the correct answer, not a fallback.
  assert.equal(resolveListColor({ id: '__read_later__' }), null);

  // The heart red is deliberately outside the palette, so no list the owner
  // makes can be mistaken for Favourites.
  assert.ok(!LIST_COLORS.includes('like'));
  assert.equal(listColorVarById('like'), null);
});

test('a stored colour wins, and a junk one falls back rather than painting nothing', () => {
  assert.equal(resolveListColor({ id: 'list_1', color: 'teal' }), 'var(--list-teal)');

  // `var(--list-chartreuse)` is not an error, a warning, or a colour — it is a
  // dropped declaration. Anything unrecognised has to land on the fallback.
  const junk = resolveListColor({ id: 'list_1', color: 'chartreuse' });
  assert.equal(junk, resolveListColor({ id: 'list_1' }), 'must fall back, not emit an unknown token');
  assert.ok(LIST_COLORS.some(id => junk === `var(--list-${id})`));
});

test('a list with no colour gets the same one every time', () => {
  // Every list created before the palette existed has no `color`. They are
  // resolved from the id so they need no migration — but only if the answer is
  // stable, or a list changes colour on every device the owner opens.
  for (const id of ['list_1724000000000', 'list_9', 'a', '__custom__x']) {
    const first = resolveListColor({ id });
    assert.equal(resolveListColor({ id }), first, `${id} must be stable`);
    assert.ok(LIST_COLORS.some(colorId => first === `var(--list-${colorId})`), `${id} must land in the palette`);
  }

  assert.equal(resolveListColor(null), null);
  assert.equal(resolveListColor({}), null, 'no id, no colour to derive');
});

test('the picker and the card agree on which swatch is the current one', () => {
  // Opening the editor on a list that has never been recoloured has to tick the
  // swatch the card is already wearing. Two code paths deriving it separately
  // is exactly how they would come to disagree.
  for (const list of [{ id: 'list_1' }, { id: 'list_1', color: 'violet' }, { id: 'zz' }]) {
    assert.equal(resolveListColor(list), `var(--list-${resolveListColorId(list)})`);
  }

  // The built-in three have no palette entry to tick.
  for (const id of ['__favorites__', '__read__', '__read_later__']) {
    assert.equal(resolveListColorId({ id }), null);
  }
});

test('the random colour is always one the picker can show', () => {
  for (let i = 0; i < 200; i += 1) {
    assert.ok(LIST_COLORS.includes(randomListColorId()));
  }
});
