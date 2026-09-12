import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

/**
 * El morado que la app dejó de usar el 2026-08-24 (e56a7ea, «light design
 * system»), cuando `--accent-primary` pasó a ser tinta.
 *
 * Los sitios que lo nombraban a pelo no siguieron al token, y como los dos que
 * quedaban eran estados de HOVER, nada los delató hasta que un ratón se posó
 * encima: un botón negro que se volvía morado al pasar por él. El mismo
 * accidente que AnalyticsConsentBanner.css ya documenta para una sombra.
 *
 * De ahí este barrido: un color retirado no se vigila leyendo pantallas, se
 * vigila leyendo ficheros. Si alguna vez vuelve a hacer falta un violeta, hay
 * un token para eso (`--accent-violet`) y este test no lo toca.
 */

const RETIRED_PURPLE = [
  ['el acento de antes de e56a7ea', /rgba?\(\s*124\s*,\s*58\s*,\s*237|#7c3aed\b/i],
  ['su hover más claro', /rgba?\(\s*139\s*,\s*74\s*,\s*242|#8b4af2\b/i],
];

async function stylesheetsUnder(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) found.push(...await stylesheetsUnder(path));
    else if (entry.name.endsWith('.css')) found.push(path);
  }
  return found;
}

test('ninguna hoja de estilos nombra el morado retirado', async () => {
  const sheets = await stylesheetsUnder(new URL('../', import.meta.url));
  assert.ok(sheets.length > 20, `el barrido solo encontró ${sheets.length} hojas: la búsqueda está rota, no el código`);

  const offenders = [];
  for (const sheet of sheets) {
    const css = await readFile(sheet, 'utf8');
    for (const [what, pattern] of RETIRED_PURPLE) {
      const hit = css.match(pattern);
      if (hit) offenders.push(`${sheet.pathname.split('/src/')[1]}: ${what} (${hit[0]})`);
    }
  }

  assert.deepEqual(offenders, [], `usa var(--accent-primary-hover) y sus hermanos:\n${offenders.join('\n')}`);
});
