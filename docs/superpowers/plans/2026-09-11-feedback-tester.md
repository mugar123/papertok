# Feedback del tester (2026-09-11) — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los once puntos accionables del feedback de un tester externo (PDF del 11-09-2026) sin cambiar decisiones de producto ya tomadas.

**Architecture:** Once tareas independientes sobre código existente; ninguna toca `firestore.rules` ni el Worker. Las tres con más riesgo (Atrás, contador de comentarios, transición entre papers) llevan un paso de medida antes del cambio y un criterio de abandono. Los tests siguen la convención de tests de fuente del repo (`stripComments` + regex, ver `src/components/Feed/readButton.test.js`) salvo donde hay lógica pura que probar de verdad.

**Tech Stack:** React 18 + Vite, react-router (HashRouter), Base UI (diálogos y drawer), CSS View Transitions (tema), `node --test`.

**Spec:** No hay spec aparte. La auditoría y las decisiones están en la sección siguiente; el PDF original es `~/Downloads/5cd7f016-4578-4618-9d63-d4dfe378f6a1.PDF`.

## Auditoría y decisiones (de la conversación del 11-09)

| # | Punto del tester | Veredicto | Decisión |
|---|---|---|---|
| 1 | Márgenes del onboarding mal, «TO BEGIN» recortado | Confirmado: `initialFocus` en el primer chip desplaza la hoja, que es su propio contenedor de scroll | Tarea 4 |
| 2 | Hueco barra–tarjeta grande e inconsistente | Es el anclaje abajo de `.pc-sheet`, intencional | **No tocar** (Nicolás, 11-09) |
| 3 | Atrás sale de PaperTok | Confirmado: lector y visor PDF son estado local, no empujan historial | Tarea 10 |
| 4 | Icono del ojo confuso («Read article») | Confirmado: es «marcar como leído», la etiqueta describe una acción | Tarea 2 |
| 5 | Skip no hace nada | Parcial: `markNotInterested` devuelve sin hacer nada para invitados | Tarea 3 |
| 6 | Save abre un popup | Decisión de producto: se queda; solo la copia «Read later» | Tarea 1 |
| 7 | Cuántos comentarios tiene el paper | Confirmado ausente | Tarea 9 |
| 8 | Transición entre papers más suave | Scroll-snap nativo + animaciones de montaje | Tarea 11 |
| 9 | Research: idiomas raros, nombre confuso | Confirmado: OpenAlex sin `language:`; el nombre se mantiene | Tarea 5 |
| 10 | Grafo descentrado y se sale por abajo | La tarjeta inferior se ancla bajo el sangrado; lo demás hay que medirlo | Tarea 7 |
| 11 | Refrescar For you | Confirmado: `refreshFeed` existe y solo lo usan los botones de error | Tarea 8 |
| 12 | «Open source» confuso | Confirmado en el fallback de la tarjeta; la tarjeta de GitHub en Ajustes es correcta y se queda | Tarea 1 |
| 13 | Credenciales institucionales | Fuera de alcance | Backlog |
| 14 | Renderizar el HTML de arXiv como lector | Fuera de alcance; el Worker ya raspa ese HTML para las figuras | Backlog |
| 15 | Animación del modo oscuro torpe | Barrido de 420 ms con View Transitions | Tarea 6 |

## Global Constraints

- Copia bilingüe inline (objetos `isEnglish ? … : …` o `copy.x[mode]`); no hay fichero i18n.
- Ningún cambio en `firestore.rules`, en `worker/` ni en `wrangler.toml`.
- Trabajar en un worktree nuevo desde `main` (la rama `fix/auditoria-general-2026-09-10` tiene cambios sin commitear de otra sesión): rama `fix/feedback-tester-2026-09-11`. Copiar `.env` a mano al worktree (ver memoria `papertok-worktree-env-trap`).
- Un commit por tarea, mensaje en español con el prefijo `fix(área):` o `feat(área):`.
- `npm test` en verde antes de cada commit. CI corre Node 22.
- Toda medida en vivo con el pane oculto o sin layout es inválida: usar el arnés CDP de `scripts/diagnostics/` con la cuenta demo (memoria `papertok-cdp-verify-when-pane-hidden`).

---

### Task 1: Copia — «Read later» y «Source»

**Files:**
- Modify: `src/components/Lists/SaveToListModal.jsx:609-612`, `:641-644`, `:720-723`
- Modify: `src/components/Feed/PaperCard.jsx:1054`, `:1738`
- Test: `src/components/Lists/saveModalCopy.test.js` (crear)

- [ ] **Step 1: Test de fuente que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: la fila de Read later dice solo «Read later», sin subtítulo', async () => {
  const src = strip(await read('./SaveToListModal.jsx'));
  assert.match(src, /readLaterOn: 'Read later'/);
  assert.match(src, /readLaterOff: 'Read later'/);
  assert.match(src, /readLaterOn: 'Leer después'/);
  assert.doesNotMatch(src, /readLaterOnHint|readLaterOffHint/, 'los hints han desaparecido con su render');
});

test('SOURCE: la tarjeta no dice «Open source»', async () => {
  const src = strip(await read('../Feed/PaperCard.jsx'));
  assert.doesNotMatch(src, /'Open source'|'Abrir fuente'/);
  assert.match(src, /'Source'/);
});
```

- [ ] **Step 2: Correr y ver fallar**: `node --test src/components/Lists/saveModalCopy.test.js` → FAIL (los hints existen).
- [ ] **Step 3: Cambiar la copia.** En `SaveToListModal.jsx` dejar `readLaterOn: 'Read later'`, `readLaterOff: 'Read later'` (ES: `'Leer después'` ambos), borrar las cuatro claves `*Hint` y el `<p>`/`<span>` del subtítulo en la línea 723. El estado marcado/no marcado lo sigue dando el checkbox, no el texto. En `PaperCard.jsx:1054` y `:1738` sustituir `'Open source'` → `'Source'` y `'Abrir fuente'` → `'Fuente'`.
- [ ] **Step 4: Correr**: `node --test src/components/Lists/saveModalCopy.test.js` → PASS; `npm test` → verde.
- [ ] **Step 5: Commit**: `git commit -m "fix(copia): Read later sin subtítulo y Source en vez de Open source"`

---

### Task 2: El ojo describe estado, no acción

**Files:**
- Modify: `src/components/Feed/PaperCard.jsx:1729-1740`
- Test: `src/components/Feed/readButton.test.js` (añadir un caso)

- [ ] **Step 1: Test que falla** (añadir al final de `readButton.test.js`, reutiliza `read`/`stripComments` del fichero):

```js
test('SOURCE: la etiqueta del ojo es «Mark as read»/«Read», nunca la acción de abrir', async () => {
  const card = stripComments(await read('./PaperCard.jsx'));
  const slot = card.slice(card.indexOf('pc-side-btn--seen'), card.indexOf('pc-side-btn--skip'));
  assert.doesNotMatch(slot, /Read article|Open version|Open source|Leer artículo|Versión abierta/);
  assert.match(slot, /isReadActive\s*\?\s*\(isEnglish \? 'Read' : 'Leído'\)\s*:\s*\(isEnglish \? 'Mark as read' : 'Marcar leído'\)/);
});
```

- [ ] **Step 2: Ver fallar**: `node --test src/components/Feed/readButton.test.js`.
- [ ] **Step 3: Sustituir el ternario de las líneas 1729-1740** por:

```jsx
<span className="pc-side-label">
  {isReadActive
    ? (isEnglish ? 'Read' : 'Leído')
    : (isEnglish ? 'Mark as read' : 'Marcar leído')}
</span>
```

Si `resolvedOpenCopy` o `paper.openAccessPdfUrl` dejan de usarse en este bloque y en ningún otro, borrar la variable; si se usan en el botón primario (`handleOpenPaper`, `:1603`), dejarla.

- [ ] **Step 4: Correr** `npm test` → verde.
- [ ] **Step 5: Commit**: `git commit -m "fix(tarjeta): el ojo dice «marcar como leído», no «leer artículo»"`

---

### Task 3: Skip funciona para invitados

**Files:**
- Modify: `src/context/FeedContext.jsx:1815-1861` (`markNotInterested`)
- Test: `src/context/feedSkipGuest.test.js` (crear)

**Interfaces:** ninguna nueva. La parte local (quitar el paper de `papers`, `setNotInterestedIds`, cooldown y re-rank anclado al sucesor) corre siempre; solo la escritura en Firestore y el ajuste de afinidades persistido quedan tras `if (userId)`.

- [ ] **Step 1: Test de fuente que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: markNotInterested quita el paper también sin sesión', async () => {
  const ctx = strip(await read('./FeedContext.jsx'));
  const body = ctx.slice(ctx.indexOf('const markNotInterested = useCallback('), ctx.indexOf('const markNotInterested = useCallback(') + 3000);
  assert.doesNotMatch(body, /if \(!userId\) return;/, 'la puerta de invitado ya no corta la parte local');
  assert.match(body, /if \(userId\) \{[\s\S]*?(setDoc|updateDoc|writeInteraction)/, 'la escritura queda tras la puerta');
});
```

- [ ] **Step 2: Ver fallar**: `node --test src/context/feedSkipGuest.test.js`.
- [ ] **Step 3: Reordenar.** Leer `markNotInterested` entero (1815-1861). Borrar `if (!userId) return;` (línea 1818). Envolver en `if (userId) { … }` únicamente las llamadas que escriben en Firestore (la interacción `notInterested` y cualquier `increment`/afinidad persistida). Lo que solo toca estado en memoria (`setNotInterestedIds`, `setPapers`, cooldown, re-rank) queda fuera de la puerta. Si el nombre de la función de escritura no coincide con el regex del test, ajustar el regex al nombre real, no al revés.
- [ ] **Step 4: Correr** `npm test` → verde. Comprobar en vivo como invitado (`localhost:5173/#/` sin sesión) que Skip retira la tarjeta.
- [ ] **Step 5: Commit**: `git commit -m "fix(feed): Skip retira el paper también para invitados"`

---

### Task 4: El onboarding abre arriba del todo

**Files:**
- Modify: `src/components/Public/GuestInterestsPrompt.jsx:99-108`
- Test: `src/components/Public/overlayDialogs.test.js` (añadir un caso)

- [ ] **Step 1: Test que falla** (usar los helpers del fichero):

```js
test('SOURCE: el onboarding enfoca el título, no el primer chip', async () => {
  const src = strip(await read('./GuestInterestsPrompt.jsx'));
  assert.match(src, /initialFocus=\{titleRef\}/);
  assert.match(src, /<DialogTitle[^>]*ref=\{titleRef\}[^>]*tabIndex=\{-1\}/);
  assert.doesNotMatch(src, /initialFocus=\{firstAreaRef\}/);
});
```

- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Cambiar el foco inicial.** Añadir `const titleRef = useRef(null)`; en `<DialogTitle>` poner `ref={titleRef} tabIndex={-1}`; `initialFocus={titleRef}`. El título está en la parte alta de la hoja, así que enfocarlo no desplaza el scroll y el lector de pantalla anuncia el título. Si `firstAreaRef` deja de usarse, borrarlo. Añadir en `GuestInterestsPrompt.css` `.gip-title:focus-visible { outline: none; }` (el foco programático no debe pintar anillo).
- [ ] **Step 4: Verificar en vivo** con sesión de invitado en móvil emulado (375×812): abrir, comprobar `document.querySelector('.gip').scrollTop === 0` y que «TO BEGIN» se ve entero.
- [ ] **Step 5: Commit**: `git commit -m "fix(onboarding): la hoja abre sin desplazarse al primer chip"`

---

### Task 5: Research filtra por idioma y se explica

**Files:**
- Modify: `src/services/scientificReportService.js:288`
- Modify: `src/components/Report/ScientificReport.jsx` (bajo el `<h1>Research</h1>`)
- Test: `src/services/scientificReportService.test.js` (añadir un caso)

- [ ] **Step 1: Test que falla**

```js
test('SOURCE: la consulta a OpenAlex pide solo inglés', async () => {
  const src = strip(await read('./scientificReportService.js'));
  assert.match(src, /type:article,has_doi:true,language:en\$\{countryFilter\}/);
});
```

- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Cambiar el filtro** en la línea 288: `…type:article,has_doi:true,language:en${countryFilter}`. Añadir bajo el título de la página una línea `<p className="report-lede">` con `isEnglish ? 'The most cited papers of the period, by field and country.' : 'Los papers más citados del periodo, por campo y país.'` usando el mismo hook de idioma que ya usa el componente. Estilo: `color: var(--text-muted); font-size: 0.9rem; margin: 0 0 var(--space-4);`.
- [ ] **Step 4: Correr** `npm test`; abrir `/#/research` con el periodo «30 days» y comprobar que no aparecen títulos en cirílico.
- [ ] **Step 5: Commit**: `git commit -m "fix(research): OpenAlex solo en inglés y una línea que explica la página"`

---

### Task 6: Modo oscuro más corto

**Files:**
- Modify: `src/styles/global.css:309`, `:318`
- Test: `src/utils/themeTransition.test.js` (añadir un caso de fuente)

- [ ] **Step 1: Test que falla**

```js
test('SOURCE: el barrido del tema dura 260/200 ms', async () => {
  const css = await readFile(new URL('../styles/global.css', import.meta.url), 'utf8');
  assert.match(css, /animation: themeSweepIn 260ms/);
  assert.match(css, /animation: themeSweepOut 200ms/);
});
```

- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Cambiar** `420ms` → `260ms` (línea 309) y `320ms` → `200ms` (línea 318). Las curvas se quedan.
- [ ] **Step 4: Medir** con el arnés CDP: alternar el tema y leer `document.getAnimations().map(a => [a.animationName, a.effect.getTiming().duration])` durante la transición; esperar `260`/`200`. Comprobar a ojo en escritorio que el botón no se congela a mitad (View Transitions captura una instantánea; con 260 ms la congelación debe ser imperceptible).
- [ ] **Step 5: Commit**: `git commit -m "fix(tema): barrido del modo oscuro de 420 a 260 ms"`

---

### Task 7: El grafo cabe en su hoja

**Files:**
- Modify: `src/components/Feed/PaperCard.css:1888-1893` (`.graph-peek`), quizá `:1332-1352` (`.related-sheet`)
- Test: `src/components/Feed/graphStyles.test.js` (añadir un caso)

- [ ] **Step 1: Medir antes de tocar.** Con el arnés CDP en escritorio (1280×800), abrir «Paper connections» de un paper de la demo (receta en la memoria `papertok-citation-map-centre-settle`) y anotar:

```js
const s = document.querySelector('.related-sheet').getBoundingClientRect();
const p = document.querySelector('.graph-peek')?.getBoundingClientRect();
({ sheet: [s.left, s.right, s.bottom], peekBottom: p?.bottom, vh: innerHeight, vw: innerWidth })
```

Hipótesis: `peekBottom > innerHeight` (unos 18 px), y `s.left + s.right !== innerWidth` si la hoja está descentrada.

- [ ] **Step 2: Test que falla**

```js
test('SOURCE: la tarjeta inferior del grafo se ancla al borde visible, no al sangrado', async () => {
  const css = strip(await read('./PaperCard.css'));
  const peek = css.slice(css.indexOf('.graph-peek {'), css.indexOf('.graph-peek {') + 400);
  assert.match(peek, /bottom: calc\(var\(--graph-source-height\) \+ var\(--inset-bottom\) \+ var\(--bleed\)\)/);
});
```

- [ ] **Step 3: Arreglar.** En `.graph-peek`: `bottom: calc(var(--graph-source-height) + var(--inset-bottom) + var(--bleed));`. El `padding-bottom` de `.related-sheet` ya mete `--bleed` (48 px) por debajo del viewport; la posición absoluta se mide contra la caja de padding, así que sin sumar el sangrado la tarjeta cae bajo el borde. Si en el paso 1 la hoja estaba descentrada, añadir a `.related-sheet` `margin-inline: auto;` y comprobar que el `Drawer` de `ui/drawer.css` no la posiciona con `left: 0` fijo.
- [ ] **Step 4: Volver a medir** (mismo snippet): `peekBottom <= innerHeight - 8` y hoja centrada. `npm test` verde.
- [ ] **Step 5: Commit**: `git commit -m "fix(grafo): la tarjeta inferior deja de caer bajo el sangrado de la hoja"`

---

### Task 8: Refrescar For you

**Files:**
- Modify: `src/components/Feed/FeedContainer.jsx:134-135`, `:382-384`, `:395-421`, `:487`
- Modify: `src/components/Feed/FeedContainer.css`
- Test: `src/components/Feed/feedRefresh.test.js` (crear)

**Interfaces:**
- Produces: estado `activeIndex` en `FeedContainer` y prop `isActive` en `<PaperCard>` (la Tarea 9 y la 11 la consumen).

- [ ] **Step 1: Test de fuente que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

test('SOURCE: el feed expone un refresco visible en el primer paper y por arrastre', async () => {
  const src = strip(await read('./FeedContainer.jsx'));
  assert.match(src, /className="feed-refresh"[\s\S]{0,200}onClick=\{handleRefresh\}/);
  assert.match(src, /onTouchStart=\{handleTouchStart\}[\s\S]*onTouchEnd=\{handleTouchEnd\}/);
  assert.match(src, /setActiveIndex\(index\)/);
  assert.match(src, /isActive=\{index === activeIndex\}/);
});
```

- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Implementar.** En `FeedContainer.jsx`:

```jsx
const [activeIndex, setActiveIndex] = useState(0);
const pullStartY = useRef(null);
// en handleScroll, tras calcular `index`:
setActiveIndex(index);           // React descarta el set si no cambia
// handlers de arrastre (solo dedo: con ratón no hay touch):
const handleTouchStart = useCallback((e) => {
  pullStartY.current = e.currentTarget.scrollTop === 0 ? e.touches[0].clientY : null;
}, []);
const handleTouchEnd = useCallback((e) => {
  if (pullStartY.current === null) return;
  const dy = e.changedTouches[0].clientY - pullStartY.current;
  pullStartY.current = null;
  if (dy > 90 && !loading) handleRefresh();
}, [handleRefresh, loading]);
```

En el JSX, sobre el scroller (dentro de `.feed-wrapper`):

```jsx
{activeIndex === 0 && papers.length > 0 && !loading && (
  <button type="button" className="feed-refresh" onClick={handleRefresh}>
    <RefreshCw size={14} aria-hidden="true" />
    {isEnglish ? 'Refresh' : 'Actualizar'}
  </button>
)}
<div className="feed-container" ref={feedRef} onScroll={handleScroll}
     onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
```

Y en el map de tarjetas `isActive={index === activeIndex}`. `isEnglish` sale del mismo hook de idioma que usa `PaperCard.jsx` (`grep -n isEnglish src/components/Feed/PaperCard.jsx | head -1`). `RefreshCw` viene de `lucide-react`.

CSS en `FeedContainer.css`:

```css
.feed-refresh {
  position: absolute; top: calc(var(--nav-total) + 12px); left: 50%;
  translate: -50% 0; z-index: 5;
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; border-radius: 999px;
  background: var(--bg-card); color: var(--text-primary);
  border: 1px solid var(--border-default); box-shadow: var(--shadow-md);
  font-size: 0.8rem; opacity: 0.9;
}
.feed-refresh:hover { opacity: 1; }
```

`.feed-wrapper` necesita `position: relative` si no lo tiene. `translate`, no `transform` (memoria `papertok-transform-centering-vs-arrival`).

- [ ] **Step 4: Verificar.** `npm test` verde. En vivo con la demo: la píldora se ve en el primer paper, desaparece al bajar, y pulsarla cambia los papers (`refreshFeed` usa `randomizeStart`). En móvil emulado, arrastrar 100 px hacia abajo en el primer paper refresca.
- [ ] **Step 5: Commit**: `git commit -m "feat(feed): botón de refresco y tirar hacia abajo en For you"`

---

### Task 9: Contador de comentarios en la tarjeta

**Files:**
- Create: `src/hooks/useCommentCount.js`
- Modify: `src/components/Feed/PaperCard.jsx:1686-1697` (botón Comments) y la lista de props
- Modify: `src/components/Feed/CommentsSheet.jsx` (tras `createComment`/`deleteComment`)
- Test: `src/hooks/commentCount.test.js` (crear)

**Interfaces:**
- Consumes: `isActive` (Tarea 8); `localThreadKeys(paper)` de `src/services/threadAnchorClient.js:139`; `fetchCommentCount(paperKey, overrides)` de `src/services/commentService.js:299` (overrides acepta `countThread(database, key)`).
- Produces: `loadCommentCount(paper, overrides) → Promise<number>`, `forgetCommentCount(paperId)`, `useCommentCount(paper, enabled) → number | null`.

Diseño: el Worker no puede servir esto (su KV de hilos no está enlazado, `wrangler.toml:88-91`, y cada fallo de caché consume la cuota global de 120/min). Se cuenta por cliente con `count()` (una lectura por clave, hasta cuatro claves locales), solo cuando la tarjeta es la activa y el usuario puede abrir comentarios, con caché de módulo por `paper.id` para toda la sesión.

- [ ] **Step 1: Test que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCommentCount, forgetCommentCount } from './useCommentCount.js';

const paper = { id: 'doi:10.1/x', doi: '10.1/x' };

test('suma las claves locales y cachea por paper', async () => {
  let calls = 0;
  const countThread = async () => { calls += 1; return 2; };
  const first = await loadCommentCount(paper, { countThread, database: {} });
  const again = await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(first >= 2);
  assert.equal(again, first);
  const seen = calls;
  assert.ok(seen >= 1);
  forgetCommentCount(paper.id);
  await loadCommentCount(paper, { countThread, database: {} });
  assert.ok(calls > seen, 'olvidar vuelve a contar');
});

test('un fallo de lectura devuelve null y no envenena la caché', async () => {
  forgetCommentCount(paper.id);
  const countThread = async () => { throw new Error('unavailable'); };
  assert.equal(await loadCommentCount(paper, { countThread, database: {} }), null);
  let ok = 0;
  await loadCommentCount(paper, { countThread: async () => { ok += 1; return 1; }, database: {} });
  assert.ok(ok >= 1);
});
```

- [ ] **Step 2: Ver fallar**: `node --test src/hooks/commentCount.test.js` → módulo inexistente.
- [ ] **Step 3: Implementar** `src/hooks/useCommentCount.js`:

```js
import { useEffect, useState } from 'react';
import { fetchCommentCount } from '../services/commentService.js';
import { localThreadKeys } from '../services/threadAnchorClient.js';

const cache = new Map();      // paper.id → number
const inflight = new Map();   // paper.id → Promise<number|null>

export function forgetCommentCount(paperId) { cache.delete(paperId); inflight.delete(paperId); }

export async function loadCommentCount(paper, overrides) {
  if (!paper?.id) return null;
  if (cache.has(paper.id)) return cache.get(paper.id);
  if (inflight.has(paper.id)) return inflight.get(paper.id);
  const keys = localThreadKeys(paper);
  const job = Promise.all(keys.map(key => fetchCommentCount(key, overrides)))
    .then(results => {
      const total = results.reduce((sum, r) => sum + (r?.count ?? 0), 0);
      cache.set(paper.id, total);
      return total;
    })
    .catch(() => null)
    .finally(() => inflight.delete(paper.id));
  inflight.set(paper.id, job);
  return job;
}

export function useCommentCount(paper, enabled) {
  const [count, setCount] = useState(() => (paper?.id && cache.has(paper.id) ? cache.get(paper.id) : null));
  useEffect(() => {
    if (!enabled || !paper?.id) return undefined;
    let alive = true;
    loadCommentCount(paper).then(value => { if (alive && value !== null) setCount(value); });
    return () => { alive = false; };
  }, [enabled, paper?.id]);
  return count;
}
```

Comprobar que `fetchCommentCount` sin overrides resuelve `database` por defecto (`operations(undefined)` en `commentService.js`); si `requireSupported` lanza en invitado, el `catch` lo absorbe.

- [ ] **Step 4: Pintar el número.** En `PaperCard.jsx`, aceptar la prop `isActive` y:

```jsx
const commentCount = useCommentCount(paper, Boolean(isActive && canOpenComments));
…
<span className="pc-side-label">
  {commentCount > 0 ? commentCount : (isEnglish ? 'Comments' : 'Comentarios')}
</span>
```

En `CommentsSheet.jsx`, tras un `createComment` o `deleteComment` con éxito, `forgetCommentCount(paper.id)`. Comprobar también las otras superficies que montan `<PaperCard>` (`grep -rn "<PaperCard" src/`): sin `isActive` el contador queda apagado, que es el comportamiento deseado fuera del feed.

- [ ] **Step 5: Verificar.** `npm test` verde. En vivo con la demo: en un paper con comentarios el botón muestra el número; en la pestaña Network solo aparecen consultas `runAggregationQuery` para la tarjeta activa, ninguna para las de abajo.
- [ ] **Step 6: Commit**: `git commit -m "feat(tarjeta): número de comentarios en el botón de la tarjeta activa"`

---

### Task 10: Atrás cierra el lector y el PDF en vez de salir de PaperTok

**Files:**
- Create: `src/hooks/useOverlayHistory.js`
- Modify: `src/components/Feed/PaperCard.jsx:311`, `:1846-1856`
- Modify: `src/App.jsx:69`, `:499-502`
- Modify: `src/components/Explorer/EntityExplorer.jsx:219`, `:2622` (visor PDF propio)
- Test: `src/hooks/overlayHistory.test.js` (crear)

**Interfaces:**
- Produces: `createOverlayHistory({ history, listen, unlisten })` → `{ arm(tag, onClose), disarm() }`; `useOverlayHistory(open, onClose, tag)`.

Diseño: al abrir, `pushState` clonando el `history.state` de react-router (conserva `usr`, `key`, `idx`; `routeDirection.js` y `usePageTransitionCustom.js` leen `idx`) más `overlay: tag`. Atrás dispara `popstate` → `onClose`. Si el usuario cierra con la X, se hace `history.back()` para no dejar la entrada fantasma. HashRouter no navega porque la URL no cambia.

- [ ] **Step 1: Test que falla**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayHistory } from './useOverlayHistory.js';

function fakeHistory(initial = { idx: 3, key: 'k' }) {
  const stack = [initial]; const listeners = new Set();
  return {
    history: {
      get state() { return stack[stack.length - 1]; },
      pushState(state) { stack.push(state); },
      back() { stack.pop(); listeners.forEach(fn => fn()); },
    },
    listen: (fn) => listeners.add(fn), unlisten: (fn) => listeners.delete(fn),
    stack,
  };
}

test('abrir empuja una entrada que conserva idx y key; atrás cierra', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  ctl.arm('reader', () => { closed += 1; });
  assert.deepEqual(f.stack.at(-1), { idx: 3, key: 'k', overlay: 'reader' });
  f.history.back();
  assert.equal(closed, 1);
  assert.equal(f.stack.length, 1);
});

test('cerrar con la X retira la entrada sin cerrar dos veces', () => {
  const f = fakeHistory(); let closed = 0;
  const ctl = createOverlayHistory(f);
  ctl.arm('pdf', () => { closed += 1; });
  ctl.disarm();
  assert.equal(f.stack.length, 1);
  assert.equal(closed, 0);
});
```

- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Implementar** `src/hooks/useOverlayHistory.js`:

```js
import { useEffect, useRef } from 'react';

export function createOverlayHistory({ history, listen, unlisten }) {
  let armed = null;
  const onPop = () => {
    if (!armed) return;
    const { onClose } = armed; armed = null; unlisten(onPop);
    onClose();
  };
  return {
    arm(tag, onClose) {
      if (armed) return;
      history.pushState({ ...(history.state || {}), overlay: tag }, '', typeof location !== 'undefined' ? location.href : undefined);
      armed = { tag, onClose };
      listen(onPop);
    },
    disarm() {
      if (!armed) return;
      const { tag } = armed; armed = null; unlisten(onPop);
      if (history.state?.overlay === tag) history.back();
    },
  };
}

export function useOverlayHistory(open, onClose, tag) {
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const ctlRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    if (!ctlRef.current) {
      ctlRef.current = createOverlayHistory({
        history: window.history,
        listen: (fn) => window.addEventListener('popstate', fn),
        unlisten: (fn) => window.removeEventListener('popstate', fn),
      });
    }
    const ctl = ctlRef.current;
    ctl.arm(tag, () => closeRef.current());
    return () => ctl.disarm();
  }, [open, tag]);
}
```

- [ ] **Step 4: Enganchar.** `PaperCard.jsx`: `useOverlayHistory(showReader, () => setShowReader(false), 'reader')` junto al estado de la línea 311. `App.jsx`: `useOverlayHistory(Boolean(pdfPaper), () => setPdfPaper(null), 'pdf')`. `EntityExplorer.jsx`: lo mismo con `pdfPaperToView`. Ojo con el `openPdf` de `App.jsx:77-89`: en puntero grueso abre pestaña nueva y no toca el estado, así que no arma nada, correcto.
- [ ] **Step 5: Sondar la transición de página.** Con el arnés CDP en la demo: abrir el lector, pulsar Atrás, y leer `document.querySelector('[data-page-transition]')?.getAnimations().length` (o el selector real de `PageTransition.jsx`) inmediatamente después. Esperado: `0` y el lector cerrado, con la URL intacta. Si se dispara una transición, añadir en `usePageTransitionCustom.js` una salida temprana cuando `location.key` no ha cambiado respecto al render anterior (guardar la clave previa en un ref) y volver a medir. Comprobar también que Atrás desde el feed sin nada abierto sigue saliendo del sitio (una sola pulsación), y que abrir y cerrar el lector con la X tres veces no acumula entradas (`history.length` no crece).
- [ ] **Step 6: Commit**: `git commit -m "fix(navegación): Atrás cierra el lector y el visor PDF en vez de salir de PaperTok"`

---

### Task 11: La entrada del paper siguiente se ve

**Files:**
- Modify: `src/components/Feed/PaperCard.css:48-53`, `:279-339`
- Modify: `src/components/Feed/PaperCard.jsx` (raíz `.pc`: `data-active`)
- Test: `src/components/Feed/paperCardArrival.test.js` (actualizar)

**Interfaces:** Consumes `isActive` (Tarea 8).

Diseño: hoy `cardSlideUp` (0.36 s) y `pcArrive` (escalonado 45 ms) corren al montar, y las tarjetas se montan fuera de pantalla al paginar; cuando el usuario llega, la animación ya pasó y el cambio es un corte del snap. Se ata la entrada al paso a activa. El snap en sí (`scroll-snap-stop: always`) no se toca: es lo que evita saltarse papers.

- [ ] **Step 1: Medir antes.** Con el arnés de fotogramas (`scripts/diagnostics/`, ver `project-badge-frames.mjs` como modelo) grabar un cambio de paper con la rueda en la demo y comprobar en el fotograma en que la tarjeta nueva ocupa el viewport si `pcArrive` está corriendo (`getAnimations()` sobre `.pc-title` de esa tarjeta). Hipótesis: no corre (ya terminó al montar). Si corre, saltar al paso 5 y solo acortar el escalonado a 30 ms.
- [ ] **Step 2: Test que falla** (en `paperCardArrival.test.js`, con sus helpers):

```js
test('SOURCE: la llegada de los bloques se dispara al volverse activa la tarjeta, no al montar', async () => {
  const css = strip(await read('./PaperCard.css'));
  assert.match(css, /\.pc\[data-active="true"\] \.pc-title/);
  assert.doesNotMatch(css.slice(css.indexOf('.pc-sheet {'), css.indexOf('.pc-sheet {') + 600), /animation: cardSlideUp/);
  const jsx = strip(await read('./PaperCard.jsx'));
  assert.match(jsx, /data-active=\{isActive \? 'true' : 'false'\}/);
});
```

- [ ] **Step 3: Implementar.** En `PaperCard.jsx` poner `data-active={isActive ? 'true' : 'false'}` en la raíz `.pc`. En `PaperCard.css`: quitar `animation: cardSlideUp …` de `.pc-sheet` (línea 53) y cambiar los selectores de la línea 296-306 de `.pc-title, .pc-meta, …` a `.pc[data-active="true"] .pc-title, .pc[data-active="true"] .pc-meta, …` con `animation: pcArrive 0.28s cubic-bezier(0.16, 1, 0.3, 1) calc(var(--arrive, 0) * 35ms) backwards`. Mantener la supresión con `[data-nav-direction="-1"]` (318-329). Las tarjetas no activas quedan en su estado final (sin `opacity: 0`), así una tarjeta que se ve a medias durante el arrastre no está vacía. Superficies fuera del feed que montan `<PaperCard>` sin `isActive`: pasarles `isActive` (por ejemplo `PublicPaperPage`) para que la entrada siga existiendo allí.
- [ ] **Step 4: Medir después** con el mismo arnés: en el fotograma de llegada `pcArrive` corre en la tarjeta nueva y la anterior no anima. Sin cambios en el tiempo de scroll del snap.
- [ ] **Step 5: Correr** `npm test` (ajustar `paperCardArrival.test.js` si alguna aserción antigua exigía el `cardSlideUp` de montaje).
- [ ] **Step 6: Commit**: `git commit -m "fix(feed): la entrada del paper corre al volverse activo, no al montar"`

---

## Orden y cierre

1. Tareas 1–6 son independientes y baratas; van primero.
2. Tarea 8 antes que 9 y 11 (ambas consumen `isActive`).
3. Tareas 7 y 10 llevan sonda; si el paso de medida contradice la hipótesis, parar y anotar la medida en el PR en vez de forzar el arreglo.
4. Al terminar: `npm run check`, PR contra `main` con la tabla de auditoría de arriba en la descripción, y anotar en el PR los dos puntos de backlog (credenciales institucionales, lector HTML de arXiv).
