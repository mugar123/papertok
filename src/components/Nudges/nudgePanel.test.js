import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Los avisos de esquina: el panel y quien decide enseñarlo.
 *
 * Todo lo que se puede decidir sin navegador vive en utils/nudges.js y se
 * prueba allí. Lo que queda aquí es el cableado, que ningún test de unidad ve:
 * a quién se le enseña, cuándo, y que el panel siga siendo un aviso y no un
 * diálogo. Más la forma del movimiento, que es la misma que la del banner de
 * analítica a propósito — dos paneles que aparecen en la misma esquina y se
 * mueven distinto se leen como dos sistemas hablándose encima.
 */

const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = path => readFile(new URL(path, import.meta.url), 'utf8').then(stripComments);
const panelJsx = read('./NudgePanel.jsx');
const panelCss = read('./NudgePanel.css');
const hostJsx = read('./NudgeHost.jsx');
const appJsx = read('../../App.jsx');

const motionClock = (block, property) => {
  const match = block.match(new RegExp(`(?<![A-Za-z-])${property}: \\{ duration: ([\\d.]+), ease: ([^}]+?) \\}`));
  return match && { duration: Number(match[1]), ease: match[2].trim() };
};

for (const [name, anchor] of [['la llegada', 'const ARRIVAL'], ['la marcha', 'const LEAVE']]) {
  test(`${name} del panel funde en recta y más corto que su recorrido`, async () => {
    const jsx = await panelJsx;
    const start = jsx.indexOf(anchor);
    assert.notEqual(start, -1, `falta ${anchor}`);
    const block = jsx.slice(start, start + 320);
    const fade = motionClock(block, 'opacity');
    const travel = motionClock(block, 'y');
    const scale = motionClock(block, 'scale');
    assert.ok(fade && travel && scale, `${name}: cada valor necesita su reloj`);
    assert.equal(fade.ease, "'linear'", `${name}: una curva sobre la opacidad es un destello, no un fundido`);
    assert.ok(fade.duration < travel.duration, `${name}: el fundido (${fade.duration}s) debe acabar antes que el viaje (${travel.duration}s)`);
    assert.equal(scale.duration, travel.duration, `${name}: escala y recorrido son un solo gesto`);
  });
}

test('sale por donde entró: sube al llegar y se hunde al irse', async () => {
  const jsx = await panelJsx;
  assert.match(jsx, /initial=\{prefersReducedMotion \? false : \{ opacity: 0, y: 14, scale: 0\.985 \}\}/);
  assert.match(jsx, /exit=\{prefersReducedMotion \? \{ opacity: 0 \} : \{ opacity: 0, y: 18, scale: 0\.98, transition: LEAVE \}\}/);
});

test('el panel es un aviso, no un diálogo: no roba el foco ni tapa nada', async () => {
  const jsx = await panelJsx;
  assert.match(jsx, /<motion\.aside/, 'un aviso es un aside');
  assert.ok(!/role="dialog"|aria-modal|Dialog|FocusTrap|autoFocus/.test(jsx), 'nada que atrape el foco');
  assert.match(jsx, /aria-labelledby="nudge-title"/);
  assert.match(jsx, /aria-label=\{dismissLabel\}/, 'la X necesita nombre');
});

test('el acento vive en la estrella del chip, cubre solo su retardo y no deja matriz pegada', async () => {
  const css = await panelCss;
  const rule = css.match(/\.nudge-stars svg \{([^}]*)\}/);
  assert.ok(rule, 'falta la regla de la estrella del chip');
  assert.match(rule[1], /animation: nudgeStarPop 420ms cubic-bezier\(0\.34, 1\.4, 0\.64, 1\) 320ms backwards/,
    'el relleno es backwards: con both la matriz final se queda soldada al icono');
  assert.ok(!/nudgeStarPop[^;]*\bboth\b/.test(css), 'ni un both en el acento');
});

test('la marca del panel es tinta, y el amarillo solo acompaña', async () => {
  const css = await panelCss;
  assert.match(css, /\.nudge-icon--github \{[^}]*color: var\(--text-primary\)/,
    'el logo de GitHub va en tinta, como toda marca de la app');
  const chip = css.match(/\.nudge-stars svg \{[\s\S]*?\}/) && css.match(/\.nudge-stars svg \{([\s\S]*?)\}/);
  assert.ok(chip, 'falta el estilo de la estrella del chip');
  const fill = css.match(/\.nudge-stars svg \{[^}]*\}/g)?.join('\n') || '';
  assert.match(fill + css, /fill: var\(--brand-yellow\)/, 'el amarillo se queda en el chip');
  const jsx = await hostJsx;
  assert.match(jsx, /<GithubMark size=\{19\} \/>/, 'el icono del aviso es el logo del repo');
});

test('con movimiento reducido el adorno se va y el panel sigue entendiéndose', async () => {
  const css = await panelCss;
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.nudge-stars svg,/);
  assert.match(reduced, /animation: none/);
  const panel = await panelJsx;
  assert.match(panel, /prefersReducedMotion \? \{ opacity: 0 \}/, 'sin movimiento, pero con fundido');
});

/**
 * Las cuatro reglas del host, que son las que duelen si se rompen.
 */
test('nadie es interrumpido antes de tiempo, ni sin sesión, ni fuera del feed', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /const signedIn = Boolean\(user\) && !authLoading && onboardingComplete;/, 'los invitados quedan fuera');
  assert.match(jsx, /setTimeout\(\(\) => setDwellDone\(true\), NUDGE_DWELL_MS\)/, 'hay que esperar el minuto');
  assert.match(jsx, /location\.pathname === '\/'/, 'solo en el feed');
  assert.match(jsx, /consent !== null/, 'nunca encima del banner de consentimiento');
});

test('uno por visita, y el descarte se recuerda para siempre', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /if \(openable && !choiceMade\) \{\s*setChoiceMade\(true\);/, 'la elección se hace una sola vez');
  assert.match(jsx, /setDismissed\(rememberNudgeDismissal\(id\)\)/, 'cerrar tiene que persistir');
  assert.ok(!/sessionStorage/.test(jsx), 'la memoria del descarte no puede morir con la pestaña');
});

test('el número de estrellas viaja con el panel o no viaja', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /const ready = picked !== null && stars !== undefined;/,
    'sin recuento resuelto no se enseña: un hueco que se rellena tarde empuja el texto');
  assert.match(jsx, /setTimeout\(\(\) => reveal\(null\), STAR_FETCH_BUDGET_MS\)/, 'y si GitHub no contesta, sale sin él');
  assert.match(jsx, /if \(usable\) cacheStarCount\(count\)/, 'una vez preguntado, se guarda');
});

/**
 * Una sola puerta al repo. La dirección estuvo un rato escrita bajo la frase,
 * en mono, hasta que quedó claro que no añadía nada: el botón ya va ahí, y una
 * línea más alta el panel para repetir el destino.
 */
test('el botón es la única puerta al repo, y se abre fuera', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /export const REPO_URL = 'https:\/\/github\.com\/mugar123\/papertok'/);
  assert.match(jsx, /action=\{\{ label: copy\['open-source'\]\.cta, href: REPO_URL, onClick: handleStar \}\}/);
  assert.ok(!/nudge-link/.test(jsx), 'nada de repetir la dirección debajo del texto');
  const panel = await panelJsx;
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/, 'una pestaña nueva, sin prestarle el opener');
});

test('el host se monta después del banner de analítica', async () => {
  const app = await appJsx;
  const banner = app.indexOf('<AnalyticsConsentBanner />');
  const host = app.indexOf('<NudgeHost />');
  assert.notEqual(host, -1, 'el host no está montado');
  assert.ok(banner < host, 'el aviso va detrás del banner, que es el dueño de la esquina hasta que se responde');
});
