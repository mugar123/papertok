import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * El engranaje del perfil lleva a los ajustes DEL PERFIL (2026-08-29): los
 * generales se alcanzan desde la navbar. Un engranaje sobre el perfil que
 * aterrizaba en el hub entero obligaba a buscar la sección a mano.
 */
test('la burbuja de ajustes del perfil apunta a /settings/profile, no al hub', async () => {
  const source = await readFile(new URL('./PublicProfilePage.jsx', import.meta.url), 'utf8');
  const gear = source.match(/className="profile-gear"[\s\S]*?<\/button>/);
  assert.ok(gear, 'PublicProfilePage ya no renderiza la burbuja .profile-gear');
  assert.match(gear[0], /navigate\('\/settings\/profile'\)/);
  assert.doesNotMatch(gear[0], /navigate\('\/settings'\)/);
});
