import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The menu used to hand Base UI a stable FUNCTION as its anchor, and Base UI
 * resolves a function anchor when the popup mounts and not again. Select
 * another sentence while the menu is still leaving — a double-click on a
 * word, a short drag — and the popup reopened on the previous selection's
 * rectangle, 300px from the new provisional mark (measured 2026-09-17, see
 * docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md). The anchor is a VALUE now,
 * latched in render so it changes with every selection and is kept through
 * the leave; Base UI re-anchors on the change. A new selection also puts the
 * composer away: the previous one's draft is not this one's.
 */
test('the selection menu re-anchors on every new selection and keeps the last rectangle through its leave', async () => {
  const jsx = stripComments(await read('./SelectionMenu.jsx'));
  assert.match(jsx, /const \[anchorSeen, setAnchorSeen\] = useState\(anchor\);/);
  assert.match(jsx, /const \[anchorElement, setAnchorElement\] = useState\(\(\) => virtualAnchor\(anchor\)\);/);
  assert.match(jsx, /if \(anchor && anchor !== anchorSeen\) \{\s*setAnchorSeen\(anchor\);\s*setAnchorElement\(virtualAnchor\(anchor\)\);\s*setComposing\(false\);\s*setDraft\(''\);\s*\}/);
  assert.match(jsx, /anchor=\{anchorElement\}/);
  assert.doesNotMatch(jsx, /anchorRef|resolveAnchor/);
});
