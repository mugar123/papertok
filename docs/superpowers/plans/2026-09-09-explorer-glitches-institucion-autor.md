# Explorer: la píldora ORCID nace en su sitio y el velo deja de hacer zoom — plan de ejecución

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la tarjeta ORCID (y su píldora «Verified ORCID profile») aparezca en su posición final y no baje 10 px cuando la nota de impacto reciente se asienta; que el velo desenfocado de la página de institución se funda sin cambiar de escala mientras el héroe crece; y que el fundido esqueleto → héroe no superponga dos rejillas de estadísticas desplazadas.

**Architecture:** Dos correcciones de caja, sin tocar ningún reloj. (1) La celda de impacto y la rejilla que la contiene se reservan al tamaño que van a tener asentadas — `width` fijo en la rejilla, `min-height` de dos líneas en el detalle — y el esqueleto pinta esa misma rejilla, de modo que nada encima de la tarjeta ORCID cambia de altura después del héroe vivo. (2) El velo `.ehc-bg-blur` pasa a ser un contenedor con la máscara y un `::before` con la imagen desenfocada en una caja de altura fija, desacoplada de la altura del héroe; la URL viaja por una variable CSS. Todo se verifica con la sonda `explorer-glitch-frames.mjs` contra la build de producción con la sesión real.

**Tech Stack:** React 19 + Vite, CSS plano (`EntityExplorer.css`), framer-motion sólo como bookkeeper del velo, tests de fuente con `node --test` (leen el JSX/CSS y hacen `assert.match`), sonda CDP sin dependencias.

**Spec:** `docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md` — §1 (píldora y rejilla), §2 (velo), §3.2 (fundido con dos rejillas). §3.1 y §3.4 quedan fuera a propósito (§5 de la auditoría: decisiones de producto pendientes del usuario).

## Global Constraints

- Ningún cambio de duración ni de curva: las tres correcciones son de geometría. Los relojes de `PageTransition.css`, `useHeightSettle` y el despliegue de Wikipedia no se tocan.
- Los tests de fuente siguen la convención de `explorerReservation.test.js`: `stripComments` antes de casar, captura acotada (`[^}]*` dentro de una regla, nunca `[\s\S]*` libre), y cada aserción debe fallar si se revierte la línea que protege (comprobar por mutación antes de dar el test por bueno).
- Comentarios en el código en inglés, como el resto de `EntityExplorer.css`/`.jsx`; commits en castellano con el formato `tipo(ámbito): qué deja de pasar`.
- Medir siempre contra `npm run build` + `vite preview --port 5174` con `PROFILE_DIR=~/.papertok-probe-profile`; nunca contra `vite dev` (auditoría §4).
- El perfil de Chrome con sesión se reutiliza y **no se borra** (`OWN_PROFILE` en la sonda). Chrome cerrado antes de medir.
- No commitear `IS_DEMO = true`, ni `dist/`, ni las capturas de las sondas.

---

### Task 1: La sonda entra en el repositorio con su entrada en el README

**Files:**
- Ya creado (sin commitear): `scripts/diagnostics/explorer-glitch-frames.mjs`
- Modify: `scripts/diagnostics/README.md` (añadir una sección antes de `## page-transition-frames.mjs`)

**Interfaces:**
- Produces: `node scripts/diagnostics/explorer-glitch-frames.mjs route|chain …` con las banderas `out=<dir>`, `profile`, `tab=authors`, `wait=<ms>`, `idx=<n>`, `mobile`, `slow`; imprime `{"frames","gaps","screencast"}` y luego una línea `t=<ms> hash=… y=…` por cada fotograma en que algo cambió, con `p0`/`p1` por página. Las tareas 5 leen `impact`, `orcidSkel`, `orcidCard`, `badge`, `wash`, `stats` y `aside` de esas líneas.

- [ ] **Step 1: Comprobar que la sonda corre contra el dev server o el preview que haya**

```bash
node --check scripts/diagnostics/explorer-glitch-frames.mjs
lsof -nP -iTCP:5174 -sTCP:LISTEN || (npm run build && npx vite preview --port 5174 &)
PORT=9261 ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/author/A5068353058' 4000 | head -3
```

Esperado: la primera línea es un JSON `{"frames":N,"gaps":[…],"screencast":M}` con N > 100.

- [ ] **Step 2: Añadir la sección al README**

Insertar antes de la línea `## `page-transition-frames.mjs` — a route transition, frame by frame (2026-09-06)`:

```markdown
## `explorer-glitch-frames.mjs` — a navigation's frames AND its geometry, on one clock (2026-09-09)

`explorer-hero-frames.mjs` samples the hero; this one samples EVERY page under
`#main-content` (two during a navigation) and records a `Page.screencast` at
the same time, naming each PNG by the same `Date.now()` the sampler stamps its
lines with — so `f096_01813ms.png` and the sampler line `t=1813` are the same
instant. It also records three boxes the older probe did not: the wash
(`.ehc-bg-blur`) with its box and not just its opacity, the recent-impact cell
with its detail text, and the hero aside with its stats grid. Those three are
what `docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md` was found with.

```bash
export PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174
node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I136199984' '.ee-author-card:not(.ex-skel-row)' tab=authors wait=2500 7000 out=/tmp/chain profile
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/author/A5068353058' 8000 out=/tmp/author
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/institution/I136199984' 7000 out=/tmp/inst
```

`chain` opens the first route, optionally clicks the Authors tab
(`tab=authors`), waits for the selector, waits `wait=` ms more, and only then
starts sampling, casting and (with `profile`) the V8 sampler, so the click is
the first thing in the record. Use `:not(.ex-skel-row)` in the selector: with a
session the authors list takes longer, and a bare `.ee-author-card` clicks a
skeleton row and the run ends "clean" because it never navigated. `profile`
prints tasks over 50ms with their outermost app frame; read it only on a
production build — `vite dev`'s `jsxDEV` alone measured 1004ms of self time
in a 5.6s run and turned every data arrival into a 100–700ms freeze that the
build does not have.

The `route`/`chain` output is one JSON line, then one `t=` line per frame on
which something changed, with a `p0`/`p1` JSON per page. A quick per-field diff
of consecutive lines is the readable form; `docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md`
§6 has the crop command for the PNGs.
```

- [ ] **Step 3: Commit**

```bash
git add scripts/diagnostics/explorer-glitch-frames.mjs scripts/diagnostics/README.md
git commit -m "tools(diagnostics): una sonda que graba los fotogramas y la geometría de una navegación con el mismo reloj

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: La forma del esqueleto sabe qué páginas llevan la celda de impacto

**Files:**
- Modify: `src/utils/explorerSkeletonShape.js:71-90`
- Test: `src/utils/explorerSkeletonShape.test.js` (añadir un test al final)

**Interfaces:**
- Produces: `explorerSkeletonShape(type).impact: boolean` — `true` para `author` e `institution` (los dos tipos para los que `EntityExplorer.jsx:1794-1801` monta `RecentImpactStat`), `false` para el resto. Task 3 lo lee en el JSX del esqueleto.

- [ ] **Step 1: Escribir el test que falla**

Al final de `src/utils/explorerSkeletonShape.test.js`:

```js
test('the skeleton knows which pages carry the recent-impact cell', () => {
  // `RecentImpactStat` mounts for authors and institutions only
  // (EntityExplorer.jsx), and its cell is the one with a two-line detail
  // under the label. Measured 2026-09-09 on a cold author: the cell grew
  // 64.5 → 77.5px when the score landed and the ORCID card under the header
  // dropped 10.3px in one frame. The skeleton reserves that detail line on
  // exactly the pages where the cell lands, and nowhere else.
  assert.equal(explorerSkeletonShape('author').impact, true);
  assert.equal(explorerSkeletonShape('institution').impact, true);
  for (const type of ['concept', 'topic', 'project', 'source']) {
    assert.equal(explorerSkeletonShape(type).impact, false);
  }
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

```bash
node --test src/utils/explorerSkeletonShape.test.js
```

Esperado: 1 fallo, `Expected values to be strictly equal: undefined !== true`.

- [ ] **Step 3: Añadir el campo**

En `src/utils/explorerSkeletonShape.js`, dentro del objeto que devuelve `explorerSkeletonShape`, después de `stats: projectish ? 2 : 4,`:

```js
    // Whether the fourth cell is the recent-impact one, with a detail line
    // under its label. `RecentImpactStat` mounts for authors and institutions
    // (EntityExplorer.jsx); the skeleton reserves its two-line detail so the
    // grid is born at the height it will have once the score lands, and the
    // ORCID card under the header does not drop when it does.
    impact: authorish || institutionish,
```

Y en el bloque de documentación de arriba, tras el párrafo de `stats`:

```js
 * - `impact` — whether the grid's last cell is the recent-impact one, whose
 *   detail wraps to two lines once the score is known. Measured 2026-09-09:
 *   unreserved, the cell grew 64.5 → 77.5px when the score landed and the
 *   ORCID card under the header dropped 10.3px in one frame.
```

- [ ] **Step 4: Correr los tests y verlos pasar**

```bash
node --test src/utils/explorerSkeletonShape.test.js
```

Esperado: todos pasan.

- [ ] **Step 5: Commit**

```bash
git add src/utils/explorerSkeletonShape.js src/utils/explorerSkeletonShape.test.js
git commit -m "feat(explorer): la forma del esqueleto sabe qué páginas llevan la celda de impacto

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: La celda de impacto y su rejilla nacen al tamaño que van a tener

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.css:632-640` (`.ehc-stats-grid`), `:701-705` (`.ehc-stat-detail`), `:1158-1159` (celdas del esqueleto), `:2384+` (`.ehc-hero-aside .ehc-stats-grid`, dentro de `@media (max-width: 768px)`)
- Modify: `src/components/Explorer/EntityExplorer.jsx:1431-1438` (rejilla del esqueleto)
- Test: `src/components/Explorer/explorerReservation.test.js` (añadir un test)

**Interfaces:**
- Consumes: `explorerSkeletonShape(type).impact` (Task 2), `shape.stats`.
- Produces: la rejilla mide 264 px de ancho desde el primer fotograma en escritorio (esqueleto y héroe vivo) y la celda de impacto 77,5 px de alto en los dos estados. Task 5 lo comprueba con la sonda: `stats` y `impact` no cambian de caja entre «Calculating…» y la nota asentada.

- [ ] **Step 1: Escribir el test que falla**

Al final de `src/components/Explorer/explorerReservation.test.js`:

```js
/**
 * The recent-impact cell used to be born one line short. Measured 2026-09-09
 * on a cold author in production, signed in: "Calculating…" laid the cell out
 * at 124×64.5 and the grid at 249×112.9, the score landed 484ms later as
 * "Very high · 2023–2026" and the cell became 131.5×77.5, the grid 264×125.9,
 * and the header — a wrapping flex row — grew 10.3px. Everything under it
 * moved by that much in one frame: the experience panel, the ORCID card, the
 * "Verified ORCID profile" pill. The settle animates the body's bottom edge,
 * not where its children sit. So the grid takes its width up front, the
 * detail its two lines, and the skeleton paints the same cell.
 */
test('the impact cell and its grid are born at the size the score will take', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  // The grid measured to content under a 264px max and reached the max only
  // once the score landed. Pinned — but only where the growing cell exists, so
  // a topic's or a project's aside keeps measuring to its own content.
  assert.match(css, /\.ehc-stats-grid:has\(\.ehc-stat-box--impact\) \{\s*width: 264px;\s*\}/);
  // Two lines of 0.625rem/1.3 mono: 1.625rem.
  assert.match(css, /\.ehc-stat-detail \{[^}]*\n  min-height: 1\.625rem;\n\}/);
  // Under 768px the aside spans the row and the grid with it — width wins
  // over the fixed 264 there.
  assert.match(css, /\.ehc-hero-aside \.ehc-stats-grid \{\n    width: 100%;\n    max-width: none;\n    flex: 1 1 100%;\n  \}/);
  // The skeleton's last cell carries the detail box on the pages that have it.
  // `display: block` is load-bearing: the bar's parent is the `.ehc-stat-detail`
  // span, not the flex `.ehc-stat-box`, so without it the bar stays inline and
  // width/height do nothing.
  assert.match(css, /\.ex-skel-stat-detail \{ display: block; width: 96px; height: 8px; margin-top: 2px; \}/);
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  // The skeleton's last cell IS the impact cell on those pages: it carries the
  // class the `:has()` above keys on, and the detail box that sets the height.
  assert.match(jsx, /const isImpact = shape\.impact && i === shape\.stats - 1;/);
  assert.match(jsx, /className=\{`ehc-stat-box\$\{isImpact \? ' ehc-stat-box--impact' : ''\}`\}/);
  assert.match(jsx, /\{isImpact && \(\s*<span className="ehc-stat-detail"><span className="ex-skel ex-skel-stat-detail"><\/span><\/span>\s*\)\}/);
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

```bash
node --test src/components/Explorer/explorerReservation.test.js
```

Esperado: 1 fallo en la primera `assert.match` (no existe la regla `:has(.ehc-stat-box--impact)`).

- [ ] **Step 3: La rejilla y el detalle en el CSS**

En `src/components/Explorer/EntityExplorer.css`, **dejar `.ehc-stats-grid` como está** y añadir inmediatamente después de esa regla (tras su `}`, sobre la línea 640):

```css
/* Born at its settled width, and only where it grows. The recent-impact cell's
   detail is one line while it says "Calculating…" and two once the score is
   known; with the grid measured to content, that second line took it from
   249×112.9 to 264×125.9 (measured 2026-09-09, cold author, production, signed
   in) and the header — a wrapping flex row — grew 10.3px, dropping the
   experience panel, the ORCID card and its "Verified ORCID profile" pill by
   that much in ONE frame. The settle animates the body's bottom edge, not
   where its children sit, so nothing eased it.

   264 is not a guess: two columns of `minmax(94px, 1fr)` under a 264px
   max-width cap each column at 132, and the settled cell measured 131.5 — the
   grid is AT its cap once the score lands, whatever the score's wording. So
   pinning it here is exact rather than tuned to one label.

   Scoped with `:has()` rather than set on `.ehc-stats-grid`, because only
   author and institution carry this cell (explorerSkeletonShape.js). A topic's
   or a project's aside has nothing that grows and keeps measuring to its own
   content; widening those to 264 would be a look change with no defect behind
   it. The skeleton's last cell carries the same class for the same reason. */
.ehc-stats-grid:has(.ehc-stat-box--impact) {
  width: 264px;
}
```

Sustituir la regla `.ehc-stat-detail` (líneas 701-705) por:

```css
/* Two lines from the first frame. "Calculating…" is one line; the settled
   detail ("Very high · 2023–2026") wraps to two in a 131px cell, and a cell
   that grows by a line moves everything under the header (see
   .ehc-stats-grid). 0.625rem × 1.3 × 2. */
.ehc-stat-detail {
  color: var(--text-secondary);
  font: 500 0.625rem/1.3 var(--font-mono);
  margin-top: 2px;
  min-height: 1.625rem;
}
```

Añadir tras `.ex-skel-stat-label { width: 68px; height: 9px; margin-top: 5px; }` (línea 1159):

```css
/* The impact cell's detail, one bar inside the live `.ehc-stat-detail` box so
   the reservation is the box's own min-height and cannot drift from it.
   `display: block` because this bar is NOT a flex item: its parent is the
   `.ehc-stat-detail` span, not `.ehc-stat-box`. The sibling bars get their
   width and height for free by being blockified as flex children of the box;
   this one would stay inline and ignore both. */
.ex-skel-stat-detail { display: block; width: 96px; height: 8px; margin-top: 2px; }
```

Y en la única regla `.ehc-hero-aside .ehc-stats-grid` del fichero, que vive dentro de
`@media (max-width: 768px)` (no 900: el plan lo llamó así por error), sustituir por:

```css
  .ehc-hero-aside .ehc-stats-grid {
    width: 100%;
    max-width: none;
    flex: 1 1 100%;
  }
```

- [ ] **Step 4: La celda de impacto en el esqueleto**

En `src/components/Explorer/EntityExplorer.jsx`, sustituir el `map` de la rejilla del esqueleto (líneas 1432-1437):

```jsx
                  {Array.from({ length: shape.stats }, (_, i) => {
                    // The last cell IS the recent-impact one on the pages that
                    // carry it, so it takes that cell's class — the stylesheet
                    // pins the grid's width through it — and the detail box
                    // whose two reserved lines are the cell's real height.
                    const isImpact = shape.impact && i === shape.stats - 1;
                    return (
                      <div key={i} className={`ehc-stat-box${isImpact ? ' ehc-stat-box--impact' : ''}`}>
                        <span className="ex-skel ex-skel-stat-value"></span>
                        <span className="ex-skel ex-skel-stat-label"></span>
                        {isImpact && (
                          <span className="ehc-stat-detail"><span className="ex-skel ex-skel-stat-detail"></span></span>
                        )}
                      </div>
                    );
                  })}
```

- [ ] **Step 5: Correr los tests del Explorer y verlos pasar**

```bash
node --test src/components/Explorer/explorerReservation.test.js src/components/Explorer/explorerMotion.test.js src/components/Explorer/explorerEntrance.test.js src/components/Explorer/explorerLoading.test.js src/utils/explorerSkeletonShape.test.js
```

Esperado: todos pasan. Si `explorerMotion.test.js` u otro casa `.ehc-stats-grid` con el texto antiguo, actualizar ese test citando esta medida, no relajar la regex.

- [ ] **Step 6: Comprobar por mutación que el test muerde**

Quitar temporalmente `min-height: 1.625rem;` del CSS, correr `node --test src/components/Explorer/explorerReservation.test.js`, ver el fallo, y restaurar la línea. Repetir con `width: 264px;`.

- [ ] **Step 7: Mirar la rejilla en el navegador (dev server, sin sesión vale)**

Abrir `http://localhost:5173/#/explorer/author/A5068353058` y, desde la consola, en cuanto exista el héroe vivo:

```js
[...document.querySelectorAll('.ehc-stat-box')].map(b => Math.round(b.getBoundingClientRect().height))
```

Esperado: las tres primeras celdas iguales entre sí y la cuarta (impacto) **77–78 px** ya con «Calculating…»; repetir cuando ponga la nota: la misma altura. Y `document.querySelector('.ehc-stats-grid').getBoundingClientRect().width` = 264 en las dos lecturas. En el esqueleto (recargar y leer antes de que llegue el perfil): 264 y la cuarta celda ≈ 77.

- [ ] **Step 8: Commit**

```bash
git add src/components/Explorer/EntityExplorer.css src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerReservation.test.js
git commit -m "fix(explorer): la celda de impacto nace con sus dos líneas, y la tarjeta ORCID deja de bajar cuando llega la nota

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: El velo desenfocado vive en una caja fija

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.css:134-155` (`.ehc-bg-blur`)
- Modify: `src/components/Explorer/EntityExplorer.jsx:1569-1570` (el `motion.div` del velo)
- Test: `src/components/Explorer/explorerMotion.test.js` (añadir un test)

**Interfaces:**
- Consumes: nada de las tareas anteriores.
- Produces: `.ehc-bg-blur` es el contenedor (máscara, opacidad, `inset: 0`); `.ehc-bg-blur::before` lleva la imagen (`background-image: var(--ehc-wash-image)`) en una caja `top: -96px; height: 720px`. El JSX pone `--ehc-wash-image` en `style`. Task 5 comprueba con la sonda que `wash` (que mide el contenedor) crece con el héroe pero la imagen no cambia de escala: la sonda no mide el `::before`, así que el step 6 de esta tarea lo hace por `getComputedStyle`.

- [ ] **Step 1: Escribir el test que falla**

Al final de `src/components/Explorer/explorerMotion.test.js`:

```js
/**
 * The wash's box used to ride the hero's height — `top: -20%; bottom: 0` — and
 * the hero is growing exactly when the wash mounts: the thumbnail finishes
 * loading in the same stretch in which the Wikipedia block unfolds (320ms)
 * and, from cold, the navbar band opens (240ms). Measured 2026-09-09 on
 * Harvard from cold in production, signed in: the wash went through 21
 * distinct heights from 374.1 to 576.3px (+54%) while its whole 280ms fade ran,
 * so `cover` rescaled the photograph on every one of them and the 48px blur
 * was rasterised 21 times. The image lives on a fixed box now; the element is
 * only the mask.
 */
test('the wash keeps its image on a fixed box, so the hero growing does not rescale it', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  const container = css.match(/\.ehc-bg-blur \{[^}]*\}/)?.[0] || '';
  // Without this, a rule that vanished would make every `doesNotMatch` below
  // pass against an empty string.
  assert.ok(container, 'the top-level .ehc-bg-blur rule must exist');
  assert.match(container, /position: absolute;\s*inset: 0;/);
  assert.doesNotMatch(container, /background|filter|top: -20%|bottom: 0/);
  assert.match(container, /mask-image: linear-gradient\(to bottom, black 30%, transparent 100%\);/);
  assert.match(css, /\.ehc-bg-blur::before \{\s*content: '';\s*position: absolute;\s*top: -96px;\s*left: -10%;\s*right: -10%;\s*height: 720px;\s*background-image: var\(--ehc-wash-image\);\s*background-size: cover;\s*background-position: center;\s*filter: blur\(48px\) saturate\(1\.1\);\s*\}/);
  const jsx = stripComments(await read('./EntityExplorer.jsx'));
  assert.match(jsx, /className="ehc-bg-blur"\s*style=\{\{ '--ehc-wash-image': `url\(\$\{visibleWikiInfo\.thumbnail\}\)` \}\}/);
  assert.doesNotMatch(jsx, /backgroundImage: `url\(\$\{visibleWikiInfo\.thumbnail\}\)`/);
});
```

- [ ] **Step 2: Correr el test y verlo fallar**

```bash
node --test src/components/Explorer/explorerMotion.test.js
```

Esperado: 1 fallo (el contenedor no tiene `inset: 0`).

- [ ] **Step 3: El CSS**

En `src/components/Explorer/EntityExplorer.css`, sustituir el comentario y la regla `.ehc-bg-blur` (líneas 134-155, desde `/* A faint wash of the entity's own imagery` hasta el `}` que cierra la regla) por:

```css
/* A faint wash of the entity's own imagery, kept light so the page stays a
   white sheet rather than a photo header.

   Two boxes, and that is the whole fix. The element used to carry the image
   itself, `top: -20%; bottom: 0`, so its box was 120% of the hero's height —
   and the hero is growing exactly when the wash mounts: the thumbnail
   finishes loading in the same stretch in which the Wikipedia block unfolds
   (320ms) and, from cold, the navbar band opens (240ms). Measured 2026-09-09
   on Harvard from cold, production, signed in: 21 distinct heights from 374
   to 576px (+54%) while the whole 280ms fade ran. `cover` rescaled the
   photograph on every one of them, and a 48px blur over a 1536px-wide layer
   — the most expensive paint in the codebase, which the 768px media query
   below already switches off on phones — was rasterised 21 times in a row.

   The element is only the mask now: it sits on the hero's own box so the
   gradient still closes at the hero's bottom edge. The image is on a
   pseudo-element with a FIXED box, and fixed is the whole point — a
   percentage is what made it move. -96px is the -20% the old box started at
   on a hero at its resting 481px.

   720px is neither that box's height (that was 577) nor the hero's. It puts
   the picture's bottom edge at 624px, and the tallest hero measured — an
   institution with the Wikipedia paragraph expanded — is 721. It does not
   need to reach: the mask above is linear from solid at 30% to nothing at
   100%, so at 624 of 721 it is already down to 19% of an opacity that is
   itself 0.1. The picture ends at under 2% of its own weight — where nothing
   can see it end — and every pixel added below it would be blurred at 48px
   and then thrown away by the mask. 30% for the mask's solid stop, not 40%:
   the gradient used to run over the taller box, so its solid part reached
   ~28% of the hero. */
.ehc-bg-blur {
  position: absolute;
  inset: 0;
  opacity: 0.1;
  z-index: -1;
  pointer-events: none;
  mask-image: linear-gradient(to bottom, black 30%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 30%, transparent 100%);
  /* No animation here. It used to fade this in over 3s while the component
     faded the same property in over 1s to a different target, and a property
     with two animators has no defined look for as long as both are running. The
     component owns it now; 0.1 above is the resting weight, and the reason the
     photograph reads as a wash rather than as a picture. */
}

/* The picture, on a box that does not know how tall the hero is. The URL comes
   in on a custom property from the component (a pseudo-element cannot read an
   inline `background-image`). */
.ehc-bg-blur::before {
  content: '';
  position: absolute;
  top: -96px;
  left: -10%;
  right: -10%;
  height: 720px;
  background-image: var(--ehc-wash-image);
  background-size: cover;
  background-position: center;
  filter: blur(48px) saturate(1.1);
}
```

- [ ] **Step 4: El JSX**

En `src/components/Explorer/EntityExplorer.jsx`, sustituir las dos líneas del `motion.div` del velo (1569-1570):

```jsx
              className="ehc-bg-blur"
              style={{ '--ehc-wash-image': `url(${visibleWikiInfo.thumbnail})` }}
```

Y en el comentario de ese `motion.div`, añadir al final (antes de `initial={{ opacity: 0 }}`):

```jsx
              // The URL rides a custom property because the picture is on
              // the element's `::before`, on a box of its own — see the
              // stylesheet for the measurement that put it there.
```

- [ ] **Step 5: Correr los tests y verlos pasar**

```bash
node --test src/components/Explorer/explorerMotion.test.js src/components/Explorer/explorerEntrance.test.js
```

Esperado: todos pasan, incluido el test existente `explorerMotion.test.js:93` que casa `animate={{ opacity: 0.1 }}` con `className="ehc-bg-blur"` a menos de 240 caracteres (el comentario nuevo va **antes** de `initial`, no entre `animate` y `className`; si ese test falla, es que el comentario quedó en medio — moverlo).

- [ ] **Step 6: Comprobar en el navegador que la imagen ya no escala**

Abrir `http://localhost:5173/#/explorer/institution/I136199984` y, con la página en reposo, desde la consola:

```js
(() => {
  const el = document.querySelector('.ehc-bg-blur');
  const cs = getComputedStyle(el, '::before');
  return { container: el.getBoundingClientRect().height, image: { top: cs.top, height: cs.height, bg: cs.backgroundImage.slice(0, 40), filter: cs.filter } };
})()
```

Esperado: `image.top === "-96px"`, `image.height === "720px"`, `bg` empieza por `url("http`, `filter` es `blur(48px) saturate(1.1)`; `container` es la altura del héroe (~481 en escritorio). Abrir «Read more» del bloque de Wikipedia (el héroe crece) y repetir: `container` cambia, `image` no.

- [ ] **Step 7: Commit**

```bash
git add src/components/Explorer/EntityExplorer.css src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerMotion.test.js
git commit -m "fix(explorer): el velo desenfocado deja de hacer zoom mientras el héroe crece

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Verificación en producción con la sesión real, y el «Después» de la auditoría

**Files:**
- Modify: `docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md` (añadir `## 7. Después (fecha)` al final)

**Interfaces:**
- Consumes: la sonda de Task 1 y los cambios de Tasks 3 y 4.

- [ ] **Step 1: Build de producción y preview**

```bash
npm run build && npx vite preview --port 5174 &
```

Comprobar que no hay ningún Chrome con `~/.papertok-probe-profile` abierto (`pgrep -fl papertok-probe-profile` vacío).

- [ ] **Step 2: Autor frío — la píldora no se mueve**

Hace falta un autor cuya nota de impacto NO esté en la caché de Firestore de ese perfil. Elegir uno de la lista de autores de Harvard que no se haya abierto antes (p. ej. el tercero, `idx=2`), o cualquier `A…` no visitado:

```bash
export PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174
node scripts/diagnostics/explorer-glitch-frames.mjs chain '#/explorer/institution/I136199984' '.ee-author-card:not(.ex-skel-row)' tab=authors idx=2 wait=2500 8000 out=/tmp/v-chain > /tmp/v-chain.txt
grep -o 'impact":"[^"]*"' /tmp/v-chain.txt | sort | uniq -c
grep -o 'orcidSkel":"[0-9.,]* [0-9.x]*\|orcidCard":"[0-9.,]* [0-9.x]*' /tmp/v-chain.txt | sort | uniq -c
grep -o 'stats":"[0-9.,]* [0-9.x]*' /tmp/v-chain.txt | sort | uniq -c
```

Esperado: la celda de impacto tiene **una sola caja** (mismo `wxh`) en «Calculating…» y en la nota asentada (antes: `124x64.5` y `131.5x77.5`); la rejilla `stats` una sola caja `264x125.9` en el héroe vivo (antes `249x112.9` → `264x125.9`); `orcidSkel` una sola `y` hasta que la tarjeta viva la sustituye (antes `267.6` y `277.9`). Si el autor elegido tenía la nota en caché (la celda ya nace asentada), repetir con otro `idx`.

- [ ] **Step 3: Autor frío — un settle menos**

```bash
grep -o 'settle":"[^@]*@0"' /tmp/v-chain.txt | sort | uniq -c
```

Esperado: dos settles (esqueleto → héroe, y la llegada del ORCID), no tres; el intermedio de ~10 px (`227.625px>237.938px` en la auditoría) ya no existe.

- [ ] **Step 4: Institución fría — el velo no escala**

```bash
node scripts/diagnostics/explorer-glitch-frames.mjs route '#/explorer/institution/I136199984' 7000 out=/tmp/v-inst > /tmp/v-inst.txt
grep -o 'wash":"[^"]*"' /tmp/v-inst.txt | awk -F'[ x/]' '{print $3}' | uniq | wc -l
```

La sonda mide el contenedor, que ahora es el héroe, así que ese número seguirá siendo > 1 — lo que se comprueba es la imagen. Recortar dos fotogramas, uno al montar el velo y otro en reposo (los nombres del `frames:` al final de `/tmp/v-inst.txt`; el primero con el velo es el fotograma cuyo `t` coincide con la primera línea `wash":"…/0.0` del muestreador):

```bash
sips --cropToHeightWidth 300 1280 --cropOffset 0 0 /tmp/v-inst/<primer-fotograma-con-velo>.png --out /tmp/v-inst-a.png
sips --cropToHeightWidth 300 1280 --cropOffset 0 0 /tmp/v-inst/<último-fotograma>.png --out /tmp/v-inst-b.png
```

Esperado: el escudo desenfocado tiene el mismo tamaño y posición en los dos recortes (antes crecía un 54 %). Además, en el preview con sesión y la página en reposo, la comprobación de `getComputedStyle(el, '::before')` de Task 4 step 6 da `top: -96px; height: 720px`.

- [ ] **Step 5: Coste de pintado del velo, antes y después (opcional pero barato)**

Con la receta de `explorer-loading-probe.mjs` (`Tracing.start` con `devtools.timeline` y contar `RasterTask`), o con el panel Performance de DevTools sobre `http://localhost:5174/#/explorer/institution/I136199984`: contar los `RasterTask` entre el montaje del velo y el reposo. Esperado: del orden de una rasterización de la capa del velo, no 21. Anotar el número en el «Después».

- [ ] **Step 6: Escribir el «Después» en la auditoría**

Añadir al final de `docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md`:

```markdown
## 7. Después (<fecha>)

Mismas sondas, misma build de producción con sesión real, sobre `<commit>`.

| Medida | Antes | Después |
|---|---|---|
| Celda de impacto, «Calculating…» → asentada | 124×64,5 → 131,5×77,5 | <una sola caja> |
| Rejilla, héroe vivo | 249×112,9 → 264×125,9 | <una sola caja> |
| Tarjeta ORCID (esqueleto) al asentarse la nota | y +10,3 px en un fotograma | <sin cambio de y> |
| Settles del autor frío | 3 | <2> |
| Rejilla del esqueleto frente a la viva | 189×101 en x=963 / 264×125,9 en x=888 | <264×~126 en x=888 en los dos> |
| Alturas distintas de la imagen del velo durante su fundido | 21 (374 → 576 px) | <1: caja fija de 720 px> |

<Lo que no mejoró, si algo.>
```

Rellenar cada `<…>` con el número medido; no dejar ninguno.

- [ ] **Step 7: Commit**

El registro de la auditoría y el plan que lo ejecuta viajan con la rama, como
`docs(plan): el plan del cambio de seguimiento viaja con la rama que lo ejecuta`
(5b546e8). Los dos entran en este commit y ninguno antes: hasta aquí el registro
no tenía sus números de después.

```bash
git add docs/AUDITORIA-GLITCHES-EXPLORER-2026-09-09.md docs/superpowers/plans/2026-09-09-explorer-glitches-institucion-autor.md
git commit -m "docs(animaciones): los números de después de los tres glitches del Explorer, y el plan que los arregló

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Fuera del plan, a decidir

Dos cosas observadas en la cadena institución → autor que son decisiones de diseño vigentes y no defectos, con su alternativa en la auditoría §5: la superposición de dos héroes del Explorer durante los 300 ms de la transición, y el barrido del settle sobre el panel de experiencia. Ninguna tarea de este plan las toca.
