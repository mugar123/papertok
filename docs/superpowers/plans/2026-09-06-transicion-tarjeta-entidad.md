# Transición tarjeta → página de entidad — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir la transición de página actual (`mode="wait"`, variantes de framer, salida ease-in, barra que se desmonta) por una superposición bajo la barra fija en la que la página más profunda va encima y la otra se retiene opaca debajo, sin fotogramas vacíos, y llevar la barra a las páginas de entidad del usuario con sesión.

**Architecture:** `AnimatePresence` pasa a `mode="sync"` y `PageTransition` deja de ser un `motion.div` con variantes: es un `div` con dos atributos (`data-nav-direction`, que ya existía, y `data-page-motion`, nuevo) que `PageTransition.css` anima con `@keyframes` sobre `opacity` y `transform`. Un módulo puro, `pageMotion.js`, traduce dirección, lateralidad y presencia a uno de seis movimientos. La página saliente se saca del flujo con `position: fixed` desde el propio render y se levanta por el scroll que tenía; la entrante pone el scroll a cero y suspende dentro de su propio `Suspense`. App decide la barra para `/explorer/*` y se lo dice a `EntityExplorer` por una prop, que aplica un modificador de clase con las reglas de maquetación bajo la barra.

**Tech Stack:** React 19, framer-motion 12.40 (solo `AnimatePresence`, `usePresence`, `usePresenceData`), CSS `@keyframes`, react-router 7 (`HashRouter useTransitions={false}`), tests con `node --test` (fuente y comportamiento), diagnóstico por CDP con Chrome headless.

**Spec:** `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md` — el plan argumenta desde ahí; ante cualquier duda manda el spec.

## Global Constraints

- **Solo `opacity` y `transform` en cualquier `@keyframes`.** Ningún keyframe anima `width`, `height`, `top`, `left`, `right`, `bottom`, `margin` ni `padding` (spec §3, §6).
- **Ninguna salida con ease-in.** Toda animación corre con `var(--ease-out-expo)`; la retención (`hold`) con `linear`. Ningún `cubic-bezier(` literal en `PageTransition.css` (spec §3, §5).
- **Token:** `--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);` en `src/styles/variables.css`. Los literales que ya existen en otros ficheros no se tocan (spec §3).
- **Duraciones, solo en `PageTransition.css`, sobre `.page-transition`:** `--page-enter-ms: 220ms`, `--page-leave-ms: 180ms`, `--page-lateral-ms: 180ms`, `--page-fade-ms: 150ms`, `--page-hold-ms: 220ms`, `--page-reduced-ms: 120ms`. Todas ≤ 300 ms; `hold` ≥ `enter` y ≥ `lateral` (spec §5).
- **`EXIT_SAFETY_MS = 700`** en `pageMotion.js`, mayor que cualquier duración (spec §6).
- **Seis movimientos exactos:** `enter`, `enter-lateral`, `rest`, `hold`, `leave`, `fade`; tabla de verdad y precedencia del spec §7 al pie de la letra.
- **Desplazamientos:** 10 px (`translateY` al entrar y al irse por la vuelta, `translateX` en la pestaña). `enter` sube desde 10 px; `leave` baja 10 px: sale por donde entró (spec §5).
- **`data-nav-direction={direction}` sobrevive** en la raíz de la página; `PaperCard.css` y `explorerEntrance.test.js` lo leen. `PaperCard.css` no se toca (spec §5).
- **Nada dentro del Explorer cambia** salvo la prop `appChrome`, la clase `explorer--app` en sus tres raíces y las reglas CSS bajo `.explorer--app` (spec §4). El héroe, el esqueleto y los paneles quedan como están.
- **`initial={false}` y `custom={pageTransitionCustom}` se quedan** en `AnimatePresence`; el `Suspense` exterior de `App.jsx` se queda (spec §6).
- **`IS_DEMO = true` en `src/services/firebase.js` jamás se commitea.** Antes de cada commit de la Tarea 6: `git diff --exit-code src/services/firebase.js`.
- **Tests de fuente** según la convención de `ce139ce`: despojar comentarios antes de casar, capturas acotadas (`match` a un bloque y asertos dentro de él), y asertos que un cambio equivocado haría fallar. La regla ESLint `no-regex-spaces` prohíbe dos espacios seguidos en un regex: escribe `{2}`.
- **`npm test` y `npm run lint` verdes antes de cada commit.** Los tests de fuente se descubren solos (`find src … -name '*.test.js'`).
- **Comentarios de código en inglés**, como el resto del repositorio; prosa de docs y mensajes de commit en español. Cada commit termina con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Nunca `git stash`.** No modificar `scripts/diagnostics/explorer-hero-frames.mjs`.

---

## Estructura de ficheros

| Fichero | Responsabilidad | Tarea |
| --- | --- | --- |
| `src/components/Layout/pageMotion.js` (nuevo) | Tabla pura: `(direction, lateral, present) → movimiento`; `EXIT_SAFETY_MS`; `PAGE_MOTIONS` | 1 |
| `src/components/Layout/pageMotion.test.js` (nuevo) | Tests de comportamiento de la tabla | 1 |
| `src/styles/variables.css` | Token `--ease-out-expo` | 2 |
| `src/components/Layout/PageTransition.css` (nuevo) | Duraciones, reglas por `data-page-motion`, `@keyframes`, movimiento reducido | 2 |
| `src/components/Layout/pageTransitionMotion.test.js` (nuevo) | Tests de fuente de la hoja de estilos y del reloj de seguridad | 2 |
| `src/components/Layout/PageTransition.jsx` | Reescrito: `div` con atributos, presencia, scroll, `Suspense` interior | 3 |
| `src/App.jsx` | `mode="sync"`, comentarios; barra en `/explorer/*`, prop `appChrome` | 3, 4 |
| `src/components/Layout/pageTransition.test.js` | Reescrito: fija el componente nuevo y el modo de App | 3 |
| `src/components/Explorer/EntityExplorer.jsx` | Prop `appChrome` → clase `explorer--app` en las tres raíces | 4 |
| `src/components/Explorer/EntityExplorer.css` | Reglas `.explorer--app` | 4 |
| `src/components/Explorer/explorerAppChrome.test.js` (nuevo) | Tests de fuente de la barra y la maquetación debajo | 4 |
| `scripts/diagnostics/page-transition-frames.mjs` (nuevo) | Screencast + muestreo por fotograma de una navegación | 5 |
| `scripts/diagnostics/README.md` | Entrada del guion nuevo | 5 |
| `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md` | Sección «Después» con las cifras medidas | 6 |

Orden: 1 → 2 → 3 → 4 → 5 → 6. Las tareas 3 y 4 editan `App.jsx` en líneas distintas (3: cabecera y `AnimatePresence`; 4: `showNavbar` y la ruta del explorer).

---

### Task 1: La tabla de movimientos (`pageMotion.js`)

**Files:**
- Create: `src/components/Layout/pageMotion.js`
- Test: `src/components/Layout/pageMotion.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `pageMotionFor({ direction, lateral, present }) → 'enter' | 'enter-lateral' | 'rest' | 'hold' | 'leave' | 'fade'`; `EXIT_SAFETY_MS: number` (700); `PAGE_MOTIONS: readonly string[]`. Las tareas 2 y 3 importan los tres nombres tal cual.

- [ ] **Step 1: Escribe el test de comportamiento**

`src/components/Layout/pageMotion.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXIT_SAFETY_MS, PAGE_MOTIONS, pageMotionFor } from './pageMotion.js';

/**
 * BEHAVIOUR tests for the pure table behind `PageTransition` (spec §7 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 * The rule: the deeper page goes on top, the other stays underneath, opaque
 * and still. A page on its way out reads the navigation that ejects it.
 */
const table = [
  // present, lateral, direction → motion
  [true, false, 1, 'enter'],
  [true, true, 1, 'enter-lateral'],
  [true, true, -1, 'enter-lateral'],
  [true, false, -1, 'rest'],
  [true, false, 0, 'rest'],
  [true, true, 0, 'rest'],
  [false, true, 1, 'hold'],
  [false, true, -1, 'hold'],
  [false, false, 1, 'hold'],
  [false, false, -1, 'leave'],
  [false, false, 0, 'fade'],
  [false, true, 0, 'fade'],
];

for (const [present, lateral, direction, expected] of table) {
  test(`present=${present} lateral=${lateral} direction=${direction} → ${expected}`, () => {
    assert.equal(pageMotionFor({ present, lateral, direction }), expected);
  });
}

test('every answer is a declared motion, and every declared motion is reachable', () => {
  const seen = new Set(table.map(([present, lateral, direction]) => pageMotionFor({ present, lateral, direction })));
  for (const motion of seen) assert.ok(PAGE_MOTIONS.includes(motion), `${motion} is declared`);
  for (const motion of PAGE_MOTIONS) assert.ok(seen.has(motion), `${motion} is reachable`);
  assert.equal(PAGE_MOTIONS.length, 6);
});

test('out-of-range input reads as direction 0, not lateral, present', () => {
  assert.equal(pageMotionFor({ present: true, lateral: false, direction: 'left' }), 'rest');
  assert.equal(pageMotionFor({ present: false, lateral: false, direction: NaN }), 'fade');
  assert.equal(pageMotionFor({ present: true, lateral: 'yes', direction: 1 }), 'enter');
  assert.equal(pageMotionFor({ lateral: false, direction: 1 }), 'enter', 'no presence context means present');
  assert.equal(pageMotionFor(), 'rest');
  // A magnitude is only a sign: history moves one step at a time.
  assert.equal(pageMotionFor({ present: true, lateral: false, direction: 3 }), 'enter');
  assert.equal(pageMotionFor({ present: false, lateral: false, direction: -2 }), 'leave');
});

test('the safety clock is a whole number of milliseconds a timer can take', () => {
  assert.ok(Number.isInteger(EXIT_SAFETY_MS) && EXIT_SAFETY_MS > 0);
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test src/components/Layout/pageMotion.test.js`
Expected: FAIL — `Cannot find module '…/pageMotion.js'`.

- [ ] **Step 3: Escribe el módulo**

`src/components/Layout/pageMotion.js`:

```js
/**
 * Which movement a route page runs, from three facts it is handed.
 *
 * The rule behind the table (spec §5): the deeper page goes on top, the other
 * stays underneath, opaque and still. Two pages never fade at the same time,
 * so there is no dip in brightness and no frame without a page painted.
 *
 * `direction` is 1 going deeper, -1 coming back, 0 when the router cannot say
 * (first entry, a replace). `lateral` is a step between two navbar tabs.
 * `present` is whether AnimatePresence still counts the page as mounted; a
 * page on its way out reads the navigation that ejects it, not the one it
 * arrived with.
 *
 *   present  lateral  direction  → motion
 *   true     false    1          → enter          rises 10px over the page it covers
 *   true     true     ±1         → enter-lateral  slides 10px along the bar
 *   true     false    -1         → rest           revealed; nothing to animate
 *   true     any      0          → rest
 *   false    true     ±1         → hold           kept opaque under the new tab
 *   false    false    1          → hold           kept opaque under the deeper page
 *   false    false    -1         → leave          drops 10px and fades, on top
 *   false    any      0          → fade           opacity only, on top
 *
 * Precedence: `present`, then `direction === 0`, then `lateral`, then the
 * sign. Out-of-range input reads as 0 / false / present.
 */
export const PAGE_MOTIONS = Object.freeze(['enter', 'enter-lateral', 'rest', 'hold', 'leave', 'fade']);

/**
 * How long a leaving page may wait for its `animationend` before handing
 * itself back to AnimatePresence anyway — a background tab, a cancelled
 * animation. Longer than every `--page-*-ms` in PageTransition.css, which
 * the stylesheet's test checks.
 */
export const EXIT_SAFETY_MS = 700;

export function pageMotionFor({ direction, lateral, present } = {}) {
  const sign = typeof direction === 'number' && Number.isFinite(direction) ? Math.sign(direction) : 0;
  const isLateral = lateral === true;
  const isPresent = present !== false;

  if (isPresent) {
    if (sign === 0) return 'rest';
    if (isLateral) return 'enter-lateral';
    return sign === 1 ? 'enter' : 'rest';
  }
  if (sign === 0) return 'fade';
  if (isLateral) return 'hold';
  return sign === 1 ? 'hold' : 'leave';
}
```

- [ ] **Step 4: Comprueba que pasa**

Run: `node --test src/components/Layout/pageMotion.test.js`
Expected: PASS, 16 tests (12 de la tabla + 4).

- [ ] **Step 5: Suite y lint completos**

Run: `npm test && npm run lint`
Expected: todo verde.

- [ ] **Step 6: Commit**

```bash
git add src/components/Layout/pageMotion.js src/components/Layout/pageMotion.test.js
git commit -m "feat(transición): la tabla de movimientos de una página de ruta

Seis movimientos a partir de dirección, lateralidad y presencia: la
página más profunda va encima y la otra se retiene opaca debajo. Módulo
puro con su tabla de verdad como test; PageTransition lo leerá.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: La hoja de estilos de la transición (`PageTransition.css`) y el token

**Files:**
- Modify: `src/styles/variables.css:238-241` (bloque `/* ── Transitions ── */`)
- Create: `src/components/Layout/PageTransition.css`
- Test: `src/components/Layout/pageTransitionMotion.test.js`

**Interfaces:**
- Consumes: `EXIT_SAFETY_MS`, `PAGE_MOTIONS` de `./pageMotion.js` (Tarea 1).
- Produces: la clase `page-transition` y los selectores `[data-page-motion="…"]` / `[data-nav-direction="…"]` que la Tarea 3 escribe en la raíz; los nombres de keyframes `pageEnter`, `pageEnterFromRight`, `pageEnterFromLeft`, `pageLeave`, `pageFadeOut`, `pageFadeIn`, `pageHold`. (El spec §6 nombra además `pageFade`; son los mismos fotogramas que `pageFadeOut`, y solo existe este.)

- [ ] **Step 1: Escribe los tests de fuente**

`src/components/Layout/pageTransitionMotion.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EXIT_SAFETY_MS, PAGE_MOTIONS } from './pageMotion.js';

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/** Every `--page-<name>-ms: <n>ms` declared in the file, by name. */
function durations(css) {
  const out = {};
  for (const [, name, ms] of css.matchAll(/--page-([a-z-]+)-ms: (\d+)ms;/g)) out[name] = Number(ms);
  return out;
}

/** The body of one `@keyframes <name> { … }` block. */
function keyframes(css, name) {
  const match = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `@keyframes ${name} is declared`);
  return match[1];
}

/**
 * SOURCE tests for the route transition's stylesheet (spec §5–§6 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 */
test('six durations, every one inside the 300ms UI band, and the hold outlasts both entrances', async () => {
  const css = await read('./PageTransition.css');
  const ms = durations(css);
  assert.deepEqual(Object.keys(ms).sort(), ['enter', 'fade', 'hold', 'lateral', 'leave', 'reduced']);
  for (const [name, value] of Object.entries(ms)) assert.ok(value > 0 && value <= 300, `${name}: ${value}ms`);
  assert.ok(ms.hold >= ms.enter && ms.hold >= ms.lateral, 'the held page is not removed under a page still arriving');
  assert.ok(ms.reduced < ms.enter, 'reduced motion is shorter, not just flatter');
  // Declared once, on the root, and nowhere else as a literal.
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/);
  assert.ok(root, 'the root rule');
  assert.equal(root[1].match(/--page-[a-z-]+-ms:/g).length, 6);
  assert.equal(css.replace(root[1], '').match(/\b\d+ms\b/g), null, 'durations are named, never repeated as literals');
});

test('the leaving page hands itself back before the safety clock, never after', async () => {
  const ms = durations(await read('./PageTransition.css'));
  assert.ok(EXIT_SAFETY_MS > Math.max(...Object.values(ms)), `${EXIT_SAFETY_MS}ms outlasts every duration`);
});

test('every motion has a rule, arrivals and departures ride the app curve, nothing eases in', async () => {
  const css = await read('./PageTransition.css');
  for (const motion of PAGE_MOTIONS) {
    if (motion === 'rest') {
      assert.doesNotMatch(css, /data-page-motion="rest"/, 'rest is the absence of a rule');
      continue;
    }
    assert.match(css, new RegExp(`\\[data-page-motion="${motion}"\\]`), `${motion} has a rule`);
  }
  assert.doesNotMatch(css, /ease-in(?!-out)/);
  assert.doesNotMatch(css, /cubic-bezier\(/, 'the curve is the token, not a literal');
  const animations = [...css.matchAll(/animation: (\S+) var\(--page-[a-z-]+-ms\) (\S+) both;/g)];
  assert.equal(animations.length, 9, 'six motions and three reduced-motion rewrites, each named, timed and filled both ways');
  for (const [, name, easing] of animations) {
    assert.ok(name === 'pageHold' ? easing === 'linear' : easing === 'var(--ease-out-expo)', `${name} runs on ${easing}`);
  }
  assert.equal(css.match(/animation:/g).length, animations.length, 'no animation escapes the form above');
});

test('the token is the curve the app already runs on', async () => {
  const variables = await read('../../styles/variables.css');
  assert.match(variables, /--ease-out-expo: cubic-bezier\(0\.16, 1, 0\.3, 1\);/);
});

test('pages move on opacity and transform only, and land with no transform to re-raster', async () => {
  const css = await read('./PageTransition.css');
  const names = [...css.matchAll(/@keyframes ([a-zA-Z]+) \{/g)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), ['pageEnter', 'pageEnterFromLeft', 'pageEnterFromRight', 'pageFadeIn', 'pageFadeOut', 'pageHold', 'pageLeave']);
  for (const name of names) {
    const body = keyframes(css, name);
    assert.doesNotMatch(body, /\b(width|height|top|left|right|bottom|margin|padding)\s*:/, `${name} stays on the compositor`);
    assert.match(body, /opacity:/);
  }
  for (const name of ['pageEnter', 'pageEnterFromRight', 'pageEnterFromLeft']) {
    assert.match(keyframes(css, name), /to \{ opacity: 1; transform: none; \}/, `${name} lands with no transform`);
  }
  assert.match(keyframes(css, 'pageEnter'), /from \{ opacity: 0; transform: translateY\(10px\); \}/);
  assert.match(keyframes(css, 'pageEnterFromRight'), /from \{ opacity: 0; transform: translateX\(10px\); \}/);
  assert.match(keyframes(css, 'pageEnterFromLeft'), /from \{ opacity: 0; transform: translateX\(-10px\); \}/);
  assert.match(keyframes(css, 'pageLeave'), /to \{ opacity: 0; transform: translateY\(10px\); \}/, 'leaves the way it came');
  assert.match(keyframes(css, 'pageHold'), /from, to \{ opacity: 1; \}/, 'held: a real animation that changes nothing, so animationend fires');
});

test('the leaving page is out of flow and under the bar; an arriving page covers it only while animating', async () => {
  const css = await read('./PageTransition.css');
  const leaving = css.match(/\.page-transition\[data-page-motion="hold"\],\s*\.page-transition\[data-page-motion="leave"\],\s*\.page-transition\[data-page-motion="fade"\] \{([\s\S]*?)\n\}/);
  assert.ok(leaving, 'the three leaving motions share one geometry rule');
  assert.match(leaving[1], /position: fixed;/);
  assert.match(leaving[1], /left: 0;\s*right: 0;/);
  assert.match(leaving[1], /height: auto;/, 'a fixed flex column must not squeeze a 1300px page into the viewport');
  assert.match(leaving[1], /z-index: 1;/);
  assert.match(leaving[1], /pointer-events: none;/);
  assert.doesNotMatch(leaving[1], /\btop:/, '`top` is the page\'s own scroll, set inline by the component');
  const entering = css.match(/\.page-transition\[data-page-motion="enter"\],\s*\.page-transition\[data-page-motion="enter-lateral"\] \{([\s\S]*?)\n\}/);
  assert.ok(entering, 'the two animated arrivals share one stacking rule');
  assert.match(entering[1], /position: relative;/);
  assert.match(entering[1], /z-index: 2;/);
  const root = css.match(/\.page-transition \{([\s\S]*?)\n\}/)[1];
  assert.match(root, /width: 100%;\s*height: 100%;\s*display: flex;\s*flex-direction: column;/, 'the route root keeps the box the motion.div had');
});

test('reduced motion keeps the fades and drops the movement, for all five animated motions', async () => {
  const css = await read('./PageTransition.css');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}\s*$/);
  assert.ok(block, 'one reduced-motion block closes the file');
  const reduced = block[1];
  for (const motion of ['enter', 'enter-lateral', 'hold', 'leave', 'fade']) {
    assert.match(reduced, new RegExp(`\\[data-page-motion="${motion}"\\]`), `${motion} is redefined`);
  }
  const names = [...reduced.matchAll(/animation: (\S+) var\(--page-reduced-ms\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ['pageFadeIn', 'pageFadeOut', 'pageHold']);
  assert.doesNotMatch(reduced, /translate/);
  assert.equal(reduced.match(/animation:/g).length, names.length, 'every reduced animation rides the reduced clock');
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test src/components/Layout/pageTransitionMotion.test.js`
Expected: FAIL — `ENOENT … PageTransition.css` en cada test.

- [ ] **Step 3: El token en `variables.css`**

En `src/styles/variables.css`, justo después de la línea `  --transition-spring: 500ms cubic-bezier(0.16, 1, 0.3, 1);` (línea 241) y antes de la línea en blanco que precede a `/* ── Z-index ── */`, añade:

```css
  /* The arrival curve the app already runs on — pcArrive, slideUpFade, the
     explorer's error — as a token, so the route transition names it instead
     of adding one more copy of the literal. */
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
```

- [ ] **Step 4: Escribe la hoja de estilos**

`src/components/Layout/PageTransition.css` — el fichero entero, en este orden (los tests casan bloques por su forma):

```css
/* ============================================
   PageTransition — one page gives way to another under a fixed bar

   Two pages share the screen during a navigation (AnimatePresence
   mode="sync"): the deeper one on top, the other underneath, opaque and
   still. Two pages never fade at once, so there is no dip in brightness
   and no frame without a page painted. Which of the six movements a page
   runs is `pageMotion.js`'s table, written to `data-page-motion` by
   PageTransition.jsx; this file only moves.

   Everything is CSS keyframes on opacity and transform: predetermined
   motion that has to stay smooth while the arriving page mounts 1300px of
   content, which JS-driven values do not. Measured before this (signed in,
   chunk warm): mode="wait" left two frames with no page painted, the exit
   accelerated on an ease-in put there to hide that gap, and the handover
   took ~500ms from tap to a still page.
   ============================================ */

.page-transition {
  /* The only place a duration is written. `hold` lasts the longest
     entrance: the held page does not know which one runs on top of it,
     and 40ms under an already opaque page is invisible. */
  --page-enter-ms: 220ms;
  --page-leave-ms: 180ms;
  --page-lateral-ms: 180ms;
  --page-fade-ms: 150ms;
  --page-hold-ms: 220ms;
  --page-reduced-ms: 120ms;
  /* The box the motion.div used to set inline: without an explicit width a
     flex-column route root measures against its content and jumps on load. */
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* ─── The page on its way out ───
   Out of flow the same frame it stops being present (the attribute is set
   from the render), so the page arriving takes its place in the document
   at once. `top` is set inline by the component: minus the window scroll
   the page had, so what was on screen stays on screen while it goes.
   `height: auto`: fixed, the root's 100% would be the viewport, and a flex
   column that tall would try to squeeze a long page into it. Taps go
   through to the page underneath or the one on top. */
.page-transition[data-page-motion="hold"],
.page-transition[data-page-motion="leave"],
.page-transition[data-page-motion="fade"] {
  position: fixed;
  left: 0;
  right: 0;
  height: auto;
  z-index: 1;
  pointer-events: none;
}

/* ─── The page arriving with a movement ───
   Above the held page only while it animates: once the animation ends the
   component drops the attribute, and with it this stacking context, so a
   fixed element inside the page (the paper reader) is not trapped under
   the bar afterwards. Both indices stay under --z-nav. */
.page-transition[data-page-motion="enter"],
.page-transition[data-page-motion="enter-lateral"] {
  position: relative;
  z-index: 2;
}

/* `both`: a page whose animation starts a frame late must not flash opaque
   before its fade; and the end state holds until the attribute goes. */
.page-transition[data-page-motion="enter"] {
  animation: pageEnter var(--page-enter-ms) var(--ease-out-expo) both;
}

.page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"] {
  animation: pageEnterFromRight var(--page-lateral-ms) var(--ease-out-expo) both;
}

.page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"] {
  animation: pageEnterFromLeft var(--page-lateral-ms) var(--ease-out-expo) both;
}

/* A real animation that changes nothing: `animationend` is what hands the
   page back to AnimatePresence, and a page without an animation would be
   removed at once, under a page still arriving. */
.page-transition[data-page-motion="hold"] {
  animation: pageHold var(--page-hold-ms) linear both;
}

/* Out the way it came in: the entity rose 10px on arrival, it drops 10px
   on the way back. Ease-out — the page is gone before it looks slow. */
.page-transition[data-page-motion="leave"] {
  animation: pageLeave var(--page-leave-ms) var(--ease-out-expo) both;
}

/* A replace, or a redirect: no step to animate, the old page dissolves. */
.page-transition[data-page-motion="fade"] {
  animation: pageFadeOut var(--page-fade-ms) var(--ease-out-expo) both;
}

@keyframes pageEnter {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

@keyframes pageEnterFromRight {
  from { opacity: 0; transform: translateX(10px); }
  to { opacity: 1; transform: none; }
}

@keyframes pageEnterFromLeft {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: none; }
}

@keyframes pageLeave {
  from { opacity: 1; transform: none; }
  to { opacity: 0; transform: translateY(10px); }
}

@keyframes pageFadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes pageFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes pageHold {
  from, to { opacity: 1; }
}

/* Fewer and gentler, not none: the fades stay (they are what keeps two
   pages from teleporting), the movement goes, and everything is shorter.
   The lateral selectors repeat both attributes to match the specificity
   of the rules they override. */
@media (prefers-reduced-motion: reduce) {
  .page-transition[data-page-motion="enter"],
  .page-transition[data-page-motion="enter-lateral"][data-nav-direction="1"],
  .page-transition[data-page-motion="enter-lateral"][data-nav-direction="-1"] {
    animation: pageFadeIn var(--page-reduced-ms) var(--ease-out-expo) both;
  }

  .page-transition[data-page-motion="leave"],
  .page-transition[data-page-motion="fade"] {
    animation: pageFadeOut var(--page-reduced-ms) var(--ease-out-expo) both;
  }

  .page-transition[data-page-motion="hold"] {
    animation: pageHold var(--page-reduced-ms) linear both;
  }
}
```

- [ ] **Step 5: Comprueba que pasa**

Run: `node --test src/components/Layout/pageTransitionMotion.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Suite y lint completos**

Run: `npm test && npm run lint`
Expected: todo verde. (`accessibilityStructure.test.js` recorre todas las hojas de `src/`; si señala algo de `PageTransition.css`, léelo: será una regla real.)

- [ ] **Step 7: Commit**

```bash
git add src/styles/variables.css src/components/Layout/PageTransition.css src/components/Layout/pageTransitionMotion.test.js
git commit -m "feat(transición): la hoja de estilos de la superposición, y la curva de la app como token

Seis movimientos en keyframes sobre opacidad y transform, ease-out en
todo, duraciones dentro de la banda de 300 ms y con nombre en un solo
sitio. La página saliente sale del flujo con fixed; la entrante cubre
solo mientras anima. Movimiento reducido: solo opacidad, 120 ms.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `PageTransition` sin framer, y `App` en modo `sync`

**Files:**
- Modify: `src/components/Layout/PageTransition.jsx` (reescritura completa)
- Modify: `src/App.jsx:31-39` (comentario de cabecera sobre `mode="wait"`) y `src/App.jsx:209-215` (comentario JSX + `<AnimatePresence …>`)
- Test: `src/components/Layout/pageTransition.test.js` (reescritura completa)

**Interfaces:**
- Consumes: `pageMotionFor`, `EXIT_SAFETY_MS` de `./pageMotion.js` (Tarea 1); `./PageTransition.css` (Tarea 2); `usePresence`, `usePresenceData` de `framer-motion` 12.40 (ambos exportados; `usePresenceData()` devuelve el `custom` de `AnimatePresence` para el hijo presente y para el saliente); `usePageTransitionCustomValue` de `../../hooks/usePageTransitionCustom.js`; `RouteFallback` de `./RouteFallback.jsx`.
- Produces: la raíz `div.page-transition[data-nav-direction][data-page-motion]` que la Tarea 2 anima. Ninguna otra tarea importa nada de aquí.

- [ ] **Step 1: Reescribe el test de fuente**

Sustituye `src/components/Layout/pageTransition.test.js` entero por:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Full-line comments only: a `//` inside a string would otherwise cut the line.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/**
 * SOURCE tests for the route transition (spec:
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 *
 * Measured before this, signed in, chunk warm: `mode="wait"` made the two
 * pages strictly sequential — two frames with no page painted between the
 * feed going and the entity arriving, an exit on an ease-in put there to
 * hide that gap, ~500ms from tap to a still page. The pages coexist now: the
 * deeper one on top, the other held opaque underneath.
 */
test('the two pages of one navigation coexist, and App tells them about it once', async () => {
  const app = await read('../../App.jsx');
  assert.match(app, /<AnimatePresence mode="sync" initial=\{false\} custom=\{pageTransitionCustom\}>/);
  assert.doesNotMatch(app, /mode="wait"/, 'no page waits for another to finish leaving');
  assert.match(app, /const pageTransitionCustom = usePageTransitionCustom\(\)/);
  assert.match(app, /<PageTransitionCustomProvider value=\{pageTransitionCustom\}>/);
  // Exactly one caller, or the direction memory goes backwards.
  assert.equal((app.match(/usePageTransitionCustom\(\)/g) || []).length, 1);
});

test('a page is a plain element the stylesheet moves, not a motion component', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /^import \{ usePresence, usePresenceData \} from 'framer-motion';$/m, 'framer is the bookkeeper, nothing more');
  assert.match(jsx, /^import '\.\/PageTransition\.css';$/m);
  assert.match(jsx, /^import \{ EXIT_SAFETY_MS, pageMotionFor \} from '\.\/pageMotion\.js';$/m);
  for (const gone of [/\bmotion\./, /useReducedMotion/, /variants/, /\bx:/, /ease/, /TRAVEL_PX/, /duration/]) {
    assert.doesNotMatch(jsx, gone, `${gone} left with the old transition`);
  }
  assert.match(jsx, /<div\s+ref=\{rootRef\}\s+className="page-transition"\s+data-nav-direction=\{direction\}\s+data-page-motion=\{motion\}\s+onAnimationEnd=\{handleAnimationEnd\}\s*>/);
  assert.match(jsx, /const motion = present && settled \? 'rest' : pageMotionFor\(\{ direction, lateral, present \}\);/);
});

test('the leaving page reads the navigation that ejects it, and never computes one', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /const \[present, safeToRemove\] = usePresence\(\);/);
  assert.match(jsx, /const presenceCustom = usePresenceData\(\);/);
  assert.match(jsx, /const providerCustom = usePageTransitionCustomValue\(\);/);
  assert.match(jsx, /const \{ direction, lateral \} = presenceCustom \?\? providerCustom;/);
  assert.doesNotMatch(jsx, /usePageTransitionCustom\(\)/, 'the component never computes the direction itself');
  // A component file that also exports a function breaks Fast Refresh.
  assert.doesNotMatch(jsx, /export function/, 'PageTransition.jsx exports only its component');
});

test('a move between navbar tabs takes its direction from the bar, not from history', async () => {
  const hook = await read('../../hooks/usePageTransitionCustom.js');
  assert.match(hook, /import \{ lateralTabDirection \} from '\.\.\/utils\/tabDirection\.js';/);
  // The lateral answer wins; history is the fallback, not the other way round.
  assert.match(hook, /const lateral = lateralTabDirection\(useLocation\(\)\.pathname\);/);
  assert.match(hook, /return \{ direction: lateral \?\? historyDirection, lateral: lateral !== null \};/);
});

test('the leaving page hands itself back when its own animation ends, or when the clock runs out', async () => {
  const jsx = await read('./PageTransition.jsx');
  const handler = jsx.match(/const handleAnimationEnd = useCallback\(\(event\) => \{([\s\S]*?)\n {2}\}, \[present, safeToRemove\]\);/);
  assert.ok(handler, 'one animationend handler, keyed on presence');
  assert.match(handler[1], /if \(event\.target !== rootRef\.current\) return;/, 'the cards\' and the hero\'s animationend bubble here too');
  assert.match(handler[1], /if \(present\) setSettled\(true\);/);
  assert.match(handler[1], /else if \(safeToRemove\) safeToRemove\(\);/);
  const clock = jsx.match(/useEffect\(\(\) => \{\s*if \(present \|\| !safeToRemove\) return undefined;([\s\S]*?)\}, \[present, safeToRemove\]\);/);
  assert.ok(clock, 'the safety clock is keyed on presence');
  assert.match(clock[1], /const timer = window\.setTimeout\(safeToRemove, EXIT_SAFETY_MS\);/);
  assert.match(clock[1], /return \(\) => window\.clearTimeout\(timer\);/);
});

test('the leaving page is lifted by the scroll it had, tracked only while present', async () => {
  const jsx = await read('./PageTransition.jsx');
  const tracker = jsx.match(/useLayoutEffect\(\(\) => \{\s*if \(!present\) return undefined;([\s\S]*?)\}, \[present\]\);/);
  assert.ok(tracker, 'the scroll listener lives and dies with presence, in the layout phase');
  assert.match(tracker[1], /window\.addEventListener\('scroll', record, \{ passive: true \}\);/);
  assert.match(tracker[1], /return \(\) => window\.removeEventListener\('scroll', record\);/);
  assert.match(jsx, /root\.style\.top = present \? '' : `\$\{-scrollYRef\.current\}px`;/);
});

test('a new page starts at the top, instantly, and only when it is a step somewhere', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /const arrivalDirection = useRef\(direction\);/);
  assert.match(jsx, /useLayoutEffect\(\(\) => \{\s*if \(arrivalDirection\.current !== 0\) window\.scrollTo\(\{ top: 0, behavior: 'instant' \}\);\s*\}, \[\]\);/);
});

test('a cold chunk suspends inside the page arriving', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /^import RouteFallback from '\.\/RouteFallback\.jsx';$/m);
  assert.match(jsx, /<Suspense fallback=\{<RouteFallback \/>\}>\{children\}<\/Suspense>/);
  const app = await read('../../App.jsx');
  // The outer boundary stays as the net for anything that suspends outside a page.
  assert.ok((app.match(/<Suspense fallback=\{<RouteFallback \/>\}>/g) || []).length >= 1);
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test src/components/Layout/pageTransition.test.js`
Expected: FAIL en 7 de los 8 tests; pasa solo el de la pestaña, que fija el hook y no el componente. Si alguno de los otros pasa antes de tocar código, el aserto es vacuo: arréglalo antes de seguir.

- [ ] **Step 3: Reescribe el componente**

Sustituye `src/components/Layout/PageTransition.jsx` entero por:

```jsx
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePresence, usePresenceData } from 'framer-motion';
import { usePageTransitionCustomValue } from '../../hooks/usePageTransitionCustom.js';
import RouteFallback from './RouteFallback.jsx';
import { EXIT_SAFETY_MS, pageMotionFor } from './pageMotion.js';
import './PageTransition.css';

/**
 * One route page, and how it arrives or leaves.
 *
 * Two pages share the screen during a navigation (`AnimatePresence
 * mode="sync"` in App.jsx): the deeper one on top, the other underneath,
 * opaque and still. Which is which — and whether this page moves at all —
 * is `pageMotionFor`'s table, written to `data-page-motion` for
 * PageTransition.css to animate. Everything visible is CSS keyframes on
 * opacity and transform: predetermined motion that has to stay smooth while
 * the arriving page mounts 1300px of content, which JS-driven values do not.
 * framer-motion is only the bookkeeper here — who is still present, and the
 * navigation the leaving page must answer to.
 *
 * Measured before this (signed in, chunk warm): `mode="wait"` left two frames
 * with no page painted between the feed going and the entity arriving, the
 * exit accelerated on an ease-in, and the whole handover took ~500ms.
 */
export default function PageTransition({ children }) {
  // `present` flips to false the moment the router leaves this page;
  // AnimatePresence keeps it mounted until `safeToRemove` is called.
  const [present, safeToRemove] = usePresence();
  // The navigation this page belongs to. On the way OUT it is the one that
  // ejects it — AnimatePresence hands it down as `custom` (usePresenceData),
  // the supported channel for an exiting child — and the provider `App` fills
  // once per render answers the same for the page arriving. This component
  // never computes a direction itself: the page leaving is kept mounted under
  // a <Routes location={…}> that still names the route it came from, and
  // asking there answered for the wrong one (see usePageTransitionCustom.js).
  const presenceCustom = usePresenceData();
  const providerCustom = usePageTransitionCustomValue();
  const { direction, lateral } = presenceCustom ?? providerCustom;

  const rootRef = useRef(null);
  // The window scroll this page had, kept while it is present. Read at the
  // moment it leaves it would already be the value the browser restored on a
  // popstate, and a page that left at 800px would jump to its top for its
  // last 180ms.
  const scrollYRef = useRef(0);
  // The direction this page ARRIVED with: the reset below runs once, and
  // must not re-run when the context changes to the navigation that ejects it.
  const arrivalDirection = useRef(direction);
  // True once the arrival animation has ended: the page drops its motion
  // attribute, and with it the stacking context it needed while animating.
  const [settled, setSettled] = useState(false);

  const motion = present && settled ? 'rest' : pageMotionFor({ direction, lateral, present });

  // A new page starts at the top. It used to by accident: with the pages in
  // sequence the document emptied between exit and entrance and the scroll
  // clamped to 0. With both mounted it never empties, and an entity's scroll
  // would carry into the next. `instant`, because `html { scroll-behavior:
  // smooth }` would turn the reset into a visible glide.
  useLayoutEffect(() => {
    if (arrivalDirection.current !== 0) window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  // Track the scroll only while present. A layout effect so the listener is
  // gone in the mutation phase of the commit that ejects the page — before
  // the arriving page's reset above can fire a scroll event into it.
  useLayoutEffect(() => {
    if (!present) return undefined;
    const record = () => { scrollYRef.current = window.scrollY; };
    record();
    window.addEventListener('scroll', record, { passive: true });
    return () => window.removeEventListener('scroll', record);
  }, [present]);

  // Out of flow the same frame it stops being present: the stylesheet makes
  // a leaving page `position: fixed`, and this lifts it by the scroll it had,
  // so what was on screen stays on screen while it goes.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.style.top = present ? '' : `${-scrollYRef.current}px`;
  }, [present]);

  // The safety clock: a background tab or a cancelled animation never fires
  // `animationend`, and a page that never hands itself back is a page
  // AnimatePresence keeps forever. Cleared if the page becomes present again.
  useEffect(() => {
    if (present || !safeToRemove) return undefined;
    const timer = window.setTimeout(safeToRemove, EXIT_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [present, safeToRemove]);

  // The cards and the hero animate too, and their `animationend` bubbles up
  // here; only the root's own counts.
  const handleAnimationEnd = useCallback((event) => {
    if (event.target !== rootRef.current) return;
    if (present) setSettled(true);
    else if (safeToRemove) safeToRemove();
  }, [present, safeToRemove]);

  // `data-nav-direction` is for the page's own content: coming back (-1) is a
  // return to something that was there, so the feed's cards resume at rest
  // instead of arriving again (PaperCard.css reads this).
  return (
    <div
      ref={rootRef}
      className="page-transition"
      data-nav-direction={direction}
      data-page-motion={motion}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* A chunk that is not cached suspends HERE, inside the page arriving,
          so the fallback (delayed 320ms in RouteFallback.css) is drawn over
          this page alone while the one leaving stays on screen. */}
      <Suspense fallback={<RouteFallback />}>{children}</Suspense>
    </div>
  );
}
```

Dos avisos para quien lo transcribe: (1) no metas comentarios entre los atributos del `<div>`: el test casa la etiqueta entera; (2) `eslint-plugin-react-hooks` 7 prohíbe leer `ref.current` durante el render — aquí todas las lecturas están dentro de efectos o del manejador, y `useRef(direction)` con valor inicial es la forma permitida de fijar la dirección de llegada.

- [ ] **Step 4: `App.jsx`, el modo y sus dos comentarios**

En `src/App.jsx`, sustituye estas nueve líneas del comentario de cabecera (líneas 31–39):

```js
// React Router v7 navigations run inside startTransition, but that does not
// keep the current screen on while a chunk downloads here: `AnimatePresence
// mode="wait"` mounts the incoming screen from its own exit-complete callback,
// outside the transition, so a screen that suspends there commits the
// RouteFallback above the presence wrapper. The outgoing screen has finished
// leaving by then (measured: opacity 0 before the fallback ever commits), so
// nothing is cut; what a cold chunk costs is a gap between exit and entrance,
// kept invisible under 320 ms by the fallback's own delay. The screens are
// preloadable (`lazyWithPreload`) so the ones prefetched below never suspend at all.
```

por:

```js
// The router commits a navigation synchronously (`useTransitions={false}` in
// main.jsx), and `AnimatePresence mode="sync"` mounts the incoming screen in
// that same commit, beside the outgoing one. A screen whose chunk is cold
// suspends inside its own PageTransition's Suspense boundary, so the
// RouteFallback (delayed 320 ms by its stylesheet) is drawn within the page
// arriving while the page leaving stays on screen, held opaque underneath.
// The screens are preloadable (`lazyWithPreload`) so the ones prefetched
// below never suspend at all.
```

Y sustituye el comentario JSX más la línea de `AnimatePresence` (líneas 209–215):

```jsx
      {/* `custom` so the page on its way OUT resolves its exit against this
          navigation rather than the one that mounted it: AnimatePresence keeps
          the previous <Routes> element itself, so the outgoing PageTransition
          never re-renders and would otherwise leave in the direction, and on
          the clock, it arrived with. */}
      <PageTransitionCustomProvider value={pageTransitionCustom}>
      <AnimatePresence mode="wait" initial={false} custom={pageTransitionCustom}>
```

por:

```jsx
      {/* `mode="sync"`: the page leaving and the page arriving share the
          screen, the deeper one on top (PageTransition.css). `custom` so the
          page on its way OUT reads the navigation that ejects it
          (usePresenceData) rather than the one that mounted it: AnimatePresence
          keeps the previous <Routes> element itself. `initial={false}` keeps
          the motion elements inside the first page from replaying their
          `initial` on the app's first render. */}
      <PageTransitionCustomProvider value={pageTransitionCustom}>
      <AnimatePresence mode="sync" initial={false} custom={pageTransitionCustom}>
```

Nada más cambia en `App.jsx` en esta tarea. El `<Suspense fallback={<RouteFallback />}>` exterior (línea 208) se queda. El comentario de `src/utils/lazyPreload.test.js` que menciona `mode="wait"` es historia de por qué existe la precarga; no es un aserto y no se toca.

- [ ] **Step 5: Comprueba que pasa, y que lo que ya existía sigue pasando**

Run: `node --test src/components/Layout/pageTransition.test.js src/components/Explorer/explorerEntrance.test.js src/components/Feed/feedAtomVeil.test.js src/utils/tabDirection.test.js`
Expected: PASS todos. `explorerEntrance.test.js` sigue casando `data-nav-direction={direction}` en el fichero nuevo.

- [ ] **Step 6: Suite, lint y build**

Run: `npm test && npm run lint && npm run build`
Expected: todo verde, y `vite build` termina: resuelve `./PageTransition.css` desde el componente y lo incorpora al CSS del bundle principal.

- [ ] **Step 7: Commit**

```bash
git add src/components/Layout/PageTransition.jsx src/components/Layout/pageTransition.test.js src/App.jsx
git commit -m "feat(transición): las dos páginas de una navegación conviven, y la más profunda va encima

AnimatePresence pasa a sync y PageTransition deja de ser un motion.div:
un div con data-page-motion que la hoja de estilos anima por compositor.
Presencia por usePresence, la navegación que echa a la página por
usePresenceData, salida del flujo con fixed desde el render y levantada
por el scroll que tenía, scroll a cero al llegar, Suspense propio para el
chunk frío y reloj de seguridad para el animationend que no llega.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: La barra en `/explorer/*`, y la página de entidad debajo

**Files:**
- Modify: `src/App.jsx:121-128` (`showNavbar`) y `src/App.jsx:381-392` (ruta `/explorer/:type/:id`) — números de antes de la Tarea 3, que mueve una línea arriba y dos abajo; ancla por el texto citado, no por la línea
- Modify: `src/components/Explorer/EntityExplorer.jsx:216-221` (props), `:1290` (raíz del esqueleto), `:1440` (raíz del error), `:1477` (raíz viva)
- Modify: `src/components/Explorer/EntityExplorer.css:11-18` (tras `.explorer-container`) y `:2274-2278` (bloque `@media (max-width: 768px)`)
- Test: `src/components/Explorer/explorerAppChrome.test.js`

**Interfaces:**
- Consumes: `showNavbar` de `App.jsx` (ya existe).
- Produces: prop `appChrome: boolean` en `EntityExplorer` (por defecto `false`); clase `explorer--app`. Nada posterior depende de ello.

- [ ] **Step 1: Escribe el test de fuente**

`src/components/Explorer/explorerAppChrome.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/**
 * SOURCE tests: the entity pages keep the app bar for a signed-in reader,
 * and sit below it (spec §4 of
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 * Measured before this (signed in, feed → author): the bar unmounted in the
 * frame after the tap — `/explorer/*` was not a navbar route — and left an
 * empty band over the card while it dissolved.
 */
test('the bar stays up on an entity page, and the page is told by the one place that decides', async () => {
  const app = await read('../../App.jsx');
  const rule = app.match(/const showNavbar = \(navbarRoutes\.includes\(normalizedPathname\)([\s\S]*?)\)\s*&& Boolean\(user\)/);
  assert.ok(rule, 'showNavbar is the one place that decides');
  assert.match(rule[1], /\|\| normalizedPathname\.startsWith\('\/explorer\/'\)/);
  const route = app.match(/path="\/explorer\/:type\/:id"[\s\S]*?<\/PageTransition>/);
  assert.ok(route, 'the explorer route');
  assert.match(route[0], /<EntityExplorer\s+appChrome=\{showNavbar\}\s+publicMode=\{!user\}/);
  const publicRoute = app.match(/path="\/public\/entity\/:type\/:id"[\s\S]*?<\/PageTransition>/);
  assert.ok(publicRoute, 'the public entity route');
  assert.doesNotMatch(publicRoute[0], /appChrome/, 'the shared-link page keeps its standalone top edge');
});

test('every root the explorer can return carries the modifier, from one prop', async () => {
  const jsx = await read('./EntityExplorer.jsx');
  assert.match(jsx, /export default function EntityExplorer\(\{[\s\S]*?appChrome = false,[\s\S]*?\}\) \{/);
  assert.match(jsx, /const appChromeClass = appChrome \? ' explorer--app' : '';/);
  assert.equal((jsx.match(/\$\{appChromeClass\}/g) || []).length, 3, 'skeleton, error and live page');
  assert.match(jsx, /className=\{`explorer-container explorer-skeleton explorer-skeleton--\$\{type \|\| 'entity'\}\$\{appChromeClass\}`\}/);
  assert.match(jsx, /className=\{`explorer-error\$\{appChromeClass\}`\}/);
  assert.match(jsx, /className=\{`explorer-container\$\{appChromeClass\}`\} style=\{\{ '--area-accent': entityAccent \}\}/);
});

test('below the bar: the page starts under it, the toolbar docks under it, the hero stops reserving the notch', async () => {
  const css = await read('./EntityExplorer.css');
  assert.match(css, /\.explorer--app \{\s*padding-top: var\(--nav-total\);\s*\}/);
  assert.match(css, /\.explorer--app \.explorer-hero \{\s*padding-top: var\(--space-5\);\s*\}/);
  assert.match(css, /\.explorer--app \.explorer-toolbar-wrapper \{\s*top: var\(--nav-total\);\s*\}/);
  const mobile = css.match(/@media \(max-width: 768px\) \{\s*\.explorer-hero \{[\s\S]*?\n\}/);
  assert.ok(mobile, 'the 768px block that re-pads the hero');
  assert.match(mobile[0], /\.explorer--app \.explorer-hero \{\s*padding-top: var\(--space-4\);\s*\}/);
  // The standalone page keeps its own top edge: the base rules are untouched.
  assert.match(css, /\.explorer-hero \{[^}]*padding-top: max\(var\(--space-5\), env\(safe-area-inset-top\)\);/);
  assert.match(css, /\.explorer-toolbar-wrapper \{\s*position: sticky;\s*top: 0;/);
});
```

- [ ] **Step 2: Comprueba que falla**

Run: `node --test src/components/Explorer/explorerAppChrome.test.js`
Expected: FAIL los tres tests.

- [ ] **Step 3: `App.jsx`, la decisión y la prop**

Sustituye el comentario y la condición de `showNavbar` (líneas 121–128 antes de la Tarea 3):

```js
  // The paper, profile and list pages keep the app chrome for a signed-in user —
  // reaching a paper from Liked, a profile from the follow sheet, or a list from
  // someone's shared link, must not feel like leaving the app. Signed-out
  // visitors on a shared link still get the standalone page (`user` gates below).
  const showNavbar = (navbarRoutes.includes(normalizedPathname)
    || normalizedPathname.startsWith('/public/paper/')
    || normalizedPathname.startsWith('/public/user/')
    || normalizedPathname.startsWith('/public/list/'))
```

por:

```js
  // The paper, profile, list and entity pages keep the app chrome for a
  // signed-in user — reaching a paper from Liked, a profile from the follow
  // sheet, a list from someone's shared link, or an author from a card, must
  // not feel like leaving the app. Measured before the entity pages joined:
  // the bar unmounted in the frame after the tap and left an empty band over
  // the card while it dissolved. Signed-out visitors still get the standalone
  // page (`user` gates below).
  const showNavbar = (navbarRoutes.includes(normalizedPathname)
    || normalizedPathname.startsWith('/public/paper/')
    || normalizedPathname.startsWith('/public/user/')
    || normalizedPathname.startsWith('/public/list/')
    || normalizedPathname.startsWith('/explorer/'))
```

Las cuatro guardas que siguen (`&& Boolean(user)` …) no cambian. En la ruta `path="/explorer/:type/:id"` — la primera de las dos rutas que montan `EntityExplorer`; la de `/public/entity/:type/:id` no se toca — añade la prop como primera línea del elemento:

```jsx
              <PageTransition>
                <EntityExplorer
                  appChrome={showNavbar}
                  publicMode={!user}
                  onAuthRequired={requestAuthentication}
                  onSaveToList={user ? setSaveModalPaper : requestAuthentication}
                />
              </PageTransition>
```

- [ ] **Step 4: `EntityExplorer.jsx`, la prop y las tres raíces**

Firma (líneas 216–220):

```jsx
export default function EntityExplorer({
  onSaveToList = () => {},
  publicMode = false,
  onAuthRequired = () => {},
  // Under the app's own bar — App.jsx decides, the same way it decides to
  // render the bar — the page starts below it instead of at the top edge.
  appChrome = false,
}) {
  const { type, id } = useParams();
  const appChromeClass = appChrome ? ' explorer--app' : '';
```

(la línea `const appChromeClass …` va justo después de `const { type, id } = useParams();`, que ya existe). Después, las tres raíces:

Esqueleto (línea 1290):

```jsx
        className={`explorer-container explorer-skeleton explorer-skeleton--${type || 'entity'}${appChromeClass}`}
```

Error (línea 1440):

```jsx
      <div className={`explorer-error${appChromeClass}`}>
```

Página viva (línea 1477):

```jsx
    <div className={`explorer-container${appChromeClass}`} style={{ '--area-accent': entityAccent }}>
```

- [ ] **Step 5: `EntityExplorer.css`, las reglas bajo la barra**

Justo después del bloque `.explorer-container { … }` (líneas 11–18) y antes de `.explorer-error {`, añade:

```css
/* Under the app's own bar (App.jsx passes `appChrome` for a signed-in
   reader, the same condition that renders the bar): the page starts below
   it, the sticky toolbar docks under it, and the hero stops reserving the
   notch, which the bar already covers. Border-box, so `min-height: 100dvh`
   and the error's `height: 100dvh` keep meaning the whole screen with the
   padding inside them. Without the bar nothing here applies. */
.explorer--app {
  padding-top: var(--nav-total);
}

.explorer--app .explorer-hero {
  padding-top: var(--space-5);
}

.explorer--app .explorer-toolbar-wrapper {
  top: var(--nav-total);
}
```

Y dentro del bloque `@media (max-width: 768px) {` de la línea 2274, inmediatamente después de su regla `.explorer-hero { … }` (que termina en la línea 2278) y antes de `.ehc-title-row {`:

```css
  .explorer--app .explorer-hero {
    padding-top: var(--space-4);
  }
```

- [ ] **Step 6: Comprueba que pasa**

Run: `node --test src/components/Explorer/explorerAppChrome.test.js src/components/Explorer/explorerEntrance.test.js src/components/Explorer/explorerLoading.test.js`
Expected: PASS todos.

- [ ] **Step 7: Suite y lint completos**

Run: `npm test && npm run lint`
Expected: todo verde.

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css src/components/Explorer/explorerAppChrome.test.js
git commit -m "feat(explorer): la barra se queda al abrir un autor, un tema, una institución o un proyecto

Como en paper, perfil y lista: abrir una entidad desde una tarjeta no
debe sentirse como salir de la app. App decide y se lo dice a la página
por una prop; debajo de la barra el relleno, la barra de pestañas
pegajosa y el héroe sin reservar la muesca. El invitado sigue sin barra.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: El guion de medida (`page-transition-frames.mjs`)

**Files:**
- Create: `scripts/diagnostics/page-transition-frames.mjs`
- Modify: `scripts/diagnostics/README.md` (nueva sección al final)

**Interfaces:**
- Consumes: nada del código de la app; solo el DOM que produce (`.navbar`, `#main-content > *`, `data-page-motion`).
- Produces: el guion que la Tarea 6 ejecuta, con su línea de resumen `sampler: … bar in N/N; void N; overlap N; settled at N ms`.

`scripts/diagnostics/**` está fuera de ESLint (`eslint.config.js`), así que aquí no hay test: la comprobación es `node --check` y una ejecución real en la Tarea 6.

- [ ] **Step 1: Escribe el guion**

`scripts/diagnostics/page-transition-frames.mjs`:

```js
// Frame-by-frame record of ONE route transition — a card to an entity page,
// the entity back to the feed, a tab to the next — for the before/after of
// docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md.
//
//   node scripts/diagnostics/page-transition-frames.mjs '<css selector>' <label> [demo] [mobile] [back] [idx=N] [scroll=N]
//
// Loads ORIGIN (default http://localhost:5174) at `#/`, waits for the selector
// and the 4.5 s the explorer chunk prefetch needs, then records around ONE
// navigation: the click on the selector, or — with `back` — `history.back()`
// 1.8 s after that click. Two records of the same second:
//
//   * every compositor frame as a JPEG (Page.startScreencast), to
//     <label>-frames/, plus a contact sheet of up to 24 of them,
//     <label>-sheet.png, rendered by the same headless Chrome;
//   * a requestAnimationFrame sampler installed in the page, which notes per
//     frame whether `.navbar` exists and, for each `#main-content > *` (the
//     route pages), its data-page-motion, computed opacity, transform and
//     position — written to <label>-samples.json. From it the script prints:
//     frames with the bar, frames with no page at ≥ 0.98 opacity ("void"),
//     frames with two pages (overlap), and the first frame after which one
//     page stands alone at rest ("settled"). A main thread busy mounting a
//     page skips rAF ticks, so the sampler counts frames the page produced,
//     not wall-clock milliseconds.
//
// `demo` seeds a signed-in demo session in localStorage before the first
// script: build with IS_DEMO = true in src/services/firebase.js for it, and
// put it back to false before committing anything. `mobile` is 390×844 at 2x
// with touch emulation. `idx=N` clicks the Nth match; `scroll=N` (with `back`)
// scrolls the page it opened N px down before the way back, so the leaving
// page's lift by its own scroll (`top` in the samples) is on record. PORT=9232 picks another
// debugging port; OUT=<dir> another output directory. No dependencies; Node
// ≥ 22 for the global WebSocket.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9231);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const OUT = process.env.OUT || process.cwd();
const PROFILE = join(tmpdir(), `papertok-page-transition-${process.pid}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , sel, label = 'run', ...rest] = process.argv;
if (!sel) {
  console.error("usage: page-transition-frames.mjs '<css selector>' <label> [demo] [mobile] [back] [idx=N] [scroll=N]");
  process.exit(2);
}
const flags = new Set(rest);
const idx = Number(([...flags].find((f) => f.startsWith('idx=')) || 'idx=0').slice(4));
const mobile = flags.has('mobile');
const demo = flags.has('demo');
const back = flags.has('back');
const scrollPx = Number(([...flags].find((f) => f.startsWith('scroll=')) || 'scroll=0').slice(7));

const DEMO_SEED = `(() => { try {
  localStorage.setItem('papertok_user', JSON.stringify({ uid: 'demo-user-123', displayName: 'Demo User', email: 'demo@papertok.app', photoURL: '', providerData: [{ providerId: 'google.com' }] }));
  localStorage.setItem('papertok_onboardingComplete', 'true');
  localStorage.setItem('papertok_selectedCategories', JSON.stringify(['bio.neuro', 'physics']));
} catch {} })();`;

// Installed in the page the same tick the navigation is triggered, so t=0 is
// the tap. Samples for 1.4 s, well past every duration in PageTransition.css.
const SAMPLER = `(() => {
  const samples = [];
  const start = performance.now();
  const tick = () => {
    const pages = [...document.querySelectorAll('#main-content > *')].map((el) => {
      const cs = getComputedStyle(el);
      return { motion: el.dataset.pageMotion || null, opacity: Number(cs.opacity), transform: cs.transform, position: cs.position, top: el.style.top || null };
    });
    samples.push({ t: Math.round(performance.now() - start), navbar: Boolean(document.querySelector('.navbar')), pages });
    if (performance.now() - start < 1400) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__ptSamples = samples;
})();`;

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

async function pageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('no page target');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      } else (this.listeners.get(m.method) || []).forEach((fn) => fn(m.params));
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
    return r.result.value;
  }
}

function summarise(samples) {
  const total = samples.length;
  const withBar = samples.filter((s) => s.navbar).length;
  const voidFrames = samples.filter((s) => !s.pages.some((p) => p.opacity >= 0.98));
  const overlap = samples.filter((s) => s.pages.length >= 2).length;
  const atRest = (s) => s.pages.length === 1
    && (s.pages[0].motion === null || s.pages[0].motion === 'rest')
    && s.pages[0].opacity >= 0.99 && s.pages[0].transform === 'none';
  let moved = false;
  let settled = null;
  for (const s of samples) {
    if (!atRest(s)) moved = true;
    else if (moved && settled === null) settled = s.t;
  }
  return `sampler: ${total} frames; bar in ${withBar}/${total}; void ${voidFrames.length} (${voidFrames.map((s) => `${s.t}ms`).join(' ') || '-'}); overlap ${overlap}; settled at ${settled === null ? 'never within the window' : `${settled} ms`}`;
}

try {
  const ws = new WebSocket(await pageTarget());
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  if (demo) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DEMO_SEED });
  await cdp.send('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/` });
  let ready = false;
  for (let i = 0; i < 400; i++) {
    if (await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length > ${idx}`).catch(() => false)) { ready = true; break; }
    await sleep(100);
  }
  console.log('target ready:', ready);
  if (!ready) throw new Error(`no element matches ${sel} (index ${idx}) within 40 s`);
  await sleep(4500); // past the explorer chunk prefetch, so the transition is the warm case
  const clickExpr = `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const t = (el.textContent || '').trim().slice(0, 40); el.click(); return t; })()`;
  if (back) {
    console.log('opened:', await cdp.eval(clickExpr));
    await sleep(1800); // the page it opened is still by now; the record is the way back
    if (scrollPx) {
      // A scroll event only reaches the page's listener on a rendered frame:
      // give it a few before the way back.
      await cdp.eval(`window.scrollTo({ top: ${scrollPx}, behavior: 'instant' })`);
      await sleep(300);
      console.log('scrolled to:', await cdp.eval('window.scrollY'));
    }
  }
  const frames = [];
  cdp.on('Page.screencastFrame', (p) => {
    frames.push({ ts: p.metadata.timestamp, data: p.data });
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: mobile ? 390 : 800, maxHeight: mobile ? 844 : 562, everyNthFrame: 1 });
  await sleep(400);
  const t0 = Date.now() / 1000;
  const target = await cdp.eval(back ? `${SAMPLER} history.back(); 'back'` : `${SAMPLER} ${clickExpr}`);
  console.log(back ? 'went back' : `clicked: ${target}`);
  await sleep(1500);
  await cdp.send('Page.stopScreencast');
  const samples = await cdp.eval('window.__ptSamples');

  const kept = frames.filter((f) => f.ts >= t0 - 0.05);
  const dir = join(OUT, `${label}-frames`);
  mkdirSync(dir, { recursive: true });
  const rel = kept.map((f) => ({ t: Math.round((f.ts - t0) * 1000), data: f.data }));
  rel.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(3, '0')}_${f.t}ms.jpg`), Buffer.from(f.data, 'base64')));
  writeFileSync(join(OUT, `${label}-samples.json`), JSON.stringify(samples, null, 1));
  console.log(`frames kept: ${rel.length} (of ${frames.length}), t = ${rel[0]?.t}..${rel[rel.length - 1]?.t} ms`);
  console.log('frame times (ms):', rel.map((f) => f.t).join(' '));
  console.log(summarise(samples));

  // Contact sheet: up to 24 frames, evenly spaced, rendered by the same Chrome.
  const pick = rel.length <= 24 ? rel : Array.from({ length: 24 }, (_, i) => rel[Math.round(i * (rel.length - 1) / 23)]);
  const w = mobile ? 195 : 320;
  const html = `<!doctype html><meta charset=utf-8><style>body{margin:0;background:#222;font:12px monospace;color:#eee}div.g{display:grid;grid-template-columns:repeat(6,${w}px);gap:6px;padding:8px}figure{margin:0}img{width:${w}px;display:block;border:1px solid #555}figcaption{text-align:center;padding:2px}</style><div class=g>${pick.map((f) => `<figure><img src="data:image/jpeg;base64,${f.data}"><figcaption>${f.t} ms</figcaption></figure>`).join('')}</div>`;
  const sheetPath = join(OUT, `${label}-sheet.html`);
  writeFileSync(sheetPath, html);
  await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  const rows = Math.ceil(pick.length / 6);
  const rowH = mobile ? 422 + 22 : 180 + 22;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 6 * (w + 6) + 16, height: rows * rowH + 16, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `file://${sheetPath}` });
  await sleep(1200);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${label}-sheet.png`), Buffer.from(shot.data, 'base64'));
  console.log('sheet:', join(OUT, `${label}-sheet.png`));
} finally {
  chrome.kill('SIGKILL');
  await sleep(400);
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}
```

- [ ] **Step 2: Comprueba la sintaxis y el uso**

Run: `node --check scripts/diagnostics/page-transition-frames.mjs && node scripts/diagnostics/page-transition-frames.mjs; echo "exit $?"`
Expected: sin errores de sintaxis; sin argumentos imprime la línea `usage:` y sale con `exit 2`.

- [ ] **Step 3: La entrada del README**

Al final de `scripts/diagnostics/README.md` añade (la valla exterior de cuatro acentos es solo para que este plan la muestre; en el README va tal cual, con su bloque `bash` de tres):

````markdown
## `page-transition-frames.mjs` — a route transition, frame by frame (2026-09-06)

The before/after of `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md`:
the feed's card giving way to an entity page, the way back, a tab to the next.
Every compositor frame of the second around ONE navigation as a JPEG plus a
contact sheet, and a `requestAnimationFrame` sampler installed in the page the
same tick the navigation fires, which notes per frame whether `.navbar` exists
and each route page's `data-page-motion`, opacity, transform and position.

```bash
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' author-desktop demo
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' author-mobile demo mobile
node scripts/diagnostics/page-transition-frames.mjs '.pc-topic-link' topic-desktop demo
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' back-desktop demo back
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' back-scrolled-desktop demo back scroll=600
node scripts/diagnostics/page-transition-frames.mjs 'a[href="#/research"]' tab-desktop demo
```

The summary line reads `sampler: 71 frames; bar in 71/71; void 0 (-); overlap 14;
settled at 236 ms`: frames the page produced with the bar mounted, frames with
no page at ≥ 0.98 opacity (the old `mode="wait"` handover had two), frames with
two route pages on screen, and the first frame after which one page stands
alone at rest. `back` clicks the selector first, waits 1.8 s, and records
`history.back()`; `scroll=<px>` with it scrolls the page it opened first, so the
leaving page's lift by its own scroll (`top` in the samples) is on record. `demo`
needs `IS_DEMO = true` flipped locally (never
committed) and a server on a Worker-allowed origin (5173/5174/5175;
`ORIGIN=http://localhost:5175` to pick another). `OUT=<dir>` keeps the frames,
samples and sheets out of the tree.
````

- [ ] **Step 4: Commit**

```bash
git add scripts/diagnostics/page-transition-frames.mjs scripts/diagnostics/README.md
git commit -m "chore(diagnostics): una transición de ruta fotograma a fotograma, con muestreo por rAF

Screencast por CDP y un muestreador dentro de la página que anota por
fotograma la barra, y cada página de ruta con su movimiento, opacidad y
transform: cuenta fotogramas con barra, vacíos, solapados y el momento en
que la página nueva queda quieta.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Medir, y escribir el «Después»

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md` (nueva sección `## 11. Después` al final)
- Toca y deshace: `src/services/firebase.js` (solo en el árbol de trabajo, nunca en un commit)

**Interfaces:**
- Consumes: el guion de la Tarea 5 y el código de las tareas 1–4 ya construido.
- Produces: las cifras del «Después» y siete hojas de contactos para la revisión final.

Puerto: el guion espera `http://localhost:5174`. 5173 y 5175 pertenecen a otras sesiones en esta máquina: si 5174 está ocupado (`lsof -nP -iTCP:5174 -sTCP:LISTEN`), no mates nada; para y dilo en el informe.

- [ ] **Step 1: Un build de demo, y la bandera de vuelta a su sitio**

```bash
sed -i '' 's/^export const IS_DEMO = false;$/export const IS_DEMO = true;/' src/services/firebase.js
grep -n "export const IS_DEMO = true;" src/services/firebase.js
npm run build
git checkout -- src/services/firebase.js
git diff --exit-code src/services/firebase.js && echo "firebase.js limpio"
```

Expected: el `grep` imprime la línea 6; el build termina; la última línea dice `firebase.js limpio`. El `dist/` resultante es de demo y no se commitea (está ignorado).

- [ ] **Step 2: Sirve el build**

En segundo plano (herramienta Bash con `run_in_background`), desde la raíz del worktree:

```bash
npx vite preview --port 5174 --strictPort
```

Luego comprueba que responde:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5174/
```

Expected: `200`.

- [ ] **Step 3: Las siete capturas**

```bash
mkdir -p .superpowers/measure-transicion
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' after-author-desktop demo
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' after-author-mobile demo mobile
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-topic-link' after-topic-desktop demo
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' after-back-desktop demo back
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' after-back-mobile demo mobile back
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs 'a[href="#/research"]' after-tab-desktop demo
OUT=.superpowers/measure-transicion node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' after-back-scrolled-desktop demo back scroll=600
```

Expected por cada una: `target ready: true`, la línea `frame times`, la línea `sampler: …` y la ruta de la hoja (la séptima imprime además `scrolled to: 600`). Copia las siete líneas `sampler:` al informe tal cual. Si `.pc-author-link` no existe en la primera tarjeta del feed de demo (una tarjeta sin autores enlazables), usa `idx=1` o `idx=2` y anótalo.

- [ ] **Step 4: Mira las hojas**

Abre con la herramienta Read cada `.superpowers/measure-transicion/after-*-sheet.png` y anota, por escenario: si la barra está en todos los fotogramas, si hay algún fotograma sin página, si el feed se mueve durante la ida (no debe), si al volver las tarjetas están en reposo, si en la vuelta con scroll la página saliente sigue mostrando la zona que veía (en `after-back-scrolled-desktop-samples.json` sus muestras llevan `top: "-600px"`) o salta a su cabecera, y cualquier cosa que las cifras no cuenten (un escalón del héroe, un salto de la página saliente al volver, un aviso de analítica). Guarda esas notas para el informe y para la sección de abajo.

- [ ] **Step 5: Escribe el «Después» en el spec**

Al final de `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md` añade esta sección, con las cifras de las líneas `sampler:` y las notas del paso 4 en lugar de los `n`:

```markdown
## 11. Después (medido el 2026-09-06)

Con `scripts/diagnostics/page-transition-frames.mjs`, build de demo local, chunk caliente, muestreo por `requestAnimationFrame` y screencast por CDP. Las hojas de contactos y las muestras quedan en `.superpowers/measure-transicion/` de la sesión que lo midió (ignorado, no se commitea).

| Escenario | Fotogramas con barra | Fotogramas vacíos | Fotogramas con dos páginas | Quieta a los |
| --- | --- | --- | --- | --- |
| Tarjeta → autor, escritorio | n/n | n | n | n ms |
| Tarjeta → autor, móvil | n/n | n | n | n ms |
| Tarjeta → tema, escritorio | n/n | n | n | n ms |
| Autor → volver, escritorio | n/n | n | n | n ms |
| Autor → volver, móvil | n/n | n | n | n ms |
| Autor a 600 px → volver, escritorio | n/n | n | n | n ms |
| For you → Research, escritorio | n/n | n | n | n ms |

Frente a los criterios de §9: barra en todos los fotogramas (cumplido o no, con la cifra); cero fotogramas vacíos (cumplido o no); entidad quieta antes de 260 ms (cifra por escenario); feed retenido sin moverse durante la ida (lo que se ve en la hoja); tarjetas en reposo al volver (lo que se ve en la hoja); pestaña sin hueco (cifra).

Lo que las hojas enseñan y las cifras no: (dos o tres frases con lo anotado en el paso 4, incluidos los riesgos de §10 que se hayan visto o no).
```

Nada de la tabla se deja en `n`: cada celda lleva su cifra o, si un escenario no pudo medirse, la palabra «no medido» y el porqué.

- [ ] **Step 6: Para el servidor y comprueba el árbol**

Mata el proceso de `vite preview` que arrancaste en el paso 2 (por el id de la tarea en segundo plano, o `kill` del PID que muestre `lsof -nP -iTCP:5174 -sTCP:LISTEN`). Después:

```bash
git diff --exit-code src/services/firebase.js && echo "firebase.js limpio"
git status --short
```

Expected: `firebase.js limpio`, y en `git status` solo el spec modificado (el directorio `.superpowers/` está ignorado; `dist/` también).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md
git commit -m "docs(spec): el «Después» de la transición tarjeta → entidad, medido

Seis escenarios con sesión, en móvil y escritorio, por rAF y screencast:
fotogramas con barra, vacíos, solapados y momento en que la página queda
quieta, frente a los criterios de aceptación.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
