import test from 'node:test';
import assert from 'node:assert/strict';
import { Fire, Flask, Folder } from '@phosphor-icons/react';
import { AVAILABLE_ICONS, getIcon } from './icons.ts';

/**
 * A list stores its icon by NAME in Firestore (`list.emoji`), and the names
 * were written while the app used Lucide. Every name the list dialog offers
 * has to keep resolving to its own glyph, not to the folder fallback.
 */
test('every stored list icon name still resolves to its own icon', () => {
  for (const name of AVAILABLE_ICONS.filter(name => name !== 'Folder')) {
    assert.notEqual(getIcon(name), Folder, `"${name}" is offered for new lists but resolves to the folder fallback`);
  }
  assert.equal(getIcon('FlaskConical'), Flask);
  assert.equal(getIcon('Flame'), Fire);
});
