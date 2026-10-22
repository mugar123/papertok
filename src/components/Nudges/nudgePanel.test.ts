import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Los avisos de esquina: el panel y quien decide enseñarlo.
 *
 * Todo lo que se puede decidir sin navegador vive en utils/nudges.js y se
 * prueba allí. Lo que queda aquí es el cableado, que ningún test de unidad ve:
 * a quién se le enseña, cuándo, y que el panel siga siendo un aviso y no un
 * diálogo. Más la forma del movimiento, que era la misma que la del banner de
 * analítica a propósito — dos paneles que aparecen en la misma esquina y se
 * mueven distinto se leen como dos sistemas hablándose encima. El banner se
 * fue el 2026-09-17 (la analítica de Vercel no lleva cookies y no hay nada
 * que pedir); la forma se queda, y la esquina es ya solo de este aviso.
 */

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8').then(stripComments);
const panelJsx = read('./NudgePanel.tsx');
const hostJsx = read('./NudgeHost.tsx');
const appJsx = read('../../App.tsx');

const motionClock = (block: string, property: string) => {
  const match = block.match(new RegExp(`(?<![A-Za-z-])${property}: \\{ duration: ([\\d.]+), ease: ([^}]+?) \\}`));
  return match && { duration: Number(match[1]), ease: match[2].trim() };
};

for (const [name, anchor] of [['la llegada', 'const ARRIVAL'], ['la marcha', 'const LEAVE']] as const) {
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

test('con movimiento reducido el panel sigue fundiendo', async () => {
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
  assert.match(jsx, /location\.pathname === '\/feed'/, 'solo en el feed');
  // Desde el 2026-10-20 la petición de consentimiento vuelve y es la primera:
  // solo con sesión, y ningún aviso le quita la esquina hasta que se contesta.
  assert.match(jsx, /const askConsent = signedIn && !decided;/, 'el consentimiento se pide solo con sesión');
  assert.match(jsx, /const openable = dwellDone\s*&& signedIn\s*&& decided/, 'los avisos esperan a la respuesta');
});

test('uno por visita, y el descarte se recuerda para siempre', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /if \(\(openable \|\| guestOpenable\) && !choiceMade\) \{\s*setChoiceMade\(true\);/, 'la elección se hace una sola vez');
  assert.match(jsx, /setDismissed\(rememberNudgeDismissal\(id\)\)/, 'cerrar tiene que persistir');
  assert.ok(!/sessionStorage/.test(jsx), 'la memoria del descarte no puede morir con la pestaña');
});

test('App monta el host y ya no la alerta de analítica', async () => {
  const app = await appJsx;
  assert.match(app, /<NudgeHost \/>/, 'el host no está montado');
  assert.ok(!/AnalyticsConsentBanner/.test(app), 'la alerta de analítica sigue montada: desde el 17-09 no se pide permiso');
});

/**
 * The privacy policy change notice: owed to every reader, so it takes the
 * visit's turn before any nudge and is the only panel a guest sees, on the
 * public pages they read rather than in the welcome.
 */
test('a policy change is told before any nudge, and to guests only on a public page', async () => {
  const jsx = await hostJsx;
  assert.match(jsx, /const guestReading = !user && !authLoading && isPublicRoute\(location\.pathname\);/);
  assert.match(jsx, /if \(!\(signedIn \|\| guestReading\) \|\| dwellDone\) return undefined;/, 'guests wait the minute too');
  assert.match(jsx, /const guestOpenable = dwellDone && guestReading;/);
  assert.match(
    jsx,
    /acknowledged: readPrivacyNoticeAck\(user\?\.uid\),\s*accountCreated: user\?\.metadata\?\.creationTime,/,
    'read for this reader: the account, or the device without one',
  );
  assert.match(jsx, /const id = privacyOwed \? PRIVACY_NOTICE : openable && pickNudge\(/, 'guests get no other nudge');
});

test('the notice is announced politely and dismissed for this reader and version', async () => {
  const jsx = await hostJsx;
  const status = jsx.indexOf('<p className="visually-hidden" role="status">');
  assert.ok(status !== -1 && status < jsx.indexOf('<AnimatePresence>'), 'the live region is mounted outside the panel, before it');
  assert.match(jsx, /\{privacyShown \? `\$\{copy\.privacy\.title\}\. \$\{PRIVACY_POLICY_CHANGE\}` : ''\}/);
  assert.match(jsx, /rememberPrivacyNotice\(uid, PRIVACY_POLICY_VERSION\);\s*setPicked\(null\);/);
  assert.match(jsx, /<a href="\/privacy\.html" target="_blank" rel="noopener noreferrer">\s*\{copy\.privacy\.policy\}/);
});
