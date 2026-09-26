import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SRC = new URL('../', import.meta.url);

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.js') ? [full] : [];
  }));
  return files.flat();
}

/**
 * The app draws its icons from Phosphor. A Lucide import would bring back a
 * second glyph family — heavier strokes, square terminals — beside it.
 */
test('no component imports icons from lucide-react', async () => {
  const offenders = [];
  for (const file of await sourceFiles(SRC.pathname)) {
    const source = await readFile(file, 'utf8');
    if (/from ['"]lucide-react['"]/.test(source)) offenders.push(path.relative(SRC.pathname, file));
  }
  assert.deepEqual(offenders, []);
});

/**
 * A list stores its icon by NAME in Firestore (`list.emoji`), and the names
 * were written while the app used Lucide. Every name the list dialog offers
 * has to keep resolving to its own glyph, not to the folder fallback.
 */
test('every stored list icon name still resolves to its own icon', async () => {
  const source = await readFile(new URL('./icons.js', import.meta.url), 'utf8');
  const offered = JSON.parse(source.match(/export const AVAILABLE_ICONS = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
  const icons = source.match(/export const ICONS = \{([\s\S]*?)\};/)[1];
  const keys = icons.split(',').map(part => part.trim().split(':')[0].trim()).filter(Boolean);
  for (const name of offered) {
    assert.ok(keys.includes(name), `"${name}" is offered for new lists but has no entry in ICONS`);
  }
  assert.match(icons, /FlaskConical: Flask/);
  assert.match(icons, /Flame: Fire/);
});
