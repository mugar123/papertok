import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EDITOR_FROM_PROFILE, cameFromProfile } from './editorOrigin.js';

/** Source without its comments, so a mention in prose cannot satisfy a check. */
async function stripped(relativePath) {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('a location carrying the profile origin is recognised, anything else is not', () => {
  assert.equal(cameFromProfile({ state: EDITOR_FROM_PROFILE.state }), true);
  assert.equal(cameFromProfile({ state: { from: 'profile' } }), true);
  assert.equal(cameFromProfile({ state: { from: 'settings' } }), false);
  assert.equal(cameFromProfile({ state: null }), false);
  assert.equal(cameFromProfile({}), false);
  assert.equal(cameFromProfile(undefined), false);
});

test('the origin object is frozen: a page cannot mutate the shared state', () => {
  assert.ok(Object.isFrozen(EDITOR_FROM_PROFILE));
  assert.ok(Object.isFrozen(EDITOR_FROM_PROFILE.state));
});

test('every door from the profile page into the editor carries the origin', async () => {
  const source = await stripped('../Public/PublicProfilePage.jsx');
  const doors = source.match(/navigate\(\s*'\/settings\/profile'[^)]*\)/g) || [];
  assert.ok(doors.length >= 4, `expected the gear, Edit profile, the private notice and the create CTA; found ${doors.length}`);
  for (const door of doors) {
    assert.match(door, /EDITOR_FROM_PROFILE/, `a door forgets where it came from: ${door}`);
  }
  assert.match(source, /import \{[^}]*EDITOR_FROM_PROFILE[^}]*\} from '\.\.\/Profile\/editorOrigin\.js'/);
});

test('the editor reads the origin and answers with its own eyebrow and back label', async () => {
  const source = await stripped('./ProfilePage.jsx');
  assert.match(source, /cameFromProfile\(location\)/);
  // The profile-origin voice, in both languages.
  assert.match(source, /eyebrowFromProfile:\s*'Profile · Settings'/);
  assert.match(source, /eyebrowFromProfile:\s*'Perfil · Ajustes'/);
  assert.match(source, /backToProfile:\s*'Back to profile'/);
  assert.match(source, /backToProfile:\s*'Volver al perfil'/);
  // The hub's voice stays the default.
  assert.match(source, /SETTINGS_BREADCRUMB\[isEnglish \? 'en' : 'es'\]/);
});
