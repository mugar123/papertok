# Optimización móvil — Plan de implementación

> **Para agentes:** los pasos usan casillas (`- [ ]`). Ejecutar tarea a tarea,
> con `npm test` entre tareas. Spec: `docs/superpowers/specs/2026-08-28-auditoria-movil.md`.

**Objetivo:** que la app deje de sentirse pesada en móvil — empezando por el
cambio claro/oscuro, siguiendo por el coste en reposo y al hacer scroll, y
terminando por el arranque y la revisita.

**Arquitectura:** cuatro frentes independientes por orden de valor percibido:
(0) el barrido de tema se sustituye en puntero grueso por un crossfade
compuesto de 160 ms y el fallback sin View Transitions pasa a cambio
instantáneo; (1) una tanda de arreglos CSS de líneas sueltas (safe areas,
`vh`→`dvh`, blur animado, `transition: all`); (2) el runtime del feed —
re-ranking O(N²), providers sin memoizar, imágenes sin acotar; (3) arranque y
revisita — lector fuera del grafo eager, fuentes autoalojadas, service worker.

**Stack:** Vite 8 + React 19, framer-motion, `node --test`. Despliegue web por
CI a GH Pages (un push basta); el Worker no se toca en este plan.

## Restricciones globales

- **No tocar diseño visual en desktop**: el barrido de tinta se queda tal cual
  con puntero fino; los cambios de animación solo alteran móvil o casos
  degenerados (fallback, reduced motion).
- **Proteger lo que ya está bien**: cero listeners de scroll/touch (el snap es
  CSS puro), `content-visibility: auto` en los items, enriquecimiento gateado
  por `isCardSettled`, batching de skips a 220 ms.
- Cada tarea con lógica nueva lleva test (`node --test`); los cambios de CSS
  se verifican con build + sonda en vivo (el arnés de `?direct` + fixture
  sirve para CSS tras login, ver memoria de verificación).
- Hay sesiones concurrentes sobre el mismo árbol: **revisar el diff fichero a
  fichero antes de cada commit, y rebasar antes de push**.
- `prefers-reduced-motion` debe seguir significando «sin movimiento» en todos
  los caminos nuevos.

---

## Fase 0 — El cambio de tema (P0, la queja)

### Tarea 1 · La decisión de ruta del tema, extraída y testeable

**Ficheros:**
- Modificar: `src/utils/themeTransition.js`
- Test: `src/utils/themeTransition.test.js` (nuevo)

**Interfaces:**
- Produce: `pickThemeRoute({ reducedMotion, hasViewTransitions, coarsePointer })`
  → `'instant' | 'fade' | 'sweep'`, exportada; `runThemeSwitch(commit, origin)`
  conserva su firma.

- [ ] **Paso 1: test que falla**

```js
// src/utils/themeTransition.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickThemeRoute } from './themeTransition.js';

test('reduced motion manda: instantáneo aunque haya VT', () => {
  assert.equal(pickThemeRoute({ reducedMotion: true, hasViewTransitions: true, coarsePointer: false }), 'instant');
});

test('sin View Transitions el cambio es instantáneo, no una tormenta de transiciones', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: false, coarsePointer: true }), 'instant');
});

test('puntero grueso: crossfade corto, nunca el barrido', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: true, coarsePointer: true }), 'fade');
});

test('desktop con VT conserva el barrido de tinta', () => {
  assert.equal(pickThemeRoute({ reducedMotion: false, hasViewTransitions: true, coarsePointer: false }), 'sweep');
});
```

- [ ] **Paso 2:** `node --test src/utils/themeTransition.test.js` → FALLA
  (no existe `pickThemeRoute`).

- [ ] **Paso 3: implementación.** En `themeTransition.js`:

```js
export function pickThemeRoute({ reducedMotion, hasViewTransitions, coarsePointer }) {
  if (reducedMotion) return 'instant';
  if (!hasViewTransitions) return 'instant';
  return coarsePointer ? 'fade' : 'sweep';
}

function coarsePointer() {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

const PLAIN_CLASS = 'theme-switch-plain';

export function runThemeSwitch(commit, origin) {
  const route = pickThemeRoute({
    reducedMotion: prefersReducedMotion(),
    hasViewTransitions: typeof document.startViewTransition === 'function',
    coarsePointer: coarsePointer(),
  });

  if (route === 'instant') {
    commit();
    return;
  }

  if (route === 'fade') {
    const root = document.documentElement;
    root.classList.add(PLAIN_CLASS);
    const vt = document.startViewTransition(commit);
    vt.finished.finally(() => root.classList.remove(PLAIN_CLASS));
    return;
  }

  markSweepOrigin(origin);
  document.startViewTransition(commit);
}
```

Borrar `CROSSFADE_CLASS`, `CROSSFADE_MS` y la rama del `setTimeout`: el camino
sin View Transitions ya no anima nada. El comentario de cabecera del módulo se
reescribe con las tres rutas nuevas (instant / fade / sweep) y el porqué:
en móvil la captura de la view transition ya cuesta un frame largo; 420 ms de
`clip-path` encima es lo que se percibe como pesadez, y un fade de opacidad de
160 ms corre compuesto en cualquier GPU.

- [ ] **Paso 4:** `node --test src/utils/themeTransition.test.js` → PASA.

- [ ] **Paso 5: commit** — `fix(tema): el barrido se queda en desktop; el móvil funde en 160 ms`

### Tarea 2 · El CSS de las tres rutas

**Ficheros:**
- Modificar: `src/styles/global.css:262-340` (bloque «Theme switch»)

- [ ] **Paso 1:** después del bloque de keyframes del barrido
  (`themeSweepIn`/`themeSweepOut`), añadir el fade plano — colocado DESPUÉS
  para ganar el empate de especificidad con las reglas del barrido:

```css
/* Puntero grueso: la clase la pone runThemeSwitch mientras dura la
   transición. Nada de círculos: la instantánea nueva funde encima en 160 ms,
   opacidad pura, compuesta en cualquier GPU. */
:root.theme-switch-plain::view-transition-old(root) {
  z-index: 0;
  animation: none;
}

:root.theme-switch-plain::view-transition-new(root) {
  z-index: 1;
  animation: themePlainFade 160ms ease-out;
}

@keyframes themePlainFade {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

- [ ] **Paso 2:** borrar el bloque `html.theme-crossfade …` (`:321-330`) — su
  único emisor desapareció en la Tarea 1. Comprobar con
  `grep -rn "theme-crossfade" src` que no queda ningún consumidor.

- [ ] **Paso 3: verificación en vivo.** Con el dev server y viewport móvil:
  poner `document.querySelector('.theme-toggle').click()` desde
  `javascript_tool` habiendo forzado `matchMedia` no vale (no se puede fingir
  `pointer: coarse` desde JS): usar el preset `mobile` de `resize_window`
  (emula dispositivo táctil) y comprobar con `getAnimations()` sobre
  `document.documentElement` que la animación activa dura 160 ms y no hay
  `themeSweepIn`. En desktop, repetir y comprobar que el barrido sigue.
  Ojo: con el pane oculto la view transition aborta — frontear y capturar
  antes de creerse un resultado.

- [ ] **Paso 4:** `npm test` (nada debe romper: `darkTheme.test.js` no toca
  este bloque) y commit — `fix(tema): tres rutas en CSS y muere el crossfade universal`

---

## Fase 1 — CSS: la tanda de líneas sueltas (P1)

### Tarea 3 · Los botones dejan de transicionarlo todo

**Ficheros:**
- Modificar: `src/styles/global.css:149`

- [ ] **Paso 1:** sustituir `transition: all var(--transition-base);` por:

```css
    transition:
      background-color var(--transition-base),
      border-color var(--transition-base),
      color var(--transition-base),
      opacity var(--transition-base),
      box-shadow var(--transition-base),
      transform var(--transition-base);
```

Las propiedades de layout (width, height, padding) quedan fuera a propósito:
eran la sensación de «botón blando» diagnosticada el 22-08.

- [ ] **Paso 2:** pasada visual rápida por navbar, rail de acciones del feed y
  hojas (los botones cuyo hover cambia fondo/borde/sombra siguen animando).
  Commit — `fix(css): los botones solo animan pintura, no layout`

### Tarea 4 · Safe areas: el notch y el home indicator

**Ficheros:**
- Modificar: `src/styles/variables.css` (bloque `:root`), `src/components/Layout/Navbar.css:9-18`,
  `src/components/Feed/FeedContainer.css:56-58`, `src/components/Privacy/AnalyticsConsentBanner.css:2-16,118`,
  `src/components/Public/FollowSheet.css:16-42`, `src/components/Reader/Annotations.css:465-480`,
  `src/components/Public/GuestFeedPage.css:9-22`, `src/components/Public/PublicPaperPage.css:56-65`

- [ ] **Paso 1:** en `variables.css`, junto a `--nav-height`:

```css
  /* Con viewport-fit=cover el notch y el home indicator son responsabilidad
     nuestra. Cero en navegador normal; el inset real en PWA/standalone. */
  --inset-top: env(safe-area-inset-top, 0px);
  --inset-bottom: env(safe-area-inset-bottom, 0px);
```

- [ ] **Paso 2:** `.navbar` pasa a
  `height: calc(var(--nav-height) + var(--inset-top)); padding-top: var(--inset-top);`
  (y el bloque móvil que fija `--nav-height-mobile`, igual). En
  `FeedContainer.css`, el offset del feed que hoy resta `--nav-height-mobile`
  pasa a restar `calc(var(--nav-height-mobile) + var(--inset-top))`.
- [ ] **Paso 3:** `.analytics-consent` → `bottom: calc(20px + var(--inset-bottom));`
  (y en el breakpoint de `:118`, `calc(12px + var(--inset-bottom))`).
  `.follow-sheet` y `.rd-rail[data-surface='sheet']` →
  `padding-bottom: calc(<lo que tengan> + var(--inset-bottom))`. Cabeceras de
  `GuestFeedPage` y `PublicPaperPage` → `padding-top: var(--inset-top)`.
- [ ] **Paso 4: verificación.** En el pane no hay notch: verificar por
  computed style que `--inset-top` resuelve a `0px` y que nada se movió en
  navegador normal (captura antes/después idéntica). La prueba real con notch
  es en el iPhone del usuario tras el deploy — anotarlo en el PR.
  Commit — `fix(css): la barra respeta el notch y las hojas el home indicator`

### Tarea 5 · El banner de consentimiento deja de ser la capa más cara de la app

**Ficheros:**
- Modificar: `src/components/Privacy/AnalyticsConsentBanner.css:13-16`

- [ ] **Paso 1:** fondo opaco y sombra contenida — es un banner fijo
  permanente sobre un feed que hace scroll debajo:

```css
  background: var(--bg-elevated);
  box-shadow: var(--shadow-lg);
```

(fuera `color-mix … transparent`, fuera `backdrop-filter: blur(18px)` y fuera
la `transition` de sombra). Visualmente sobre blanco/tinta apenas cambia: el
94 % de opacidad ya era casi opaco.

- [ ] **Paso 2:** captura antes/después en claro y oscuro. Commit —
  `fix(css): el banner de consentimiento pierde el blur que pagaba todo el scroll`

### Tarea 6 · Los backdrops animados sueltan el blur

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.css:1104`, `src/components/Comments/CommentsSheet.css:28-29`,
  `src/components/Settings/EditInterestsModal.css:8-9`, `src/components/PDF/PDFViewer.css:7-8`,
  `src/components/Lists/CreateListDialog.css:20-21`, `src/components/Lists/SaveToListModal.css:30-31`

- [ ] **Paso 1:** en los seis, borrar `backdrop-filter`/`-webkit-backdrop-filter`
  del elemento cuyo `opacity` se anima al entrar (el velo de color rgba se
  queda — es lo que de verdad se ve). Animar opacidad sobre una capa con blur
  obliga a re-resolver el blur en cada frame: es el patrón que peor digiere
  una GPU móvil, y el blur de 3–8 px bajo un velo oscuro es imperceptible.
- [ ] **Paso 2:** los `backdrop-filter` **estáticos** que se quedan (hoja de
  autores `:2155`, `dialog::backdrop` de `global.css:209`, AuthPrompt) reciben
  el par `-webkit-` donde falte — hoy 6 de 17 sitios no lo llevan
  (`AnalyticsConsentBanner` ya murió en la Tarea 5; quedan
  `FollowSheet.css:25`, `EntityExplorer.css:1231`, `VisibilityPrompt.css:10`,
  `EmailNotificationModal.css:9`).
- [ ] **Paso 3:** las hojas que entran con spring y cargan `--shadow-xl`
  (48 px de blur re-rasterizado durante todo el translateY:
  `PaperCard.css:1123` `.related-sheet` y `:2173` `.pc-authors-modal-sheet`)
  bajan a `--shadow-lg` bajo `@media (pointer: coarse)` — en un fondo oscuro
  o tras un velo la diferencia no se ve, el coste sí.
- [ ] **Paso 4:** abrir comentarios, guardar-en-lista y el PDF en el pane;
  captura de cada backdrop. Commit —
  `fix(css): ningún backdrop anima su opacidad con un blur encima`

### Tarea 7 · `vh` → `dvh` donde la URL bar muerde

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.css:653,2170,2313,2395`,
  `src/components/Explorer/EntityExplorer.css:12,20`,
  `src/components/Settings/EditInterestsModal.css:6,35,324`,
  `src/components/Reader/Annotations.css:473`,
  `src/components/Following/EmailNotificationModal.css:14,270`

- [ ] **Paso 1:** cambio mecánico `Nvh` → `Ndvh` en las líneas listadas,
  dejando en cada una el `vh` original en una línea previa como fallback
  (patrón ya usado en `FeedContainer.css:12-13`):

```css
  max-height: min(30em, 46vh);
  max-height: min(30em, 46dvh);
```

Los dos que importan de verdad: el abstract de la tarjeta (`46vh`/`34vh`
dentro de una tarjeta medida en `100dvh` — hoy el tope del abstract y su
contenedor discrepan mientras la URL bar se anima) y `EntityExplorer.css`,
que no tiene un solo `dvh` en 2.206 líneas.

- [ ] **Paso 2:** `npm run build` (verifica que Tailwind/PostCSS no se queja)
  y commit — `fix(css): lo que debe seguir a la URL bar se mide en dvh`

### Tarea 8 · Animaciones en reposo: el feed quieto no gasta

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.css:486,503,744,759,1014`,
  `src/components/Feed/SkeletonCard.css:31-46`, `src/components/Auth/ProtectedRoute.jsx:57-62`,
  `src/components/Feed/FeedContainer.jsx:349-368`, `src/components/Feed/PaperCard.jsx:1489-1499`,
  `src/styles/variables.css:482-491`

- [ ] **Paso 1:** borrar las cuatro líneas de `will-change` permanente por
  tarjeta (`:486,:503,:744,:759` — `grid-template-rows` además no es
  promovible). framer-motion ya gestiona sus capas durante la animación.
- [ ] **Paso 2:** el aviso de scroll deja de ser infinito:
  `animation: scrollNudge 2.4s ease-in-out 4;` (cuatro ciclos y descansa), y
  `FeedContainer.jsx` pasa `hideScrollHint={index !== 0}` a `PaperCard` — hoy
  la prop existe y nadie la pasa, así que todas las tarjetas montan el hint.
- [ ] **Paso 3:** el shimmer del skeleton pasa de `background-position`
  (repinta cada frame, 7 selectores) a un pseudo-elemento con gradiente que
  se desplaza por `transform` (compuesto):

```css
.skeleton-block {
  position: relative;
  overflow: hidden;
  background: var(--bg-secondary);
}

.skeleton-block::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, var(--bg-glass-hover), transparent);
  animation: shimmerSlide 1.5s ease-in-out infinite;
}

@keyframes shimmerSlide {
  to { transform: translateX(100%); }
}
```

(adaptar los nombres a los 7 selectores reales del fichero; una sola regla
`::after` compartida).
- [ ] **Paso 4:** en `ProtectedRoute.jsx`, la animación inline que late con
  `filter: drop-shadow(0 0 10px→25px)` (no compuesta, pantalla de carga de
  auth) pasa a latir con `opacity` sobre un elemento que ya lleva la sombra
  fija — mismo efecto visual, cero repintado.
- [ ] **Paso 5:** borrar `@keyframes float` y `gradientShift` de
  `variables.css` (cero consumidores, verificado con grep).
- [ ] **Paso 5b:** `html { scroll-behavior: smooth }` (`global.css:68`) recibe
  su override de accesibilidad — el bloque de reduced-motion de `:335` solo
  cubre las view transitions:

```css
@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
}
```
- [ ] **Paso 6:** sonda en vivo: con el feed quieto,
  `document.getAnimations().length` debe quedar en 1 (el hint, mientras
  duren sus 4 ciclos) y 0 después. `npm test` y commit —
  `perf(css): el feed en reposo no anima nada que no se vea`

### Tarea 9 · EntityExplorer, la página que castiga al móvil

**Ficheros:**
- Modificar: `src/components/Explorer/EntityExplorer.css:65,698-699,1234-1245`,
  `src/components/Explorer/EntityExplorer.jsx:306-318`

- [ ] **Paso 1:** la toolbar sticky suelta el blur en puntero grueso (el
  único `backdrop-filter` que se re-muestrea en cada frame de scroll):

```css
@media (pointer: coarse) {
  .explorer-toolbar-wrapper {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    background: var(--bg-primary);
  }
}
```

- [ ] **Paso 2:** el héroe con `filter: blur(48px)` sobre imagen cover — en
  móvil no se pinta: `@media (max-width: 768px) { .ehc-bg-blur { display: none; } }`
  (el degradado de `mask-image` ya deja un fondo digno sin él).
- [ ] **Paso 3:** el drawer de filtros: `width: min(320px, 85vw);`.
- [ ] **Paso 4:** el listener de `resize` (`:318`) se debouncea a 150 ms y las
  lecturas (`getComputedStyle` + `scrollHeight`) van dentro de un
  `requestAnimationFrame` — hoy corre sin throttle en cada colapso de URL bar:

```js
useEffect(() => {
  let timer = null;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(() => requestAnimationFrame(measureExpandableDescriptions), 150);
  };
  window.addEventListener('resize', onResize);
  return () => {
    clearTimeout(timer);
    window.removeEventListener('resize', onResize);
  };
}, [measureExpandableDescriptions]);
```

- [ ] **Paso 5:** `npm test`, sonda visual del explorer en el pane (viewport
  móvil, tema claro y oscuro) y commit —
  `perf(explorer): el móvil no paga ni el blur del héroe ni el resize sin freno`

### Tarea 10 · Hovers con guarda en las hojas táctiles

**Ficheros:**
- Modificar: `src/components/Public/FollowSheet.css:81,87,136,211,390,414`,
  `src/components/Settings/MyCommentsPage.css:60,142,247,274`

- [ ] **Paso 1:** envolver cada regla `:hover` listada en
  `@media (hover: hover) and (pointer: fine) { … }` (el patrón de las ~90
  guardas que ya existen). Evita el hover pegado tras cada tap en hojas que
  solo existen en táctil.
- [ ] **Paso 2:** commit — `fix(css): sin hovers pegajosos en las hojas táctiles`

---

## Fase 2 — Runtime del feed (P2)

### Tarea 11 · Los dos providers que faltaban por memoizar

**Ficheros:**
- Modificar: `src/context/FeedContext.jsx:1980`, `src/context/AuthContext.jsx:300`
- Test: `src/context/contextIdentity.test.js` (existente — ampliar)

- [ ] **Paso 1:** envolver ambos `value` en `useMemo` con la lista de
  dependencias completa (las 25 y 20 claves respectivamente; las funciones ya
  estables por `useCallback` no fuerzan recreación). Mismo patrón que
  `FollowingContext.jsx:312`.
- [ ] **Paso 2:** test de identidad: renderizar el provider dos veces con el
  mismo estado y afirmar `Object.is(value1, value2)` — ampliar
  `contextIdentity.test.js`, que ya monta providers.
- [ ] **Paso 3:** `npm test` y commit —
  `perf(context): FeedContext y AuthContext dejan de regalar renders`

### Tarea 12 · El re-ranking deja de ser O(N²)

**Ficheros:**
- Modificar: `src/utils/recommendationEngine.js:379-410` (el bucle de
  `diversifiedWeightedShuffle`), `:63-68` (`topReasons`), `:79-98`
  (`normalizeSignal` y consumidores)
- Test: `src/utils/recommendationEngine.test.js` (existente — ampliar)

**Interfaces:**
- `diversifiedWeightedShuffle(papers, opts)` conserva firma y contrato (mismo
  multiconjunto de salida, misma regla de diversidad); solo cambia el coste.

- [ ] **Paso 1: test que falla — el contador de puntuaciones.**

```js
test('el shuffle no re-puntúa el pool entero por iteración', () => {
  const papers = Array.from({ length: 60 }, (_, i) => makePaper(i));
  let calls = 0;
  const scorePaper = (paper) => { calls += 1; paper.recommendationScore = 1; };
  diversifiedWeightedShuffle(papers, { scorePaper });
  // Presupuesto: una pasada base + una re-puntuación por valor distinto de
  // recentPropsCount (acotado por RECENT_WINDOW), no N por iteración.
  assert.ok(calls <= papers.length * 8, `scorePaper corrió ${calls} veces`);
});
```

(`makePaper` ya existe como helper del test o se construye con las claves
mínimas que `scorePaper` del test ignora.)

- [ ] **Paso 2:** correr → FALLA (hoy `calls` ≈ N²/2 ≈ 1.800).
- [ ] **Paso 3: implementación.** La única entrada del score que cambia por
  iteración es `recentPropsCount` (un entero pequeño derivado de
  `history.slice(-5)`). Cachear por paper y por valor:

```js
const scoreCache = new Map(); // paper -> Map(recentPropsCount -> score)

const scoreFor = (paper, recentPropsCount) => {
  let byCount = scoreCache.get(paper);
  if (!byCount) { byCount = new Map(); scoreCache.set(paper, byCount); }
  if (!byCount.has(recentPropsCount)) {
    scorePaper(paper, recentPropsCount);
    byCount.set(recentPropsCount, paper.recommendationScore);
  } else {
    paper.recommendationScore = byCount.get(recentPropsCount);
  }
  return paper.recommendationScore;
};
```

y en el bucle, sustituir `pool.forEach(paper => scorePaper(paper, recentPropsCount))`
por `pool.forEach(paper => scoreFor(paper, recentPropsCount))`. El coste pasa
de N²/2 llamadas caras a N × (valores distintos de `recentPropsCount`), con
las repetidas costando un `Map.get`.

- [ ] **Paso 4:** `topReasons` (la explicación con `Object.entries().sort()` +
  `toFixed` que solo lee el panel de debug) se calcula solo si
  `shouldLogRanking()` — pasar el flag una vez por re-rank, no leerlo por
  llamada (hoy hay un `localStorage.getItem` por snap en `:437`).
- [ ] **Paso 5:** memoizar `normalizeSignal` con un `Map` módulo-nivel
  (entrada string → salida string; las señales se repiten entre papers y
  re-ranks; NFD + 3 regex pasan a pagarse una vez por string distinto). Tope
  simple: `if (cache.size > 5000) cache.clear()`.
- [ ] **Paso 6:** correr el test nuevo y la suite entera del engine
  (`node --test src/utils/recommendationEngine.test.js`) → PASA, incluidos
  los tests de diversidad existentes (el contrato no cambió).
- [ ] **Paso 7:** commit —
  `perf(ranking): el shuffle cachea por (paper, ventana) y deja de ser cuadrático`

### Tarea 13 · El re-rank se va del camino del snap

**Ficheros:**
- Modificar: `src/context/FeedContext.jsx:1654,1718` (los llamadores de
  `reRankFeed` en `trackViewTime`/`trackSkip`)
- Test: `src/context/` — el que cubra `trackViewTime` (localizar con
  `grep -rn "trackViewTime" src --include="*.test.js"`; si no hay, el test de
  la Tarea 12 cubre el coste y aquí basta la sonda en vivo)

- [ ] **Paso 1:** envolver la llamada a `reRankFeed` en
  `requestIdleCallback(fn, { timeout: 800 })` con fallback a
  `setTimeout(fn, 120)` donde no exista. El observer del snap vuelve en
  seguida; el re-orden llega en el siguiente hueco de idle — el usuario está
  leyendo la tarjeta recién asentada, no mirando el orden del resto.
- [ ] **Paso 2: sonda en vivo** (la medida que importa): en producción o dev,
  `PerformanceObserver` de `longtask` armado, hacer 5 snaps con dwell >3 s y
  comprobar que ninguna longtask >50 ms coincide con el snap (el histórico
  era 58–151 ms).
- [ ] **Paso 3:** `npm test` y commit —
  `perf(feed): el re-orden espera al idle en vez de pisar el snap`

### Tarea 14 · Identidad estable en el enriquecimiento tardío

**Ficheros:**
- Modificar: `src/utils/feedEnrichment.js:39-42` (`mergeOpenAlexEnrichment`)
- Test: `src/utils/feedEnrichment.test.js` (crear si no existe)

- [ ] **Paso 1: test que falla:**

```js
test('un paper sin enriquecimiento conserva su identidad de objeto', () => {
  const untouched = makePaper('a');
  const enriched = makePaper('b');
  const result = mergeOpenAlexEnrichment([untouched, enriched], new Map([['b', { citas: 9 }]]));
  assert.ok(Object.is(result[0], untouched), 'el paper sin datos nuevos debe ser el mismo objeto');
  assert.ok(!Object.is(result[1], enriched), 'el enriquecido sí es una copia');
});
```

(ajustar la forma real de la segunda entrada del merge al leerla; el contrato
del test es la identidad, no la forma).

- [ ] **Paso 2:** correr → FALLA. **Paso 3:** en el merge, devolver el objeto
  original cuando no haya datos para ese paper (`return paper` en vez de
  `{ ...paper }`). Con la identidad estable, `memo(PaperCard)` aguanta y los
  observers (`PaperCard.jsx:370` depende de `paper`) no se recrean en cada
  merge.
- [ ] **Paso 4:** `npm test` → PASA. Commit —
  `perf(feed): el enriquecimiento no reconstruye a quien no enriquece`

### Tarea 15 · Higiene de render por tarjeta

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.jsx:909,1126-1136,1279-1289`,
  `src/components/ScientificText.js:9-11`

- [ ] **Paso 1:** la lectura de `DEBUG_RANKING` sale del cuerpo del render a
  una constante de módulo (se lee una vez por carga; quien activa el debug
  recarga):

```js
const SHOW_RANKING_DEBUG = typeof window !== 'undefined'
  && window.localStorage?.getItem('DEBUG_RANKING') === 'true';
```

- [ ] **Paso 2:** en `ScientificText`, memoizar el parse:
  `const parts = useMemo(() => splitLatexText(text), [text]);` (hoy re-parsea
  el abstract entero en cada render, dos veces por tarjeta).
- [ ] **Paso 3:** las dos animaciones `gridTemplateRows: '0fr'→'1fr'` (badge
  de proyecto y recursos enlazados; 620 ms de layout por frame cada una)
  pasan a entrada compuesta: el slot aparece sin animar su tamaño (un layout,
  una vez) y el contenido entra con `opacity` + `translateY(8px)` en 240 ms:

```jsx
<motion.div
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.24, ease: 'easeOut' }}
>
```

(quitar `gridTemplateRows` del `initial/animate` y el `0fr/1fr` del CSS del
slot; el hueco lo reserva el layout normal).
- [ ] **Paso 4:** `npm test`, sonda visual del badge al asentarse una tarjeta,
  commit — `perf(tarjeta): render sin localStorage ni parses repetidos, y el badge entra compuesto`

### Tarea 16 · Imágenes acotadas

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.jsx:945-955`,
  `src/components/Feed/PaperCard.css:143-146`, y los cinco `<img>` de avatar
  (`Navbar.jsx:166`, `SettingsPage.jsx:514`, `FollowSheet.jsx:103`,
  `ProfilePage.jsx:728`, `PublicProfilePage.jsx:1001`)

- [ ] **Paso 1:** figuras del paper:

```jsx
<img
  src={figure.url}
  alt={figure.caption || ''}
  loading="lazy"
  decoding="async"
  width="320"
  height="240"
/>
```

con `aspect-ratio: 4 / 3; height: auto;` en `.pc-figure img` para que el
`width/height` reserve hueco sin imponer proporción real (el `object-fit:
contain` existente sigue mandando en el encaje).
- [ ] **Paso 2:** avatares: `loading="lazy" decoding="async" width="32" height="32"`
  (el tamaño que cada sitio ya impone por CSS).
- [ ] **Paso 3:** build + pasada visual, commit —
  `perf(img): figuras y avatares perezosos, decodificados fuera del hilo y con hueco reservado`

### Tarea 17 · Goteras menores del runtime

**Ficheros:**
- Modificar: `src/components/Search/SearchPage.jsx:605-615`,
  `src/context/FeedContext.jsx:1284,1298` (`writeFeedSnapshot` en los merges),
  `src/context/FollowingUpdatesContext.jsx:128,165`

- [ ] **Paso 1:** el intervalo del contador de `SearchPage`: sacar `outageNow`
  de las dependencias (usar un ref o functional update) para que el intervalo
  no se rearme por tick, y pausarlo con `document.visibilityState === 'hidden'`.
- [ ] **Paso 2:** `writeFeedSnapshot` en los merges de enriquecimiento se
  debouncea (un `setTimeout` de 500 ms que se pisa) — serializar 30 papers
  dos veces extra por carga no compra nada.
- [ ] **Paso 3:** `markSeen` acumula y escribe una vez por microtask
  (`queueMicrotask` con un Set pendiente) en vez de JSON parse+stringify por
  ítem.
- [ ] **Paso 4:** `npm test` y commit — `perf(varios): tres goteras menos`

---

## Fase 3 — Arranque (P3)

### Tarea 18 · El lector sale del grafo del feed

**Ficheros:**
- Modificar: `src/components/Feed/PaperCard.jsx:25` (y el punto de render del
  reader dentro del mismo fichero)

- [ ] **Paso 1:**

```jsx
const PaperReader = lazy(() => import('../Reader/PaperReader.jsx'));
```

y el sitio donde se renderiza (el overlay del lector) se envuelve en
`<Suspense fallback={null}>` — el patrón `RouteFallback`/placeholder retrasado
no hace falta aquí: el lector abre sobre la tarjeta ya pintada.
- [ ] **Paso 2:** `npm run build` y comparar: el chunk de entrada debe perder
  el JS del lector y `index-*.css` unos ~41 KB crudos (PaperReader.css +
  Annotations.css). Anotar los números en el commit.
- [ ] **Paso 3:** en vivo: abrir un paper → el lector carga (primer uso paga
  un chunk pequeño); `npm test`; commit —
  `perf(arranque): el lector viaja en su propio chunk`

### Tarea 19 · Fuentes autoalojadas y sin bloqueo de render

**Ficheros:**
- Modificar: `index.html:71-73`, `src/main.jsx`, `package.json`

- [ ] **Paso 1:** `npm install @fontsource/inter @fontsource/ibm-plex-mono @fontsource-variable/newsreader`
- [ ] **Paso 2:** en `main.jsx`, antes del CSS global:

```js
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource-variable/newsreader/opsz-italic.css';
```

- [ ] **Paso 3:** quitar de `index.html` el `<link rel="stylesheet">` de
  `fonts.googleapis.com` y sus dos `preconnect` (los de Firebase y el Worker
  se quedan). Ajustar `--font-serif` en `variables.css` a
  `'Newsreader Variable', …` (nombre de familia que registra fontsource).
- [ ] **Paso 4:** verificación: `npm run build` — los woff2 con hash aparecen
  en `dist/assets/`; en el pane, `document.fonts` carga Inter/Plex/Newsreader
  desde el propio origen y `performance.getEntriesByType('resource')` no
  contiene `fonts.googleapis.com`. La cascada pierde una hoja render-blocking
  cross-origin y las fuentes pasan a cachearse con los assets (y al precache
  del SW en la Tarea 21).
- [ ] **Paso 5:** `npm test` y commit —
  `perf(fuentes): autoalojadas, con subsets, y sin hoja que bloquee el primer pintado`

### Tarea 20 · El prefetch pregunta antes de gastar datos

**Ficheros:**
- Modificar: `src/App.jsx:97-99`, `src/components/Feed/FeedContainer.jsx:168`

- [ ] **Paso 1:** el idle-prefetch de 5 chunks se gatea:

```js
const conn = navigator.connection;
const frugal = conn && (conn.saveData || /2g/.test(conn.effectiveType || ''));
if (!frugal) { /* …los import() actuales… */ }
```

- [ ] **Paso 2:** el centinela del scroll infinito baja de 5 viewports a 2:
  `rootMargin: '0px 0px 200% 0px'` — el lector medio tarda >30 s en consumir
  dos tarjetas; cargar 5 por delante solo infla el DOM móvil.
- [ ] **Paso 3:** `npm test`, sonda de scroll (la carga siguiente llega antes
  de tocar fondo), commit —
  `perf(red): el prefetch respeta saveData y el centinela no corre tanto`

---

## Fase 4 — La revisita (P4)

### Tarea 21 · Service worker con precache

**Ficheros:**
- Modificar: `vite.config.js`, `package.json`
- Crear: nada a mano (`vite-plugin-pwa` genera el SW)

- [ ] **Paso 1:** `npm install -D vite-plugin-pwa`
- [ ] **Paso 2:** en `vite.config.js`:

```js
import { VitePWA } from 'vite-plugin-pwa'

// dentro de plugins: [react(), tailwindcss(), …]
VitePWA({
  registerType: 'autoUpdate',
  // El manifest ya existe en public/ y está enlazado; el plugin no lo genera.
  manifest: false,
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
    // KaTeX y ScientificReport son grandes pero entran: el tope por defecto
    // (2 MB) los cubre; el precache total ronda lo que hoy pesa dist/.
    navigateFallback: null, // HashRouter: no hay rutas de servidor que interceptar
  },
})
```

- [ ] **Paso 3:** registrar en `main.jsx`:

```js
import { registerSW } from 'virtual:pwa-register';
registerSW({ immediate: true });
```

- [ ] **Paso 4:** verificación: `npm run build && npm run preview` — en el
  pane, `navigator.serviceWorker.getRegistrations()` no vacío; segunda carga
  con Network offline sirve la app. **Ojo**: el preview local no vale para
  latencia (CORS del Worker), pero sí para comprobar el registro y el
  precache. La verificación de assets frescos tras un deploy real: subir una
  versión, recargar dos veces, comprobar que llega la nueva.
- [ ] **Paso 5:** `npm test` y commit —
  `feat(pwa): service worker con precache — la revisita móvil deja de re-descargar el mundo`

---

## Lo que este plan deja fuera, a sabiendas

- **Ventana de montaje del feed** (virtualizar `papers.map`): cirugía con
  riesgo en el snap y la restauración de scroll. Las tareas 12–14 + el
  centinela a 200 % reducen el problema; si tras medir sigue doliendo, se
  planifica aparte.
- **Diferir Firestore para visitantes** (~190 KB crudos): pendiente conocido
  desde el 22-08, cirugía en `services/firebase.js` con su propio plan.
- **`PageTransition mode="wait"`** (0,5 s por navegación): es una decisión de
  diseño, no un bug; se toca cuando el rediseño del compañero aterrice.
- **Brotli**: GH Pages no lo sirve; no depende de nosotros.

## Orden y medición

Las fases son independientes; dentro de cada fase, las tareas van en orden.
Tras cada fase, la medida de control es la del spec: toggle de tema con
`getAnimations()`, `document.getAnimations().length` en reposo, longtasks por
snap, y `npm run build` para los tamaños. La comparación honesta contra
producción se hace como siempre — contra el origen real, no contra el preview
(ver memoria de verificación en vivo).
