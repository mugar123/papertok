# Vuelta al feed desde Research y cambio de pestaña — plan de arreglo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quitar la «segunda llegada» de los recortes al volver al feed, el cierre en blanco del overlay de Research, y hacer que el cambio entre pestañas (For you ↔ Research ↔ Following) sea un relevo lateral en vez de un fundido con doble exposición.

**Architecture:** Tres frentes independientes. (A) El feed siembra los recortes desde la caché en el primer fotograma y, en una vuelta lateral, los deja en reposo como al resto de la tarjeta. (B) El overlay conserva el paper mientras se va. (C) La transición lateral mueve las dos páginas en el mismo eje, y Research llega con su héroe ya en pantalla cuando el informe está en caché.

**Tech Stack:** React 19, react-router (HashRouter, `useTransitions={false}`), framer-motion sólo como contable de presencia, CSS keyframes en `PageTransition.css` y `PaperCard.css`, Base UI Dialog, tests con `node --test` sobre el texto fuente (convención de `paperCardFigureEntrance.test.js`).

**Spec:** Este documento es auditoría y plan a la vez; la evidencia está en la sección «Auditoría». Sonda reproducible: `docs/superpowers/plans/2026-09-11-glitch-vuelta-feed-sonda.mjs`.

## Global Constraints

- No comparar hashes de bundle para verificar; medir con la sonda (Chrome headless por CDP, perfil `~/.papertok-probe-profile`, origen `http://localhost:5174`, **build de producción** con `npx vite preview --port 5174`; el dev server hincha los tiempos, ver memoria «el congelado del clic era jsxDEV»).
- Cada arreglo de animación se mide ANTES y DESPUÉS con la misma sonda; sin control sobre el código anterior no hay prueba.
- Los tests de fuente despojan comentarios antes de buscar (convención ce139ce); un comentario que cite una clase revive esa clase en Tailwind.
- `IS_DEMO` nunca se commitea. `git diff` antes de cada commit.

---

## Auditoría (medida el 2026-09-11, build de producción, sesión real, 1280×900 headless)

Secuencia del usuario: For you → Research → «Ver detalle» (overlay con la tarjeta) → Volver → For you.

**Hallazgo 1 — al volver al feed, los recortes llegan después de que la página ya está en reposo.**
Línea de tiempo desde el clic en «For you» (sonda `pov`, prod):

| t | qué pasa |
|---|---|
| 29 ms | feed montado con 1 tarjeta en la posición reanudada (`scrollTop` 757), sin `.pc-figure` |
| 233 ms | transición lateral acabada, página en `rest`; margen de la tarjeta vacío, sólo el glifo de área |
| 286 ms | aparecen los 4 `.pc-figure`, ya con `is-loaded` e `img.complete` (caché); arrancan `figureClipIn` ×4 (620–1040 ms, con retén del 20 %) y el fundido del glifo |
| ~400–1300 ms | los recortes van cayendo uno a uno sobre una tarjeta que ya no se movía |

Sin petición de red durante la vuelta: las figuras estaban en `figureCache` (`src/services/paperFigureService.js:15`). El retraso es de código: `figures` nace vacío (`PaperCard.jsx:334`), la carga espera a `isCardSettled`, que es un `setTimeout` de 240 ms tras el 15 % de visibilidad (`PaperCard.jsx:366-374`, `ENRICHMENT_SETTLE_DELAY_MS`), y sólo entonces `getPaperFigures` (asíncrona aunque acierte en caché) hace `setFigures`. Con 41cd627 (hoy) la entrada se re-arma en cada montaje, así que lo que antes «aparecía sin más» ahora aparece **y** se anima, 50–400 ms después del reposo. **Se reproduce igual sin abrir el overlay** (sonda `control`/`pfeed`): la causa es la vuelta al feed, no Research.

**Hallazgo 2 — el cierre del overlay se va en blanco.** `ScientificReport.jsx:884` renderiza `{selectedPaper && <PaperCard …/>}`; `closeOverlay` pone `selectedPaper` a null y la tarjeta desaparece en el mismo commit, mientras el Dialog sigue 200 ms reproduciendo `fadeOut` + `paperOverlaySurfaceOut` sobre una superficie vacía (fotograma a 49 ms: sólo el fondo). Mismo patrón en `EntityExplorer.jsx:2594` y `SearchPage.jsx:1391`.

**Hallazgo 3 — el cambio de pestaña es un fundido de 10 px / 180 ms con doble exposición.** `pageEnterFromRight/Left` (`PageTransition.css:129-137`) desplazan 10 px y suben la opacidad de 0; la retenida hace `pageHold` (escala 0,98 + opacidad 0,6), que es el lenguaje del «push» vertical. A 78 ms se ven la tarjeta del feed y el título «Research» superpuestos. Nada se mueve en horizontal de verdad.

**Hallazgo 4 — Research llega vacía y el héroe salta.** For you → Research: página en reposo a 275 ms; el héroe aparece de golpe a ~311 ms (sustituye a `LeadStorySkeleton`), y las cifras de la barra lateral cambian entre 410 y 894 ms. Al entrar se disparan 14 peticiones (openalex ×8, `/report/trends` ×3, arxiv) **en cada visita**: no hay caché de sesión del informe.

**Hallazgo 5 — Following → Research empieza 170 ms tarde.** Long task de 168 ms desde el clic; el primer fotograma de la transición es el 170. Following tenía 60 tarjetas montadas (`FeedContainer` con `scrollKey="following"`: la ventana progresiva crece hasta cubrir todos los papers, `mountWindowCovers`), y el commit de navegación se hace síncrono (`useTransitions={false}`). No está aislado si el coste es el montaje de Research o el re-render de las 60 tarjetas: la tarea 7 lo mide antes de tocar.

Lo que NO es: no queda bloqueo de scroll de Base UI (`body.style` vacío tras cerrar), no queda `aria-modal`, la transición de vuelta mide igual con y sin overlay, y la posición del feed se reanuda bien.

---

### Task 0: La sonda entra en el repo

**Files:**
- Move: `docs/superpowers/plans/2026-09-11-glitch-vuelta-feed-sonda.mjs` → `scripts/diagnostics/feed-return-figures-probe.mjs`

- [ ] **Step 1: Mover y documentar**

```bash
git mv docs/superpowers/plans/2026-09-11-glitch-vuelta-feed-sonda.mjs scripts/diagnostics/feed-return-figures-probe.mjs
```
Añadir en `scripts/diagnostics/README.md` una entrada: `node scripts/diagnostics/feed-return-figures-probe.mjs <label> [overlay] [back] [first] [from=following]` — graba fotogramas y muestras por rAF (páginas, `.pc-figure` con estado `L`oaded/`c`omplete/`s`rc, long tasks) alrededor de la vuelta al feed; `first` graba además la ida a Research; requiere build de producción en :5174 y el perfil de sondas.

- [ ] **Step 2: Línea base** — `npm run build && npx vite preview --port 5174 --strictPort &`, luego `node scripts/diagnostics/feed-return-figures-probe.mjs base overlay` y `… base-first first`, y guardar los `*-samples.json` fuera del repo. Esperado: figs=[] hasta ≥ 280 ms tras el clic, `figAnims` 9 después.

- [ ] **Step 3: Commit** — `git add scripts/diagnostics && git commit -m "chore(diagnostics): sonda de la vuelta al feed y de las pestañas"`

### Task 1: Mirar la caché de figuras sin esperar

**Files:**
- Modify: `src/services/paperFigureService.js:66`
- Test: `src/services/paperFigureService.test.js` (crear)

**Interfaces:**
- Produces: `export function peekPaperFigures(paper): Array | null` — el array cacheado (puede ser `[]`) o `null` si no hay entrada.

- [ ] **Step 1: Test que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('peekPaperFigures lee figureCache de forma síncrona y devuelve null si no hay entrada', async () => {
  const src = strip(await read('./paperFigureService.js'));
  assert.match(src, /export function peekPaperFigures\(paper\)/);
  const body = src.slice(src.indexOf('export function peekPaperFigures'));
  assert.match(body.slice(0, 400), /figureCache\.has\(arxivId\)\s*\?\s*figureCache\.get\(arxivId\)\s*:\s*null/);
  assert.doesNotMatch(body.slice(0, 400), /async|await|then\(/);
});
```

- [ ] **Step 2: Correr** — `node --test src/services/paperFigureService.test.js` → FAIL (no existe el export).

- [ ] **Step 3: Implementar** (antes de `getPaperFigures`)

```js
export function peekPaperFigures(paper) {
  const arxivId = normalizeArxivFigureId(paper);
  if (!arxivId) return null;
  return figureCache.has(arxivId) ? figureCache.get(arxivId) : null;
}
```

- [ ] **Step 4: Correr** → PASS. `npm test` entero también verde.
- [ ] **Step 5: Commit** — `git commit -am "feat(figures): peekPaperFigures mira la caché sin esperar"`

### Task 2: La tarjeta nace con sus recortes si ya los tenía

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:334` (estado) y `:466-474` (efecto)
- Test: `src/components/Feed/paperCardFigureEntrance.test.js` (añadir caso)

**Interfaces:**
- Consumes: `peekPaperFigures` de la tarea 1.

- [ ] **Step 1: Test que falla** (misma convención de lectura despojada que el fichero ya usa)

```js
test('la tarjeta siembra `figures` desde la caché en el primer render y no espera al settle para lo cacheado', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  assert.match(src, /useState\(\(\) => peekPaperFigures\(paper\)\?\.slice\(0, 4\) \?\? \[\]\)/);
  assert.match(src, /setFigures\(peekPaperFigures\(paper\)\?\.slice\(0, 4\) \?\? \[\]\)/); // reseed al cambiar paperViewKey
  assert.match(src, /if \(!isCardSettled \|\| figures\.length > 0\) return/);
});
```

- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar**

```js
import { getPaperFigures, peekPaperFigures } from '../../services/paperFigureService';
// …
const [figures, setFigures] = useState(() => peekPaperFigures(paper)?.slice(0, 4) ?? []);
// Un paper nuevo en la misma tarjeta: lo que haya en caché, o vacío hasta que llegue.
useEffect(() => { setFigures(peekPaperFigures(paper)?.slice(0, 4) ?? []); }, [paperViewKey]);

useEffect(() => {
  let active = true;
  if (!isCardSettled || figures.length > 0) return () => { active = false; };
  getPaperFigures(paper).then(found => {
    if (active && found.length > 0) setFigures(found.slice(0, 4));
  });
  return () => { active = false; };
}, [isCardSettled, paper, figures.length]);
```
Cuidado: el `useEffect` de reseed debe ir ANTES del de carga y no debe borrar `figures` en el montaje inicial (el `paperViewKey` no cambia, así que no corre: React sólo lo ejecuta en montaje una vez — y en montaje repite el mismo valor sembrado, sin parpadeo).

- [ ] **Step 4: Correr** `node --test src/components/Feed/paperCardFigureEntrance.test.js` → PASS; `npm test` verde.
- [ ] **Step 5: Medir** — build + sonda `t2 overlay`. Esperado: `figs=[Lcs ×4]` en la PRIMERA muestra (~25 ms), `figureClipIn` corriendo mientras la página aún está en `enter-lateral`. Pegar la tabla en el mensaje del commit.
- [ ] **Step 6: Commit** — `git commit -am "fix(feed): los recortes cacheados están en el primer fotograma de la tarjeta"`

### Task 3: En una vuelta lateral los recortes están en reposo, como el resto de la tarjeta

Decisión que hay que tomar (recomendada A): **A** — bajo `[data-nav-direction="-1"]` los recortes no reproducen `figureClipIn` ni el glifo su fundido (misma regla que `.pc-sheet`, `.pc-meta`… en `PaperCard.css:318-322`: «volver es volver a algo que estaba»). **B** — dejar que se animen pero ya con la tarea 2 (arrancan con la llegada de la página, no después). Si el usuario prefiere B, saltar esta tarea.

**Files:**
- Modify: `src/components/Feed/PaperCard.css:318-330` y la regla del glifo `:255-262`
- Test: `src/components/Feed/paperCardFigureEntrance.test.js`

- [ ] **Step 1: Test que falla**

```js
test('en una llegada lateral hacia atrás los recortes y el glifo están en reposo', async () => {
  const css = strip(await read('./PaperCard.css'));
  assert.match(css, /\[data-nav-direction="-1"\] \.pc-figure\.is-loaded \{[^}]*animation-name: none, figureClipDrift;/);
  assert.match(css, /\[data-nav-direction="-1"\] \.pc-watermark[^{]*\{[^}]*transition: none;/);
});
```

- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar** (junto al bloque de reposo existente). Sólo se anula el nombre de la primera animación: la deriva conserva su retardo `calc(var(--fig-in-duration) + 1.1s)`, así que empieza cuando habría empezado.

```css
/* Volver (-1) es volver a algo que estaba: el recorte ya estaba en su hueco. */
[data-nav-direction="-1"] .pc-figure.is-loaded {
  animation-name: none, figureClipDrift;
}
[data-nav-direction="-1"] .pc-watermark { transition: none; }
```
Comprobar antes cómo se llama la regla del glifo en `:255-262` (si usa `animation` en vez de `transition`, anular `animation-name` igual que arriba) y que `prefers-reduced-motion` no la pise.

- [ ] **Step 4: Correr** → PASS. Medir con la sonda: en `pov`/`pfeed` `figAnims` debe ser 0 en la vuelta y seguir siendo 9 en una entrada con `data-nav-direction="1"` (ida Following → For you no existe; usar la sonda `first` de un feed recién cargado como control).
- [ ] **Step 5: Commit** — `git commit -am "fix(feed): al volver, los recortes están en reposo como el resto de la tarjeta"`

### Task 4: El overlay conserva el paper mientras se va

**Files:**
- Modify: `src/components/Feed/PaperOverlay.jsx`, `src/components/Report/ScientificReport.jsx:242,877-901`, `src/components/Explorer/EntityExplorer.jsx:2594`, `src/components/Search/SearchPage.jsx:1391`
- Test: `src/components/Feed/paperOverlayExit.test.js` (crear)

**Interfaces:**
- Produces: `PaperOverlay` acepta `onExitComplete?: () => void`, llamado cuando Base UI termina la salida (`onOpenChangeComplete(false)`).

- [ ] **Step 1: Test que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

test('el overlay avisa al acabar la salida y Research mantiene el paper hasta entonces', async () => {
  const ov = strip(await read('./PaperOverlay.jsx'));
  assert.match(ov, /onOpenChangeComplete=\{\(nextOpen\) => \{ if \(!nextOpen\) onExitComplete\?\.\(\); \}\}/);
  const sr = strip(await read('../Report/ScientificReport.jsx'));
  assert.match(sr, /const \[shownPaper, setShownPaper\] = useState\(null\)/);
  assert.match(sr, /if \(selectedPaper && selectedPaper !== shownPaper\) setShownPaper\(selectedPaper\)/);
  assert.match(sr, /onExitComplete=\{\(\) => setShownPaper\(null\)\}/);
  assert.match(sr, /\{shownPaper && \(\s*<PaperCard\s+paper=\{shownPaper\}/);
});
```

- [ ] **Step 2: Correr** → FAIL.
- [ ] **Step 3: Implementar.** En `PaperOverlay`:

```jsx
export default function PaperOverlay({ open, onClose, onExitComplete, isEnglish, label, children }) {
  return (
    <Dialog
      open={Boolean(open)}
      onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}
      onOpenChangeComplete={(nextOpen) => { if (!nextOpen) onExitComplete?.(); }}
    >
```
En `ScientificReport` (patrón «identidad de un popup mientras se va»: ajuste de estado en render):

```jsx
const [shownPaper, setShownPaper] = useState(null);
if (selectedPaper && selectedPaper !== shownPaper) setShownPaper(selectedPaper);
// …
<PaperOverlay open={Boolean(selectedPaper)} onClose={closeOverlay} onExitComplete={() => setShownPaper(null)} …>
  {shownPaper && (
    <PaperCard paper={shownPaper} isLiked={likedPaperIds.has(interactionIdFor(shownPaper))} … />
  )}
</PaperOverlay>
```
Reemplazar cada `selectedPaper` dentro del bloque de props por `shownPaper`. Repetir el mismo par de cambios en `EntityExplorer.jsx` y `SearchPage.jsx` (allí `open` también depende del PDF: `shownPaper` se limpia sólo por `onExitComplete`, no al abrir el PDF). Comprobar que la versión de `@base-ui-components/react` del `package.json` expone `onOpenChangeComplete` en `Dialog.Root`; si no, sustituir por un `setTimeout` de 220 ms (la salida dura 200 ms en `PaperOverlay.css`) limpiado en desmontaje.

- [ ] **Step 4: Correr** → PASS. Medir: sonda `t4 overlay`, carpeta `t4-close-frames`: el fotograma a ~50 ms debe mostrar la tarjeta desvaneciéndose, no el fondo vacío.
- [ ] **Step 5: Commit** — `git commit -am "fix(overlay): la tarjeta se queda mientras el overlay se va"`

### Task 5: El relevo lateral mueve las dos páginas en el mismo eje

**Files:**
- Modify: `src/components/Layout/PageTransition.jsx:171-177` (atributo nuevo), `src/components/Layout/PageTransition.css:33-37,85-105,129-150`
- Test: `src/components/Layout/pageTransition.test.js` (existe o crear siguiendo la convención)

**Interfaces:**
- Produces: la raíz que se va lleva `data-leave-direction="1|-1"` con la dirección de la navegación que la expulsa (hoy `data-nav-direction` conserva a propósito la de llegada, `arrivedWith`, y el CSS no puede saber hacia dónde se va).

- [ ] **Step 1: Simular la curva antes de elegir valores** (memoria «curva por fotograma en un hueco que empuja»): con `--ease-out-quad` y 240 ms, 28 px de entrada dan 3,9 px en el primer fotograma y < 0,5 px en los últimos 60 ms; 10 px/180 ms (lo actual) hace 2,3 px el primero y nada visible después de 100 ms — es un fundido. Escribir la tabla en el commit.

- [ ] **Step 2: Test que falla**

```js
test('la salida lateral conoce su dirección y ambas páginas viajan en el mismo eje', async () => {
  const jsx = strip(await read('./PageTransition.jsx'));
  assert.match(jsx, /data-leave-direction=\{present \? undefined : direction\}/);
  const css = strip(await read('./PageTransition.css'));
  assert.match(css, /--page-lateral-ms: 240ms/);
  assert.match(css, /\[data-page-motion="hold-lateral"\]\[data-leave-direction="1"\] \{[^}]*pageHoldToLeft/);
  assert.match(css, /\[data-page-motion="hold-lateral"\]\[data-leave-direction="-1"\] \{[^}]*pageHoldToRight/);
  assert.match(css, /@keyframes pageEnterFromRight \{\s*from \{ opacity: 0; transform: translateX\(28px\); \}/);
  assert.match(css, /@keyframes pageHoldToLeft \{\s*from \{ opacity: 1; transform: none; \}\s*to \{ opacity: 0\.7; transform: translateX\(-12px\); \}/);
  assert.doesNotMatch(css, /pageHoldToLeft[^}]*scale/);
});
```

- [ ] **Step 3: Correr** → FAIL.
- [ ] **Step 4: Implementar.** JSX: añadir `data-leave-direction={present ? undefined : direction}` al `<div>` raíz. CSS:

```css
--page-lateral-ms: 240ms;

.page-transition[data-page-motion="hold-lateral"] {
  animation: pageHold var(--page-lateral-ms) var(--ease-out-quad) both; /* respaldo sin dirección */
}
.page-transition[data-page-motion="hold-lateral"][data-leave-direction="1"] {
  animation: pageHoldToLeft var(--page-lateral-ms) var(--ease-out-quad) both;
}
.page-transition[data-page-motion="hold-lateral"][data-leave-direction="-1"] {
  animation: pageHoldToRight var(--page-lateral-ms) var(--ease-out-quad) both;
}
@keyframes pageEnterFromRight { from { opacity: 0; transform: translateX(28px); } to { opacity: 1; transform: none; } }
@keyframes pageEnterFromLeft  { from { opacity: 0; transform: translateX(-28px); } to { opacity: 1; transform: none; } }
@keyframes pageHoldToLeft  { from { opacity: 1; transform: none; } to { opacity: 0.7; transform: translateX(-12px); } }
@keyframes pageHoldToRight { from { opacity: 1; transform: none; } to { opacity: 0.7; transform: translateX(12px); } }
```
La entrada debe llegar a opacidad ≥ 0,6 en el primer tercio (`from` en 0 pero con la retenida a 0,7 y desplazada, la doble exposición se lee como un pase, no como una superposición). Reduced motion (`:180-196`) no cambia. El bloque `@media (prefers-reduced-motion)` repite selectores con dos atributos: añadir los de `data-leave-direction` a la misma especificidad, o el fundido reducido pierde contra estas reglas.

- [ ] **Step 5: Correr** → PASS. Medir con `scripts/diagnostics/page-transition-frames.mjs 'a[href="#/research"]' t5` y la sonda `first`: `exposed 0`, `void 0`, `settled` ≈ 240–260 ms, y en la hoja de contactos las dos páginas desplazadas en direcciones opuestas a 80 ms. Repetir For you → Research, Research → Following y Following → Research.
- [ ] **Step 6: Commit** — `git commit -am "feat(transiciones): el relevo entre pestañas es un desplazamiento, no un fundido"`

### Task 6: Research llega con su héroe cuando el informe está en caché

**Files:**
- Modify: `src/components/Report/ScientificReport.jsx` (donde se piden trends/openalex; localizar con `grep -n "report/trends\|fetchReport\|useEffect" src/components/Report/ScientificReport.jsx`), `src/components/Report/ScientificReport.css` (`.sr-enter`)
- Test: `src/components/Report/reportSessionCache.test.js` (crear)

**Interfaces:**
- Consumes: `createSessionCache` de `src/utils/sessionCache.js` (patrón ya usado por el feed: la remontada siembra desde la caché y revalida).

- [ ] **Step 1: Antes de nada, medir qué salta.** En la hoja `pfeed-first` el héroe aparece a 311 ms y las cifras cambian hasta 894 ms. Abrir el componente y decidir con evidencia: si las cifras son un contador animado, arrancarlo sólo cuando `usePageArrival().isArriving()` sea false; si son datos progresivos (llegan 3 respuestas de `/report/trends`), la caché de sesión de abajo las deja fijas en la revisita.

- [ ] **Step 2: Test que falla**

```js
test('Research siembra el informe desde la caché de sesión y revalida', async () => {
  const src = strip(await read('./ScientificReport.jsx'));
  assert.match(src, /const reportCache = createSessionCache\(/);
  assert.match(src, /useState\(\(\) => reportCache\.get\(reportKey\)/);
});
```

- [ ] **Step 3: Implementar** con el mismo contrato que el feed (`createSessionCache` → `get(key)` / `set(key, value)`): clave = filtros serializados (rango de fechas, disciplinas, tipo); el estado del informe nace de la caché, la petición sigue saliendo y, al resolver, `set` + `setState` sólo si cambió (`JSON.stringify` de los ids del héroe y las cifras). Con eso `LeadStorySkeleton` sólo se ve en la primera visita.

- [ ] **Step 4: Que la llegada del héroe sea una llegada.** Hoy `LeadStorySkeleton` y el héroe llevan ambos `sr-enter` con `--enter-order: 0`, así que el cambio esqueleto→héroe es un corte. Dar al héroe real, cuando sustituye a un esqueleto ya pintado, una variante `sr-enter--swap` (opacidad 0→1, 8 px, 220 ms, `--ease-out-quad`) y reservar la altura del esqueleto = altura del héroe (medir ambas con `getBoundingClientRect` en la sonda; si difieren, el título «Research» y los filtros se mueven — memoria «dos alturas de la caja de Wikipedia»).

- [ ] **Step 5: Medir** — sonda `first` tras una visita previa a Research en la misma sesión: `.sr-hero-actions` presente en la primera muestra; sin visita previa: esqueleto en el primer fotograma y héroe fundiéndose sin mover la cabecera.
- [ ] **Step 6: Commit** — `git commit -am "feat(research): el informe se siembra de la caché de sesión y el héroe llega en vez de saltar"`

### Task 7: Following → Research no empieza 170 ms tarde

**Files:**
- Modify: según lo que mida el paso 1 — `src/utils/feedMountWindow.js` (tope de ventana) o `src/components/Feed/FeedContainer.jsx:146-180`
- Test: `src/utils/feedMountWindow.test.js`

- [ ] **Step 1: Aislar el coste.** Con `Tracing.start` (receta en `scripts/diagnostics/explorer-loading-probe.mjs`) grabar el clic Following → Research y leer qué ocupa los 168 ms: `FunctionCall` de React (commit de navegación con 60 tarjetas retenidas) o `UpdateLayoutTree`/`Layout` del montaje de Research. Control: mismo clic desde For you (15 tarjetas, long task de 56 ms).

- [ ] **Step 2: Si es la ventana** (lo esperable: 60 tarjetas frente a 15): la ventana progresiva debe dejar de crecer al cubrir el ancla ± `MOUNT_WINDOW_MAX_RADIUS = 6` y desmontar lo que quede fuera al desplazarse (hoy sólo crece: `mountWindowCovers`). Test en `feedMountWindow.test.js`:

```js
import { growMountWindow, MOUNT_WINDOW_MAX_RADIUS } from './feedMountWindow.js';
test('la ventana no crece más allá del radio máximo alrededor del ancla', () => {
  assert.equal(MOUNT_WINDOW_MAX_RADIUS, 6);
  // firma actual: growMountWindow(window, total, step); se añade `anchorIndex` como cuarto argumento
  const w = growMountWindow({ lo: 0, hi: 20 }, 60, 2, 20);
  assert.deepEqual(w, { lo: 14, hi: 26 });
});
```
y en `FeedContainer` pasar `anchorIndex` = índice de la tarjeta bajo el viewport (ya lo calcula `handleScroll`, `:398`). Verificar con la sonda que la reanudación (`feedResume.test.js`) y la carga infinita siguen pasando.

- [ ] **Step 3: Si es el montaje de Research**, el arreglo es la tarea 6 (con caché el primer render es más barato) más dividir el `WorldMap` en un `lazy` que monte tras `isArriving()`; medir de nuevo.
- [ ] **Step 4: Medir** — sonda `pfol first from=following`: `first rAF sample` ≤ 40 ms y ningún long task > 50 ms tras el clic.
- [ ] **Step 5: Commit** — `git commit -am "perf(feed): la ventana de montaje tiene tope y el cambio de pestaña arranca en el primer fotograma"`

---

## Orden y dependencias

1 → 2 → 3 (feed); 4 suelto; 5 suelto; 6 → 7 (7 depende de lo que mida su paso 1). Tras 2 y 5, repetir la sonda `overlay` completa: el «glitch» del usuario es la suma de 1 + 2 + 3 vistos seguidos.

---

## Ejecución — notas del 2026-09-11

**Tarea 3: OMITIDA a propósito, rama B, por medida.** La tarea proponía anular
`figureClipIn` bajo `[data-nav-direction="-1"]`. Medido en la rama
`fix/vuelta-feed-y-pestanas` con la sonda: ese atributo **no se retira al asentar
la página**, se queda en `-1` toda la visita (`rest:-1` a 1601 ms). Y una tarjeta
a la que el lector baja DESPUÉS, con la página ya en reposo, sí reproduce su
entrada hoy:

```
llegada: {"motion":"rest","nav":"-1"}
  tras bajar 1 -> {"figuras":0,"entradaCorriendo":0,"navDelPadre":"-1"}
  tras bajar 2 -> {"figuras":2,"cargadas":2,"entradaCorriendo":2,"navDelPadre":"-1"}
```

Así que la regla de la tarea 3 habría apagado la entrada de toda tarjeta vista
tras una llegada lateral hacia atrás, deshaciendo 41cd627 (subido ese mismo día,
cuyo objeto era justamente que un recorte cacheado animara cuando el lector lo ve).
La rama B del propio plan — «dejar que se animen, ya alineados con la llegada de
la página gracias a la tarea 2» — es lo que queda, y la medida de la tarea 2 la
respalda: la entrada arranca a 37 ms, con la página aún entrando a opacidad 0,17,
en vez de a 322 ms sobre una tarjeta quieta.

Si más adelante se quiere de verdad que la tarjeta a la que se VUELVE esté en
reposo sin tocar a las demás, hace falta distinguir «sembrada de caché **mientras
la página llegaba**» de «sembrada de caché al bajar hasta ella», y eso no es una
regla CSS: `usePageArrival` lee del DOM y no contesta en el primer render.

**Tarea 7: paso 1 HECHO, arreglo NO aplicado.** La medida está, y cambia cuál
debería ser el arreglo.

Medido en la rama, build de producción, sesión real, con
`scripts/diagnostics/feed-return-figures-probe.mjs` y traza CDP:

| desde | tarjetas montadas | tarea individual más larga | 1ª muestra tras el clic |
|---|---|---|---|
| For you | 15 | ninguna > 20 ms | 23–38 ms |
| Following (ventana sin crecer) | 2 | 40,9 ms | — |
| Following (ventana crecida) | 60 | 97,9 ms | 105 ms |

El coste es **JavaScript**, no layout: en la ventana de 1,2 s, `UpdateLayoutTree`
25,6 ms y `Layout` 20,9 ms frente a un único `EvaluateScript` → `FunctionCall`
de 98 ms. Y escala con las tarjetas montadas de la página que se VA, no con lo
que monta la que llega (el suelo de 40,9 ms es el montaje de Research).

**Por qué no he aplicado el arreglo que proponía la tarea.** Poner tope a la
ventana obliga a que el ancla siga al lector, y eso obliga a **desmontar** lo que
queda fuera al desplazarse. Hoy la ventana sólo crece y nada se desmonta. Una
tarjeta desmontada y vuelta a montar reproduce `pcArrive` y la entrada de sus
recortes: es decir, introduce en el camino de scroll del feed exactamente la
clase de regresión visual que esta misma sesión ha venido a quitar, para ahorrar
~50 ms en un cambio de pestaña desde una sola superficie. No es un cambio que
deba entrar sin decidirlo.

**Y el mecanismo no está identificado**, así que ni siquiera está claro que la
ventana sea el arreglo correcto. Dos hipótesis comprobadas y descartadas:

1. *Props inestables rompiendo el `memo` de PaperCard* — no hay ninguna prop
   inline en el bloque que `FeedContainer` le pasa; todas son estables.
2. *Los IntersectionObserver disparándose al volverse `position: fixed` la
   página* — medido: los recortes de la página que se va conservan `is-loaded`
   durante toda la salida (`figs=[Lcs Lcs]` de 41 ms a 309 ms), así que
   `figuresLit` no cae y los observadores no se disparan.

Queda por mirar: qué función concreta ocupa esos 98 ms (traza con pilas, no sólo
por nombre de evento), y si `inert` sobre un subárbol con 60 tarjetas es parte
del coste. Sin eso, cualquier arreglo es una apuesta.
