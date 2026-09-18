/**
 * The rewrite sequence's motion contract.
 *
 * Every number here is copied from the app, and the reason to pin them in a
 * test is that nothing else can: a stylesheet has no other reader. What the
 * assertions are really guarding is that this section keeps running on the
 * product's clock instead of drifting into numbers somebody liked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* Comments stripped: a number that only appears inside a comment is a claim,
   not a rule, and a test that reads one is measuring prose. */
const css = readFileSync(new URL('./motion.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const structure = readFileSync(new URL('./landing.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of ONE rule, bounded — not the whole file. */
function ruleBody(selector) {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `there is no rule for ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open !== -1 && close > open, `${selector} has no body`);
  return css.slice(open + 1, close);
}

test('the level chip is the brand yellow, and it travels', () => {
  const body = ruleBody('.lp-levels::after');
  assert.match(body, /background:\s*var\(--brand-yellow\)/);
  assert.match(body, /transition:\s*transform 220ms var\(--lp-ease-travel\)/);
  assert.match(body, /translateX\(calc\(var\(--lp-level, 0\) \* 100%\)\)/);
});

test('every animation of the sequence is declared with its own numbers', () => {
  const expected = [
    ['.lp-rewrite[data-phase] .lp-rewrite__card > *', /lpArrive var\(--lp-arrive-ms\) var\(--ease-out-expo\) backwards/],
    ['.lp-rewrite[data-open] .lp-rewrite__card', /lpChromeOut 120ms var\(--lp-ease-in\) both/],
    ['.lp-rewrite[data-open] .lp-rewrite__reader', /lpShellIn var\(--lp-arrive-ms\) var\(--ease-out-expo\) 120ms both/],
    ['.lp-rewrite[data-open] .lp-rewrite__status', /lpChromeIn 280ms var\(--ease-out-expo\) 150ms both/],
    ['.lp-rewrite[data-open] .lp-levels-frame', /lpChromeIn 280ms var\(--ease-out-expo\) 210ms both/],
    ['.lp-rewrite[data-busy] .lp-ghost', /lpGhostIn 260ms var\(--ease-out-expo\) 240ms both/],
    [".lp-rewrite[data-phase='done'] .lp-ghost", /lpGhostOut 180ms var\(--lp-ease-in\) both/],
  ];
  for (const [selector, re] of expected) assert.match(ruleBody(selector), re);
});

test('the first stage waits for the skeleton it lives inside', () => {
  // Without this delay its entrance runs under a parent at opacity 0 and
  // "Downloading the paper" is the one label nobody ever sees arrive.
  assert.match(
    ruleBody(".lp-rewrite[data-phase='source'] [data-rewrite-stage='source'] {"),
    /animation-delay:\s*240ms/,
  );
});

test('the text writes itself with the reader s own mask and stagger', () => {
  const body = ruleBody(".lp-rewrite[data-write] .lp-panel__level[data-active='true'] p");
  assert.match(body, /animation:\s*lpWriteIn 620ms var\(--ease-out-expo\) backwards/);
  assert.match(body, /animation-delay:\s*calc\(\(var\(--lp-i, 0\) \+ 1\) \* 70ms \+ 120ms\)/);
  assert.match(body, /mask-size:\s*260% 100%/);
});

test('the sequence is scoped to [data-phase], so no JavaScript means no start state', () => {
  // The landing is prerendered: an unscoped :not([data-phase='done']) would
  // match with no attribute at all and hide the one thing the page exists to
  // deliver.
  const risky = css.match(/^\s*\.lp-rewrite(?!\[data-phase\]|\[data-open\]|\[data-busy\]|\[data-write\]|\[data-found\])[^{,]*:not\(\[data-phase/gm) || [];
  assert.deepEqual(risky, [], `unscoped negations: ${risky.join(' | ')}`);
  assert.match(ruleBody(".lp-rewrite[data-phase]:not([data-phase='done']) .lp-doc"), /opacity:\s*0/);
});

test('the invitation breathes five times: once the screen is here, until it is found', () => {
  // [data-seen] is what the observer sets when the screen arrives: armed at
  // load, the button would breathe into an empty room four flicks above the
  // visitor and be silent by the time they got here.
  const body = ruleBody(".lp-rewrite[data-seen='1'][data-found='0'][data-phase='idle'] .lp-btn--ai {");
  assert.match(body, /animation:\s*lpInvite 2800ms ease-in-out 900ms 5/);

  const breath = css.slice(css.indexOf('@keyframes lpInvite'));
  const frames = breath.slice(0, breath.indexOf('\n}') + 2);
  // One gesture on two channels: the swell and the hover ink arrive together.
  assert.match(frames, /scale:\s*1\.05/);
  assert.match(frames, /background-color:\s*var\(--brand-yellow\)/);
  assert.match(frames, /border-color:\s*var\(--brand-orange\)/);
  // The swell is paint, not layout: a breath that touched width, padding or
  // margin would reflow this screen every three seconds, and the whole
  // section is built on its box never changing height.
  assert.doesNotMatch(frames, /width|height|padding|margin|box-shadow|font-size|inset|top:|left:/);
  // And it has a REST in it: a loop with no pause is a metronome.
  assert.match(frames, /76%,\s*100%/);
});

test('the invitation leaves rather than being cut off', () => {
  // Stopping a CSS animation drops its property in one frame. The swell needs
  // somewhere to land, and that is a transition on the same property —
  // without it the button snapped from 1.05 to 1 under the pointer.
  const btn = structure.slice(structure.indexOf('.lp-btn--ai {'));
  const body = btn.slice(0, btn.indexOf('}'));
  assert.match(body, /transition:[^;]*scale 260ms var\(--ease-out-cubic\)/);

  // And :hover must NOT be what stops it: by the time the mouseenter handler
  // runs, :hover is applied already, so there would be no swell left to hand
  // over. motion.js stops it through data-found instead.
  assert.doesNotMatch(css, /\.lp-btn--ai:hover[^{]*\{[^}]*animation:\s*none/);
});

test('a reading level replaces the one before it: no frame has two passages legible at once', () => {
  // Los tres pasajes comparten una celda de rejilla
  // (`.lp-doc__levels > * { grid-area: 1 / 1 }`), así que fundirlos en los dos
  // sentidos a la vez deja dos textos distintos encima del mismo hueco. Medido
  // antes de corregirlo, a 390 px y un rAF por muestra: 11 fotogramas, 168 ms,
  // con el panel más tenue al 50 %; en la captura se leían las dos redacciones
  // y el subrayado amarillo de una cruzaba las letras de la otra.
  //
  // El que ENTRA conserva su fundido -- si se le quita también, esto deja de
  // ser una corrección y pasa a ser quitar la animación.
  const reposo = css.match(/^\.lp-panel__level \{([^}]*)\}/m);
  assert.ok(reposo, 'la regla de reposo de .lp-panel__level ha desaparecido');
  assert.doesNotMatch(
    reposo[1],
    /opacity [^,;]*(linear|ease|cubic-bezier)/,
    'el panel que sale vuelve a fundirse: durante ese fundido se leen dos textos a la vez',
  );

  const activo = css.match(/\.lp-panel__level\[data-active='true'\] \{([^}]*)\}/);
  assert.ok(activo, 'la regla del panel activo ha desaparecido');
  assert.match(activo[1], /opacity var\(--lp-fade-ms\) linear/, 'el panel que entra ya no funde');
});

test('reduced motion leaves the section exactly as it ships', () => {
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(at, -1);
  const block = css.slice(at);
  assert.match(block, /\.lp-rewrite,\s*\.lp-rewrite \*,\s*\.lp-spark \{\s*animation: none !important/);
  assert.match(block, /\.lp-rewrite \.lp-doc \{[^}]*visibility: visible !important/);
});
