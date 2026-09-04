# El cambio de pestaña responde al toque — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que pulsar «Following» (o cualquier pestaña de la barra) en el móvil se note en el mismo instante: el subrayado se mueve y la página de salida empieza a irse en el primer fotograma, en vez de no pasar nada durante medio segundo o más.

**Architecture:** React Router 7 ejecuta cada navegación dentro de `React.startTransition` por defecto. Una transición se renderiza en segundo plano, troceada y con prioridad baja, y cualquier trabajo por fotograma (las animaciones del feed, los observadores, el bucle de framer) la deja pasar hambre; hasta que esa transición confirma, ni el subrayado de la barra ni la salida de `PageTransition` arrancan, porque ambos leen `useLocation()`. El arreglo es un solo prop, `useTransitions={false}` en el `<HashRouter>`, que hace síncrona la actualización de estado de la navegación. Las rutas perezosas no cambian de comportamiento: `AnimatePresence mode="wait"` ya montaba la página entrante después de la salida, fuera de la transición del router.

**Tech Stack:** React 19, React Router 7.18 (`HashRouter`), framer-motion, Vite 8; tests con `node:test` (los componentes no se montan bajo node: test de FUENTE). Medición con `scripts/diagnostics/explorer-loading-probe.mjs tabswitch` contra un servidor en modo demo.

**Spec:** Este documento, sección «Diagnóstico».

## Global Constraints

- Node 22 en CI: nada de APIs solo de Node 25. Tests con `node --test <fichero>`; la suite completa con `npm test`; antes del último commit, `npm run check`.
- Otra sesión de Claude trabaja en el árbol principal: este plan se ejecuta en el worktree `.claude/worktrees/tabs-following` (rama `worktree-tabs-following`). Antes de cada commit, `git status --short` y `git add` solo de los ficheros de la tarea.
- `IS_DEMO = true` en `src/services/firebase.js` está volteado en el worktree para medir: **nunca se commitea**; revertir con `git checkout HEAD -- src/services/firebase.js` antes de cualquier `git add`.
- Mensajes de commit en español, prefijo `fix(nav):` / `test(nav):`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Comentarios de código en inglés y que citen la medida (fecha, cifra), como el resto de `main.jsx`.
- El frontend se despliega en Vercel al hacer push a `main`; el push se pide al usuario.

## Diagnóstico

Síntoma (2026-09-05): en el móvil, para pasar de «For you» a «Following» hay que pulsar varias veces; en el ordenador quizá también.

Cadena verificada:

1. `Navbar.jsx` pinta las pestañas como `NavLink`; el activo y el subrayado (`useActiveTabRule`) salen de `useLocation()`. `App.jsx` calcula la dirección de `PageTransition` también desde `useLocation()` y `AnimatePresence mode="wait"` hace la salida y la entrada estrictamente secuenciales.
2. `HashRouter` de React Router 7.18 (`chunk-62JRHF6Z.mjs:10446`) envuelve `setStateImpl(newState)` en `React.startTransition` salvo que `useTransitions === false`. El `history.pushState` es inmediato (el hash cambia al instante), pero el estado de React que mueve el subrayado y arranca la salida es una transición.
3. Medido con la sonda `tabswitch` (Chromium headless, emulación móvil 390×844 táctil, modo demo, fotograma a fotograma), toque en «Following» con el feed ya pintado:

| Condición | Primer fotograma de la salida | Monta la página nueva | Entrada completa |
|---|---|---|---|
| CPU normal, chunk caliente | 168 ms | 344 ms | ~580 ms |
| CPU normal, chunk frío | 191 ms | 346 ms | ~580 ms |
| CPU ×4, chunk caliente | **699 ms** | 957 ms | ~1280 ms |
| CPU ×4, chunk frío | **793 ms** | 1053 ms | ~1280 ms |

Durante ese tiempo muerto no hay ninguna tarea larga: la transición cede una y otra vez al trabajo por fotograma y confirma tarde. Nada acusa el toque — ni el subrayado, ni un fundido — así que el lector vuelve a pulsar, y la pestaña «cambia» cuando por fin confirma la primera transición.

4. Con `useTransitions={false}` en el mismo montaje:

| Condición | Primer fotograma de la salida | Monta la página nueva | Entrada completa |
|---|---|---|---|
| CPU normal, chunk caliente | 3 ms | 148 ms | ~400 ms |
| CPU normal, chunk frío | 2 ms | 200 ms | ~430 ms |
| CPU ×4, chunk caliente | **11 ms** | 252 ms | ~600 ms |

La tarea larga que aparece después (115 ms a CPU ×4, a los 137 ms) es el montaje de la página de Siguiendo tras la salida — la misma que había con transiciones (114 ms a los 842 ms): no es coste nuevo, es el mismo coste antes.

5. El prop es global — toda navegación deja de ser transición — así que la revisión pidió medir también un paso jerárquico. Sonda `open` (abrir un autor desde una tarjeta del feed de invitado y volver con `history.back`), CPU ×4:

| Paso | Con transiciones | Síncrono |
|---|---|---|
| Abrir: primer fotograma de la salida | 444 ms (nada en pantalla hasta los 429) | 162 ms (una tarea de 153 ms a los 8 ms, la misma que antes iba troceada) |
| Abrir: monta el explorador | 676 ms | 257 ms |
| Volver: primer fotograma de la salida | 7 ms | 36 ms |
| Volver: monta el feed | 225 ms | ~250 ms |

La salida ya no puede ceder a una interacción a mitad de render, pero lo que bloquea es el render que antes se aplazaba entero; el paso pesado también gana.

Descartados: el área de toque del enlace (63×30 px, nada lo cubre: `elementFromPoint` devuelve el propio `<a>`); un doble toque de 300 ms (hay `<meta viewport>`); el chunk perezoso de `FollowingFeedPage` (3,4 kB, precargado a los 2,5 s de idle; en frío añade 20–100 ms, no el medio segundo); la recarga forzada tras un despliegue (`vite:preloadError`) — es un caso aparte y de una sola vez.

## Decisiones de diseño

- **Quitar la transición, no maquillarla.** Un subrayado optimista (estado local en el clic) acusaría el toque pero dejaría el medio segundo de espera hasta la salida; el lector vería la pestaña marcada y la página anterior quieta. Con la actualización síncrona la salida arranca en el primer fotograma y el subrayado con ella, sin estado extra en la barra.
- **Qué deja de ser transición y qué no cambia.** Solo la actualización de `location` del router. Las rutas perezosas siguen igual: `AnimatePresence mode="wait"` monta la entrante cuando la saliente ha terminado, y ese montaje ya ocurría fuera de la transición (`utils/lazyPreload.js` lo documenta). Los otros consumidores de `useTransitions` en React Router — `<Form>`, `useSubmit`, los fetchers — no se usan en esta app.
- **El prop es API estable.** El CHANGELOG de react-router estabiliza `unstable_useTransitions` como `useTransitions` en `<HashRouter>` (entre otros); el tipo `useTransitions?: boolean` está en `dom-export.d.ts`.

## Fuera del alcance (y por qué)

- **Los ~140 ms a opacidad 0 tras montar la página nueva con CPU ×4** (252 → 392 ms): es el coste de montar tres tarjetas del feed en una tarea larga, la ventana de montaje que ya existe. Otro cambio.
- **La precarga del chunk a los 2,5 s**: deliberada (conexiones frugales); en frío cuesta 20–100 ms, no el síntoma.

## Mapa de ficheros

- Modify: `src/main.jsx:143` — el `<HashRouter>`.
- Create: `src/routerTransitions.test.js` — test de fuente que fija el prop y su motivo.

---

### Task 1: La navegación del router deja de ser una transición

**Files:**
- Modify: `src/main.jsx:143`
- Create: `src/routerTransitions.test.js`

**Interfaces:**
- Produces: `<HashRouter useTransitions={false}>` — ninguna otra pieza cambia de firma.

- [ ] **Step 1: Escribir el test de fuente, que falla**

Crear `src/routerTransitions.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE test: the router is mounted in main.jsx, which node cannot run.
 *
 * React Router 7 wraps every navigation's state update in
 * `React.startTransition`. A transition renders in the background, sliced and
 * at low priority, and the per-frame work of the feed starves it: measured on
 * the tab bar (headless Chromium, mobile emulation, CPU ×4), a tap on
 * Following changed nothing on screen for 699 ms with the chunk warm — no
 * underline, no exit — because both read `useLocation()`. Synchronous, the
 * exit started 11 ms after the tap. The prop is what keeps it synchronous.
 */
test('SOURCE: the router updates its location synchronously, so a tab tap is acknowledged on the next frame', async () => {
  const code = stripComments(await read('./main.jsx'));
  assert.match(code, /<HashRouter useTransitions=\{false\}>/, 'navigation must not be a React transition');
  assert.doesNotMatch(code, /<HashRouter>/, 'a bare <HashRouter> falls back to transitions');
});
```

- [ ] **Step 2: Comprobar que falla contra el `main.jsx` de `main`**

Si el worktree aún lleva el `useTransitions={false}` del experimento de medida, restaurar primero el fichero de `main`: `git checkout HEAD -- src/main.jsx`.

Run: `node --test src/routerTransitions.test.js`
Expected: FAIL en la primera aserción («navigation must not be a React transition»).

- [ ] **Step 3: Aplicar el prop con su comentario**

En `src/main.jsx`, sustituir:

```jsx
    <HashRouter>
```

por

```jsx
    {/* Not a React transition. React Router 7 wraps each navigation's state
        update in `startTransition`, which renders in the background at low
        priority — and the feed's per-frame work starves it. Measured on the
        tab bar (scripts/diagnostics/explorer-loading-probe.mjs tabswitch,
        mobile emulation, 2026-09-05): a tap on Following showed nothing —
        no underline, no exit — for 168 ms on a desktop CPU and 699 ms at
        CPU ×4, chunk warm, because the bar and PageTransition both read
        `useLocation()` and wait for that commit. Synchronous, the exit
        starts 3 ms / 11 ms after the tap. Lazy routes are unaffected:
        AnimatePresence mode="wait" mounts the incoming page after the exit,
        outside the router's update either way (utils/lazyPreload.js). */}
    <HashRouter useTransitions={false}>
```

- [ ] **Step 4: Comprobar que pasa**

Run: `node --test src/routerTransitions.test.js src/utils/spaDeploy.test.js`
Expected: todos `ok` (spaDeploy también lee `main.jsx` y no debe verse afectado).

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/main.jsx src/routerTransitions.test.js
git commit -m "fix(nav): una pestaña responde al toque — la navegación deja de ser una transición de React

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Verificación medida y comprobación completa

**Files:** ninguno nuevo. Produce evidencia.

- [ ] **Step 1: La sonda, sobre el commit final**

Con el servidor del worktree en el puerto 5174 y `IS_DEMO = true` volteado en local:

```bash
ORIGIN=http://localhost:5174 node scripts/diagnostics/explorer-loading-probe.mjs tabswitch '#/' demo,mobile,slow,late
```

Expected en «For you -> Following»: el primer fotograma con `pages` por debajo de 1.00 antes de los 40 ms (era 699 ms), `dir=1` desde el primer cambio, y la página nueva (`cards=5`) montada antes de los 350 ms (era 957 ms). Repetir sin `slow`: salida antes de los 20 ms (era 168 ms).

- [ ] **Step 2: Suite y comprobación de entrega**

`git checkout HEAD -- src/services/firebase.js` (el demo nunca viaja), después `npm run check`.
Expected: secretos, lint, tests (todos `ok`, ninguno `cancelled`), build y dry-run del Worker en verde.

- [ ] **Step 3: Entrega**

Presentar al usuario las opciones de cierre de rama (fusionar en `main`, PR, o dejarla). El push publica en Vercel: solo con su confirmación.

---

## Autorevisión

- **Cobertura del diagnóstico:** la causa (transición) la quita Task 1; las medidas de Task 2 son las mismas que la tabla del diagnóstico, así que el antes/después es comparable.
- **Sin marcadores vacíos:** cada paso lleva el código o el comando.
- **Consistencia:** el test de Task 1 y el comentario de Task 1 citan las mismas cifras que la sección «Diagnóstico» (168 / 699 ms antes; 3 / 11 ms después).
