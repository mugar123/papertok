import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canSubmitCreateList,
  createListFormReducer,
  CREATE_LIST_FORM_INITIAL,
} from './createListFormModel.ts';

const typed = (name: string) => createListFormReducer(CREATE_LIST_FORM_INITIAL, { type: 'name', value: name });

test('a blank name cannot be submitted, spaces included', () => {
  for (const name of ['', ' ', '\t  \n']) {
    assert.equal(canSubmitCreateList(typed(name)), false, `must refuse ${JSON.stringify(name)}`);
  }
  assert.equal(canSubmitCreateList(typed('Relatividad')), true);
});

test('a submit already in flight cannot be submitted again', () => {
  const flying = createListFormReducer(typed('Relatividad'), { type: 'submit' });
  assert.equal(flying.busy, true);
  // The id is minted from Date.now(), so a second submit would either collide
  // with the first or quietly create a second identical list.
  assert.equal(canSubmitCreateList(flying), false);
  assert.deepEqual(createListFormReducer(flying, { type: 'submit' }), flying,
    'the reducer refuses it too, not just the disabled attribute');

  // And a blank name refused by the reducer itself: `disabled` on the button
  // does not stop Enter, which reaches the handler by its own path.
  const blank = typed('   ');
  assert.deepEqual(createListFormReducer(blank, { type: 'submit' }), blank,
    'a submit the reducer should have refused must not raise busy');
});

test('reopening starts from nothing, never from the last attempt', () => {
  const dirty = createListFormReducer(
    createListFormReducer(typed('Vieja'), { type: 'icon', value: 'Atom' }),
    { type: 'failed' },
  );
  assert.deepEqual({ name: dirty.name, icon: dirty.icon, error: dirty.error },
    { name: 'Vieja', icon: 'Atom', error: true });
  assert.deepEqual(createListFormReducer(dirty, { type: 'open' }), CREATE_LIST_FORM_INITIAL);
});

test('a failure stops the flight and says so, and typing clears the message', () => {
  const failed = createListFormReducer(
    createListFormReducer(typed('Relatividad'), { type: 'submit' }),
    { type: 'failed' },
  );
  assert.deepEqual({ busy: failed.busy, error: failed.error }, { busy: false, error: true });
  assert.equal(canSubmitCreateList(failed), true, 'the caller can try again');

  // Carrying the old message into the next attempt would say "it failed" about
  // a request that has not been made yet.
  assert.equal(createListFormReducer(failed, { type: 'name', value: 'Relatividad!' }).error, false);
  assert.equal(createListFormReducer(failed, { type: 'submit' }).error, false);
});

test('the icon survives everything except reopening', () => {
  const picked = createListFormReducer(typed('T'), { type: 'icon', value: 'Dna' });
  assert.equal(createListFormReducer(picked, { type: 'name', value: 'T2' }).icon, 'Dna');
  assert.equal(createListFormReducer(picked, { type: 'failed' }).icon, 'Dna');
  assert.equal(CREATE_LIST_FORM_INITIAL.icon, 'Folder');
});

test('opening seeds the window, and an omitted field never carries over', () => {
  const dirty = createListFormReducer(
    createListFormReducer(typed('Vieja'), { type: 'icon', value: 'Atom' }),
    { type: 'color', value: 'violet' },
  );

  // Editing: the window opens on the list as it stands.
  const editing = createListFormReducer(dirty, {
    type: 'open',
    preset: { name: 'Papers de sugar', icon: 'Dna', color: 'green' },
  });
  assert.deepEqual({ name: editing.name, icon: editing.icon, color: editing.color },
    { name: 'Papers de sugar', icon: 'Dna', color: 'green' });

  // Creating: only the rolled colour is seeded, and the name and icon must come
  // back empty rather than from whatever the window held last time.
  const creating = createListFormReducer(dirty, { type: 'open', preset: { color: 'teal' } });
  assert.deepEqual({ name: creating.name, icon: creating.icon, color: creating.color },
    { name: '', icon: 'Folder', color: 'teal' });
});

test('the colour survives everything except reopening', () => {
  const picked = createListFormReducer(typed('T'), { type: 'color', value: 'crimson' });
  assert.equal(createListFormReducer(picked, { type: 'name', value: 'T2' }).color, 'crimson');
  assert.equal(createListFormReducer(picked, { type: 'icon', value: 'Dna' }).color, 'crimson');
  assert.equal(createListFormReducer(picked, { type: 'failed' }).color, 'crimson');
});

test('an action nobody defined leaves the state exactly as it was', () => {
  const state = typed('T');
  assert.equal(createListFormReducer(state, { type: 'nonsense' as never }), state);
});
