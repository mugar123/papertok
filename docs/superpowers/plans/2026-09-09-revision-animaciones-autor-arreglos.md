# Arreglos de la revisión `5fb6c03..aea5a59` — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los diez hallazgos verificados de la revisión de código del rango `5fb6c03..aea5a59` (ya en producción), y devolver al héroe del Explorer un único dueño de su altura.

**Architecture:** Dos partes independientes. **Parte A** (Explorer + `FeedContext`): el `useHeightSettle` vuelve a ser el único animador de la altura de `.explorer-hero-content`; el bloque de Wikipedia entra por opacidad bajo el recorte del settle, como ya hace el panel de experiencia, y queda montado a través de una re-búsqueda. Con eso desaparecen los nueve mecanismos de reconciliación entre dos dueños (latch, `resync`, `staleMemoryRef`, rama de cancelación, efecto de reinicio, puerta de montaje, medida síncrona) y con ellos cuatro de los hallazgos. **Parte B** (puerta de autor, commit `78cb22d` de otra sesión): el injerto de ids se hace por posición o por coincidencia única, los `authorships` se acotan, y vuelve el fallback para autorías sin id.

**Tech Stack:** React 19 + Vite (SPA, HashRouter), framer-motion 12, WAAPI. Tests con `node --test` sobre texto fuente (no hay DOM en tests) más funciones puras. Verificación en vivo con las sondas CDP de `scripts/diagnostics/` contra un build de producción.

**Spec:** Los diez hallazgos, tal como los emitió el revisor (verificados uno a uno por agente independiente):

| # | Fichero:línea | Hallazgo | Veredicto | Tarea |
|---|---|---|---|---|
| 1 | `src/context/FeedContext.jsx:1657` | La carga fría con sesión re-ordena y puede reemplazar el feed: el efecto de la firma graba `''` antes de conocer el uid | CONFIRMADO | 1 |
| 2 | `src/hooks/useHeightSettle.js:115` | `resync` salta (no asienta) el primer dato tras cada llegada de ruta | CONFIRMADO | 2 |
| 3 | `src/services/PaperBuilder.js:203` | El primer nombre que casa injerta el id equivocado (dos coautores, un id) | CONFIRMADO | 7 |
| 4 | `src/services/openAlexService.js:69` | `authorships` sin tope revienta el tope de caché y el timeout del chunk | CONFIRMADO | 8 |
| 5 | `src/components/Explorer/EntityExplorer.jsx:467` | Cambiar de idioma pliega y vuelve a desplegar el bloque de Wikipedia | CONFIRMADO | 4 |
| 6 | `src/components/Explorer/EntityExplorer.jsx:528` | El efecto de reinicio del latch des-suspende el settle a mitad del plegado de salida | CONFIRMADO | 3 |
| 7 | `src/services/openAlexService.js:490` | La búsqueda por nombre dispara siempre; el fallback para autorías sin id se borró | CONFIRMADO | 9 |
| 8 | `src/components/Explorer/EntityExplorer.jsx:2089` | Dos dueños de la altura del héroe (altitud): nueve mecanismos para reconciliarlos | CONFIRMADO | 2–3 |
| 9 | `src/components/Explorer/EntityExplorer.jsx:2095` | Un bloque sólo con `homepage_url` monta bajo un settle en vuelo y queda recortado | PLAUSIBLE | 3 |
| 10 | `src/components/Explorer/EntityExplorer.jsx:162` | `WikiBlockSkeleton` y la rama interna del esqueleto están muertos; la escalera CSS está mal etiquetada | CONFIRMADO | 5 |
| 11 | `src/components/Explorer/EntityExplorer.jsx:256` | Una entidad ya en caché nace como esqueleto: en una institución caliente el esqueleto vive **30 ms — dos fotogramas** — y las cuatro cifras llegan de golpe en el fundido del héroe; no hay ningún momento «dato llegando» que ver | MEDIDO 09-09 | 11 |
| 12 | `src/services/openAireService.js:54` | `getProjectDetails` es la única lectura del Explorer sin caché: cada vuelta a un proyecto paga el viaje entero a OpenAIRE con el esqueleto en pantalla | LEÍDO EN CÓDIGO | 12 |

Los hallazgos 11 y 12 vienen de la auditoría en vivo del 09-09 (siete corridas más: institución → autor, autor → institución, stats por celda en institución y autor, y píldora del feed → proyecto con OpenAIRE interceptado). Esa misma auditoría **refutó** una predicción de la revisión anterior: la página de proyecto NO encoge con la entidad optimista y crece con los detalles — `isLoadingEntity` mantiene el esqueleto hasta que `getProjectDetails` responde (medido: esqueleto hasta t=1552 con los detalles retrasados 1500 ms, y después UN settle de 246,8 → 473,0 px). No hay tarea para eso.

Los hallazgos 6, 8 y 9 se cierran juntos en las tareas 2–3: son consecuencias de la misma decisión (dejar que framer animara la altura del fold además del settle). El 7 se cierra a medias a propósito: la búsqueda en paralelo es una decisión medida de `78cb22d` (51 de 56 enlaces lentos no están indexados y ahí ahorra un viaje); lo que se restaura es el fallback borrado.

## Global Constraints

- **`SAME_HEIGHT_PX = 1`** en `src/hooks/heightSettlePlan.js` no se toca: `heightSettlePlan.test.js:42-50` documenta el salto que subirlo reintroduce.
- **La curva del settle** `cubic-bezier(0.4, 0, 0.2, 1)` no se toca: elegida contra una expo-out que gastaba 70 px en un fotograma en móvil.
- **La suspensión del settle mientras la ruta llega** (`isPageArriving`, commit `7c549c4`) se conserva: es un dueño genuinamente distinto (la página entera viaja por transform) y el revisor lo confirmó. Lo que se retira es la suspensión por el fold de Wikipedia.
- **No se añade ninguna dependencia de test** (ni jsdom ni happy-dom). Los tests son `node --test`: funciones puras cuando la lógica se puede extraer, y tests de texto fuente (`SOURCE`) cuando no. Convención de endurecimiento (`ce139ce`): despojar comentarios antes de casar, acotar la captura, y **comprobar por mutación** que cada test falla sin su arreglo.
- **`IS_DEMO = false`** en `src/services/firebase.js` en todo commit.
- **Un commit por tarea. Nada de `git add -A`**: el árbol tiene ficheros sin seguimiento ajenos a este trabajo (`docs/AUDITORIA-VERCEL-2026-09-02.md`, `docs/superpowers/plans/2026-09-02-fuentes-feed-correccion.md`, `financiacion/`, `prompts/`).
- Mensajes de commit en español, con el porqué medido, y terminados en `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- **Medir contra el build de producción** (`npm run build && npx vite preview --port 5174 --strictPort`), nunca contra `vite dev`: el modo desarrollo de React añade tareas de 90–135 ms que el build no tiene. El perfil con sesión es `PROFILE_DIR="$HOME/.papertok-probe-profile"` (Chrome bloquea el `--user-data-dir` mientras haya una instancia viva: ciérrala antes de medir). Las sondas ya tienen la guarda `OWN_PROFILE` y nunca borran ese perfil.
- Antes de cada commit: `npm run lint` limpio y `npm test` verde (2466 al arrancar este plan).

---

## Mapa de ficheros

| Fichero | Responsabilidad | Tareas |
|---|---|---|
| `src/context/FeedContext.jsx` | El efecto de la firma de seguidos graba su línea base sólo con cuenta conocida | 1 |
| `src/context/feedFollowChange.test.js` | Pina el efecto anterior | 1 |
| `src/hooks/heightSettlePlan.js` | Decisión pura del settle; pierde `resync` | 2 |
| `src/hooks/useHeightSettle.js` | El hook; pierde `staleMemoryRef`, la rama de cancelación y `resync` | 2 |
| `src/hooks/heightSettlePlan.test.js` | Pierde los tests de `resync` y de la rama de entrega | 2 |
| `src/components/Explorer/explorerEntrance.test.js` | Regex de la llamada al plan y de los deps del settle | 2, 3 |
| `src/components/Explorer/EntityExplorer.jsx` | El fold entra por opacidad; el settle lleva el espacio; el bloque queda montado en re-búsquedas; `WikiBlockSkeleton` fuera | 3, 4, 5 |
| `src/components/Explorer/EntityExplorer.css` | `.ehc-wiki-fold` deja de recortar; `.ehc-wiki--reserved` y el quinto peldaño fuera; comentario de la escalera | 3, 5 |
| `src/components/Explorer/explorerLoading.test.js` | Los dos tests del fold se reescriben; etiqueta de la escalera | 3, 4, 5 |
| `src/components/Explorer/explorerMotion.test.js` | Puerta de suspensión y deps del settle; etiqueta del barrido | 3, 5 |
| `src/utils/explorerSkeletonShape.js` | Un párrafo de doc que describe el despliegue de framer | 5 |
| `src/services/PaperBuilder.js` | Injerto por posición o coincidencia única | 7 |
| `src/services/PaperBuilder.test.js` | Los contraejemplos ejecutados por el revisor | 7 |
| `src/services/openAlexService.js` | Tope de `authorships` mapeados; fallback para autoría sin id | 8, 9 |
| `src/services/openAlexService.test.js` | Ambos | 8, 9 |
| `docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md` | Registra la retirada de la decisión «framer es dueño del fold» | 10 |
| `scripts/diagnostics/README.md` | Nota sobre qué mide `entity-back-frames.mjs` tras el cambio | 10 |
| `src/services/openAlexService.js` | `peekEntity(type, id)`: la entrada fresca de la caché persistente, síncrona | 11 |
| `src/components/Explorer/EntityExplorer.jsx` | `bornResolved` incluye la entidad en caché | 11 |
| `src/services/openAireService.js` | `getProjectDetails` con la misma caché de 24 h que sus vecinas | 12 |

---

# Parte A — Explorer y `FeedContext`

### Task 1: La línea base de seguidos se graba sólo con cuenta conocida

**Files:**
- Modify: `src/context/FeedContext.jsx:1637-1677` (el efecto que empieza en `const followingSignatureRef = useRef(null);`)
- Test: `src/context/feedFollowChange.test.js`

**Interfaces:**
- Consumes: `user` de `useAuth()` (ya en el ámbito del componente: la línea `}, [feedMode, feedRouteActive, ..., user?.uid, userPreferences]);` del efecto de preferencias lo prueba).
- Produces: nada nuevo; el efecto sigue llamando `reRankFeed()` y `loadPapers(true, null, true, undefined, { keepThroughVisible: true })` exactamente como hoy.

- [ ] **Step 1: Escribir el test que falla**

Añadir al final de `src/context/feedFollowChange.test.js`:

```js
/**
 * The tree no longer remounts when the uid arrives (src/utils/accountScope.js
 * adopts the first account at the same generation), so this effect used to run
 * once with `user` null and `followedEntities` empty, record '' as its baseline,
 * and then read the account's real follows landing as a follow CHANGE — a
 * re-rank and, with the recommendation profile ready, a cache wipe and a
 * replacing reload, on every signed-in cold load of '/'. FollowingContext and
 * EmailNotificationsContext were given a gate for the account arriving late;
 * this effect's ref was not. A signed-out reader has no follows to compare,
 * so waiting for the account loses nothing.
 */
test('SOURCE: the following baseline is recorded only under a known account', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const effect = bounded(
    code,
    'const followingSignatureRef = useRef(null);',
    '}, [feedRouteActive, followedEntities, followingLoading',
    'the following effect',
    46,
  );
  const guardAt = effect.search(/if \(!user\?\.uid\) \{\s*followingSignatureRef\.current = null;\s*return;\s*\}/);
  const compareAt = effect.indexOf('if (followingSignatureRef.current === signature) return;');
  assert.ok(guardAt >= 0, 'no account, no baseline: the ref is cleared and nothing is compared');
  assert.ok(guardAt < compareAt, 'decided before anything is compared or recorded');
  assert.match(
    code,
    /\}, \[feedRouteActive, followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady, user\?\.uid\]\);/,
    'the account is a dependency, so the uid arriving re-runs the effect',
  );
});
```

Y en el test existente `'SOURCE: the following effect records nothing off the feed route and compares against the last applied signature'`, cambiar el último argumento de `bounded(...)` de `40` a `46` (la guarda añade cuatro líneas a la ventana; la ventana sólo evita que la captura se desparrame).

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/context/feedFollowChange.test.js`
Expected: FAIL — `no account, no baseline: the ref is cleared and nothing is compared` (el `search` devuelve −1).

- [ ] **Step 3: Implementar la guarda**

En `src/context/FeedContext.jsx`, la declaración del ref pasa a llevar la explicación (fuera de las dos ventanas que los tests acotan):

```js
  // The last following signature the FEED applied, or null while there is no
  // account to have one. Null, not '': the tree no longer remounts when the
  // uid arrives (accountScope.js adopts the first account at the same
  // generation), so with '' recorded while the session was still unknown, the
  // account's real follows landing read as a follow CHANGE — a re-rank and,
  // with the profile ready, a replacing reload — on every signed-in cold load.
  const followingSignatureRef = useRef(null);
```

Y dentro del efecto, entre la puerta de ruta y la comparación:

```js
    if (!feedRouteActive) return;
    if (!user?.uid) {
      followingSignatureRef.current = null;
      return;
    }
    if (followingSignatureRef.current === signature) return;
```

Y la lista de dependencias del efecto, añadiendo `user?.uid` **al final** (los tests casan el prefijo):

```js
  }, [feedRouteActive, followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady, user?.uid]);
```

- [ ] **Step 4: Comprobar que pasa, y que sigue pasando el resto**

Run: `node --test src/context/feedFollowChange.test.js src/context/feedFirstPaint.test.js`
Expected: PASS en todos (el test de la ventana de 12 líneas de `feedFirstPaint` no se ve afectado: la guarda está después de `const signature`).

- [ ] **Step 5: Comprobar por mutación**

Quitar temporalmente las cuatro líneas de la guarda y correr el test: debe fallar. Restaurarlas. Después, quitar `user?.uid` de los deps y correr: debe fallar por el tercer `assert.match`. Restaurar.

- [ ] **Step 6: Lint, suite entera y commit**

```bash
npm run lint && npm test
git add src/context/FeedContext.jsx src/context/feedFollowChange.test.js
git commit -F - <<'EOF'
fix(feed): la línea base de seguidos espera a conocer la cuenta

Al dejar de remontar el árbol cuando llega el uid (accountScope.js), el efecto
de la firma de seguidos corría una vez con `user` null y `followedEntities`
vacío, grababa '' como línea base, y leía la llegada de los seguidos reales
como un CAMBIO de seguidos: `reRankFeed()` y, con el perfil de recomendación
listo, borrado de la caché y recarga sustitutiva — en cada carga fría con
sesión de '/'. FollowingContext y EmailNotificationsContext recibieron su
portillo para la cuenta que llega tarde; el ref de este efecto no.

Sin cuenta el ref vuelve a null y no se compara nada: un lector sin sesión no
tiene seguidos que comparar, así que esperar no pierde nada. `user?.uid` entra
en los deps para que la llegada del uid re-ejecute el efecto.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 2: El hook pierde `resync`, `staleMemoryRef` y la rama de entrega

**Files:**
- Modify: `src/hooks/heightSettlePlan.js` (firma y doc de `planHeightSettle`)
- Modify: `src/hooks/useHeightSettle.js` (todo el cuerpo del efecto y el bloque de doc)
- Modify: `src/hooks/heightSettlePlan.test.js:132-185` (cuatro tests se van)
- Modify: `src/components/Explorer/explorerEntrance.test.js:74` (regex de la llamada al plan)

**Interfaces:**
- Produces: `planHeightSettle({ remembered, depsChanged, running, current, natural, suspended })` — sin `resync`. `useHeightSettle(ref, deps, { enabled, suspended, duration, easing })` — misma firma pública; lo que cambia es que ya no hay ningún estado entre commits salvo la memoria de altura y de deps.
- La Tarea 3 depende de esto: al quitar el latch del fold, el único `suspended` que queda es `isPageArriving`, y con él la rama `standDown && inFlight` es inalcanzable (no hay settle en vuelo antes de que la página haya llegado).

- [ ] **Step 1: Quitar los tests que pinan lo que se va**

En `src/hooks/heightSettlePlan.test.js` borrar íntegros, con sus comentarios de cabecera:
- `test('SOURCE: a suspended commit hands the box over instead of leaving it clipped', ...)` (y el bloque `/** A suspended commit means another owner... */` que lo precede)
- `test('the first commit after another owner had the box re-syncs instead of animating from a stale height', ...)` (y su bloque `/** The memory kept while another owner... */`)
- `test('re-syncing leaves the memory on the truth, so the NEXT change settles from it', ...)`
- `test('SOURCE: the hook raises the stale flag while suspended and spends it on the next commit', ...)`

Y **añadir** en su lugar, después de `test('suspension is not the same as no change: ...')`:

```js
/**
 * Suspension was briefly a second thing as well — a latch a child raised while
 * animating its own height — and the hook grew a `resync` for it: the memory
 * taken while suspended was a frame of THAT animation, so the first commit
 * after it re-synced instead of animating. Measured 2026-09-09, it also fired
 * for the route arrival, where the memory was honest (the page travels by
 * transform), and snapped the skeleton→hero handover on every forward or back
 * navigation. There is one suspender again, and the memory it keeps is true,
 * so nothing re-syncs: the first change after the page lands animates from it.
 */
test('there is no resync: the first change after a suspended commit animates from the memory it kept', () => {
  const suspended = planHeightSettle({ remembered: 114, depsChanged: true, running: null, current: null, natural: 316.8, suspended: true });
  assert.deepEqual(
    planHeightSettle({ remembered: suspended.remember, depsChanged: true, running: null, current: null, natural: 380, suspended: false, resync: true }),
    { action: 'animate', from: 316.8, to: 380, remember: 380 },
    'a stray `resync: true` must change nothing — the option is gone',
  );
});

test('SOURCE: the hook keeps no memory between commits beyond the height and the deps', async () => {
  const code = await hookSource();
  assert.doesNotMatch(code, /staleMemoryRef/, 'no stale flag');
  assert.doesNotMatch(code, /resync/, 'no resync');
  assert.doesNotMatch(code, /if \(standDown && inFlight\)/, 'no hand-over branch: with the route arrival as the only suspender there is never a settle in flight to hand over');
  assert.match(code, /const plan = planHeightSettle\(\{ remembered: lastHeightRef\.current, depsChanged, running, current, natural, suspended: standDown \}\);/);
});
```

- [ ] **Step 2: Comprobar que los nuevos fallan**

Run: `node --test src/hooks/heightSettlePlan.test.js`
Expected: FAIL en los dos nuevos (`staleMemoryRef` sigue en el fuente; y el plan devuelve `'none'` con `resync: true`).

- [ ] **Step 3: `heightSettlePlan.js` sin `resync`**

Sustituir la firma y la primera guarda:

```js
export function planHeightSettle({ remembered, depsChanged, running, current, natural, suspended }) {
  const remember = natural;
  // Checked before the in-flight branch: a suspended commit decides nothing
  // about an animation that is already running, it simply does not start one.
  if (suspended) return { action: 'none', remember };
```

Y en el bloque de doc, borrar el bullet ` - \`resync\`: ...` entero (seis líneas) y dejar el de `suspended` tal cual.

- [ ] **Step 4: `useHeightSettle.js` sin latch**

Sustituir desde `export function useHeightSettle(` hasta el final del fichero por:

```js
export function useHeightSettle(ref, deps, { enabled = true, suspended, duration = 360, easing = EASE } = {}) {
  const lastHeightRef = useRef(null);
  const lastDepsRef = useRef(null);

  useLayoutEffect(() => {
    const depsChanged = !depsAreSame(lastDepsRef.current, deps);
    lastDepsRef.current = deps;
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== 'function') {
      lastHeightRef.current = null;
      return;
    }
    const inFlight = typeof el.getAnimations === 'function'
      ? el.getAnimations().find((animation) => animation.id === SETTLE_ID)
      : null;
    // Asked here, before anything is cancelled: the DOM knows whether the page
    // is still moving, and it knows it now.
    const standDown = typeof suspended === 'function' && suspended();
    let running = null;
    let current = null;
    if (inFlight) {
      const [start, end] = inFlight.effect.getKeyframes();
      running = { from: parseFloat(start.height), to: parseFloat(end.height), currentTime: inFlight.currentTime || 0 };
      current = el.getBoundingClientRect().height;
      inFlight.cancel();
    }
    const natural = el.getBoundingClientRect().height;
    const plan = planHeightSettle({ remembered: lastHeightRef.current, depsChanged, running, current, natural, suspended: standDown });
    lastHeightRef.current = plan.remember;
    if (!enabled || plan.action === 'none' || typeof el.animate !== 'function') return;
    if (!restingOverflow.has(el)) restingOverflow.set(el, el.style.overflow);
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [{ height: `${plan.from}px` }, { height: `${plan.to}px` }],
      { duration, easing },
    );
    animation.id = SETTLE_ID;
    if (plan.action === 'resume') animation.currentTime = plan.currentTime;
    const release = () => {
      // A newer settle may have taken over the box; it will release it.
      if (el.getAnimations().some((other) => other.id === SETTLE_ID)) return;
      el.style.overflow = restingOverflow.get(el) ?? '';
      restingOverflow.delete(el);
    };
    animation.finished.then(release, release);
  });
}
```

Y en el bloque de doc del hook, sustituir el último párrafo (el que empieza «`enabled: false` keeps the memory up to date…» y termina «…a worse defect than the one the gate was for.») por:

```js
 * `enabled: false` keeps the memory up to date without animating (reduced
 * motion). `suspended` is the same thing decided per commit rather than per
 * render: a function asked, inside the layout effect, whether this particular
 * change should be carried or snapped. It exists because the answer — "is the
 * route transition still moving this page?" — is only true for a few hundred
 * milliseconds and a React flag for it arrives late. Measured 2026-09-07: with
 * the gate on a state flag, the page was visually at rest (opacity 1,
 * translate 0) at 302ms but `animationend` had not been committed yet, and the
 * skeleton-to-hero handover landing at 329ms in that 38ms window was snapped
 * 115.8px instead of settled — a worse defect than the one the gate was for.
 *
 * ONE owner of the height, and this hook is it. For two days (2026-09-08/09)
 * a child was allowed to animate its own height inside the settled box — the
 * Wikipedia fold — and the hook grew a latch, a stale-memory flag, a re-sync
 * and a hand-over branch to reconcile the two. Measured, the reconciliation
 * was the bug: the re-sync fired for the route arrival too, where the memory
 * was honest, and snapped the handover on every navigation. A block that
 * arrives inside this box animates its CONTENTS (opacity), and the box's
 * growth — the space, and everything below it — is carried here.
```

- [ ] **Step 5: Regex de `explorerEntrance.test.js`**

Línea 74, sustituir:

```js
  assert.match(hook, /const plan = planHeightSettle\(\{ remembered: lastHeightRef\.current, depsChanged, running, current, natural, suspended: standDown \}\);/);
```

- [ ] **Step 6: Comprobar que pasa**

Run: `node --test src/hooks/heightSettlePlan.test.js src/components/Explorer/explorerEntrance.test.js`
Expected: PASS.

Nota: `EntityExplorer.jsx` todavía llama al hook con `suspended: settleSuspended` (que OR-ea el latch del fold). Eso sigue compilando — el hook simplemente ya no re-sincroniza. La Tarea 3 quita el latch. Entre esta tarea y la siguiente el árbol es coherente: el fold de framer sigue animando su altura y el settle sigue de pie durante ese fold; lo único que cambia es que el primer dato tras una llegada vuelve a asentarse.

- [ ] **Step 7: Lint, suite entera y commit**

```bash
npm run lint && npm test
git add src/hooks/heightSettlePlan.js src/hooks/useHeightSettle.js src/hooks/heightSettlePlan.test.js src/components/Explorer/explorerEntrance.test.js
git commit -F - <<'EOF'
fix(explorer): el settle deja de re-sincronizar, y con ello de saltar la entrega tras cada llegada

`staleMemoryRef.current = standDown` levantaba la marca de memoria rancia en
TODOS los commits suspendidos, también los suspendidos sólo porque la ruta
estaba llegando — donde la página viaja por transform y la altura del héroe es
honesta. El primer commit del Explorer tras la transición tomaba la rama
`resync` y el plan devolvía 'none' sin mirar los deps: la entrega
esqueleto→héroe (+115,8 px), y la tarjeta ORCID con su panel, saltaban en un
fotograma en toda navegación hacia delante o atrás — medido en producción el
09-09, institución → autor: +152,3 px en un fotograma a 642 ms del reposo,
sin ningún settle. El defecto exacto que el predicado del DOM de 7c549c4
existía para quitar. Y heightSettlePlan.test.js:86 certificaba lo contrario
porque nunca pasaba `resync`.

El re-sync existía para un segundo dueño de la altura (el fold de Wikipedia
animando la suya). Ese segundo dueño desaparece en el commit siguiente; con la
llegada de ruta como único suspensor, la memoria que el hook guarda es siempre
verdadera y no hay nada que re-sincronizar. Se van `resync`, `staleMemoryRef`
y la rama `standDown && inFlight` (inalcanzable: no hay settle en vuelo antes
de que la página haya llegado).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 3: El settle lleva el espacio del bloque de Wikipedia; el fold entra por opacidad

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx` — imports (línea 1), constantes `HERO_STACK_GAP_PX` (:67) y `WIKI_FOLD_OUT` (:117-126), el bloque `heroBodyRef`/`wikiFoldAnimatingRef`/`settleSuspended`/`useHeightSettle`/efecto de reinicio (:483-532), `measureExpandableDescriptions` y su efecto (:548-563), el `<motion.div className="ehc-wiki-fold">` (:2088-2137)
- Modify: `src/components/Explorer/EntityExplorer.css` — la regla `.ehc-wiki-fold { overflow: hidden; }` y su comentario (`grep -n "ehc-wiki-fold"`)
- Modify: `src/components/Explorer/explorerLoading.test.js` (dos tests: «waits for its lookup to settle…» y «folds inside a wrapper…»)
- Modify: `src/components/Explorer/explorerMotion.test.js` (dos tests: «stands down while the page is still arriving» y «does not chase the Wikipedia block»)
- Modify: `src/components/Explorer/explorerEntrance.test.js:43` (regex de la llamada al settle)

**Interfaces:**
- Consumes: `planHeightSettle`/`useHeightSettle` de la Tarea 2 (sin `resync`).
- Produces: la llamada `useHeightSettle(heroBodyRef, [isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage, showWikiBlock, wikiDescription, isWikiRequestPending], { enabled: !prefersReducedMotion, suspended: isPageArriving, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' })`. La Tarea 4 conserva esa lista y sólo cambia cómo se calcula `showWikiBlock`.

- [ ] **Step 1: Reescribir los tests que pinan el diseño anterior**

En `src/components/Explorer/explorerLoading.test.js`, sustituir el test `'the Wikipedia block waits for its lookup to settle, then arrives as one mount'` y su comentario de cabecera por:

```js
/**
 * The block arrives rather than appears, and the hero's settle is what carries
 * its space. It mounts once its lookup has settled with everything it is going
 * to have, its CONTENTS fade in, and the box grows under the settle's clip —
 * the same arrival the ORCID card and the experience panel already make. For
 * two days (3b96b3a → aea5a59) the fold animated its own `height: 'auto'` and
 * the settle stood down behind a latch; measured 2026-09-09, that latch, its
 * re-sync and its hand-over branch were the bug (a snapped handover on every
 * navigation, a mid-exit height animated from, a homepage-only block left
 * clamped). One owner of the height, and it is not framer.
 */
test('the Wikipedia block arrives under the settle: its fold animates opacity only', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  const fold = jsx.match(/<motion\.div\s+className="ehc-wiki-fold"([\s\S]*?)>\s*<div\s+className=\{`ehc-wiki /);
  assert.ok(fold, 'the fold is a motion wrapper around the padded `.ehc-wiki`');
  assert.match(fold[1], /initial=\{\{ opacity: 0 \}\}/, 'it starts invisible, at its full height');
  assert.match(fold[1], /animate=\{\{ opacity: 1 \}\}/);
  assert.match(fold[1], /exit=\{\{ opacity: 0, transition: \{ duration: 0\.15 \} \}\}/, 'it leaves the way it came, quickly — the settle closes the space after it');
  assert.doesNotMatch(fold[1], /height/, 'framer never touches the height: the settle owns it');
  assert.doesNotMatch(fold[1], /marginTop|\by:/, 'nor the margin or a translate: nothing here moves layout');
  assert.doesNotMatch(fold[1], /onAnimationStart|onAnimationComplete|layout/, 'no latch, no projection');
  assert.doesNotMatch(jsx, /wikiFoldAnimatingRef|WIKI_FOLD_OUT|HERO_STACK_GAP_PX/, 'and nothing is left of the second owner');
});
```

`explorerLoading.test.js` sólo define `read`; añadir en su cabecera, justo debajo de `const read = ...` (línea 5), el mismo helper que `explorerMotion.test.js:6` ya tiene:

```js
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
```

Y sustituir el test `'the Wikipedia block folds inside a wrapper that also absorbs the stack gap'` y su comentario por:

```js
/**
 * With the settle owning the space, the fold's wrapper has nothing to clip: the
 * hero body clips while it grows. A leftover `overflow: hidden` on the wrapper
 * would only cut the paragraph's own "Read more" transition.
 */
test('the fold wrapper is a plain box now', async () => {
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki-fold \{/, 'no rule of its own');
});
```

En `src/components/Explorer/explorerMotion.test.js`, en el test `'the hero settle stands down while the page is still arriving'`, sustituir las cinco líneas desde `assert.match(call[1], /suspended: settleSuspended/,` hasta `assert.match(gate[1], /wikiFoldAnimatingRef\.current/);` por:

```js
  assert.match(call[1], /suspended: isPageArriving/,
    'and the route transition suspends it per commit — a render-time boolean answers 38ms late');
  // ONE suspender. There was briefly a second — a latch the Wikipedia fold
  // raised while animating its own height — and it is what the 2026-09-09
  // review found at the root of three defects.
  assert.doesNotMatch(code, /settleSuspended|wikiFoldAnimatingRef/, 'no OR of owners: the arrival is the only thing that stands the settle down');
```

Y sustituir el test `'the settle does not chase the Wikipedia block, which animates its own arrival'` y su comentario por:

```js
/**
 * One owner per displacement, and the settle is it. The Wikipedia block's
 * mount, its rows-to-prose swap and its re-lookup all change the hero's height,
 * so all three are deps: the box settles to each, and the block's own motion is
 * opacity only (explorerLoading.test.js pins the fold).
 */
test('the settle carries the Wikipedia block: its mount and its contents are deps', async () => {
  const code = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  const deps = code.match(/useHeightSettle\(\s*heroBodyRef,\s*\[([^\]]*)\]/);
  assert.ok(deps, 'the settle declares what is worth a movement');
  for (const dep of ['isLoadingEntity', 'entity', 'orcidInfo', 'isLoadingOrcid', 'recentImpact', 'hasLoadedWikiImage', 'showWikiBlock', 'wikiDescription', 'isWikiRequestPending']) {
    assert.match(deps[1], new RegExp(`\\b${dep}\\b`), `${dep} settles`);
  }
});
```

En `src/components/Explorer/explorerEntrance.test.js:43`, sustituir el regex de la llamada por:

```js
  assert.match(jsx, /const heroBodyRef = useRef\(null\);[\s\S]*?useHeightSettle\(\s*heroBodyRef,\s*\[isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage, showWikiBlock, wikiDescription, isWikiRequestPending\],\s*\{ enabled: !prefersReducedMotion, suspended: isPageArriving, easing: 'cubic-bezier\(0\.4, 0, 0\.2, 1\)' \},\s*\);/);
```

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js src/components/Explorer/explorerEntrance.test.js`
Expected: FAIL en los cuatro tests reescritos.

- [ ] **Step 3: Quitar las constantes y el latch**

En `src/components/Explorer/EntityExplorer.jsx`:

(a) Borrar la línea `const HERO_STACK_GAP_PX = 16;` (:67) y el comentario que la precede si sólo habla de ella.

(b) Borrar la constante `WIKI_FOLD_OUT = { ... };` entera (:117-126, incluidos sus comentarios). Ajustar el comentario de `EXPERIENCE_FOLD_OUT` (:107-110) para que no la cite: sustituir «Same reasoning as WIKI_FOLD_OUT below: what travels is the page under the panel, and it has to land, so the space rides a gentle ease-in-out while the contents leave on the house exit curve. Shorter than the wiki fold's 480ms because this one is a click's answer, not a network response resolving — the reader is waiting on it.» por «What travels is the page under the panel, and it has to land, so the space rides a gentle ease-in-out while the contents leave on the house exit curve. 300ms because this is a click's answer — the reader is waiting on it.»

(c) Sustituir el bloque desde `  // True while the Wikipedia fold is animating its OWN height.` (justo después de `const heroBodyRef = useRef(null);`) hasta el cierre `  }, [showWikiBlock]);` del efecto de reinicio, por:

```js
  useHeightSettle(
    heroBodyRef,
    // Everything that changes this box's height and is worth a movement. The
    // Wikipedia block's three are here on purpose: for two days they were
    // deliberately left out so the fold could animate its own height, and the
    // settle grew a latch, a re-sync and a hand-over to stay out of its way —
    // measured 2026-09-09, that machinery was the bug. One owner: the block's
    // contents fade in, and its SPACE is carried here like the ORCID card's.
    [isLoadingEntity, entity, orcidInfo, isLoadingOrcid, recentImpact, hasLoadedWikiImage, showWikiBlock, wikiDescription, isWikiRequestPending],
    // A gentle ease-in-out rather than the hook's expo-out default. What
    // travels here is everything under the hero — the tab strip, the list —
    // and on a phone a 268px ORCID arrival on the expo-out spent 70px of it
    // in a single frame. The page has to land, not appear.
    // Not while the page is arriving. A settle carries a datum that lands late
    // on a page at rest; under a route transition it is a second owner of the
    // same displacement, on a different clock. Measured stepping back from an
    // author to its institution: four settles in 76ms, each restarting a full
    // 360ms, and the tab strip dipping 16px instead of being where it was left.
    { enabled: !prefersReducedMotion, suspended: isPageArriving, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
```

- [ ] **Step 4: La medida de expandibilidad vuelve a ser pasiva**

Sustituir (:561-563):

```js
  useEffect(() => {
    const frame = window.requestAnimationFrame(measureExpandableDescriptions);
    return () => window.cancelAnimationFrame(frame);
  }, [entity?.summary, measureExpandableDescriptions, wikiDescription]);
```

(Era un `useLayoutEffect` desde `aea5a59` para que el `height: 'auto'` de framer midiera con el botón «Leer más» ya montado. Framer ya no mide alturas aquí; y el `useLayoutEffect` costaba un render síncrono del Explorer entero antes de pintar en cada entrega.) Quitar `useLayoutEffect` del import de la línea 1 si `grep -n useLayoutEffect src/components/Explorer/EntityExplorer.jsx` no devuelve ningún otro uso.

- [ ] **Step 5: El fold entra por opacidad**

Sustituir el `<motion.div className="ehc-wiki-fold" ... >` completo, desde `<motion.div` hasta el `>` que cierra sus props (justo antes de `<div className={\`ehc-wiki ...`), por:

```jsx
              <motion.div
                className="ehc-wiki-fold"
                // Opacity only. The hero body's settle carries this block's
                // SPACE (it is in the settle's deps), so the box grows under
                // its clip and reveals the block from the top while everything
                // below rides the same 360ms — the arrival the ORCID card and
                // the experience panel already make. A second animator of the
                // height here was measured, twice, as the defect: a `layout`
                // projection scaled the paragraph while the body settled
                // (scaleY 1.21 for 380ms), and a `height: 'auto'` fold with the
                // settle latched behind it snapped the handover on every
                // navigation (2026-09-09). The words fade in over 240ms so they
                // are readable while the box is still opening; leaving is
                // quick, and the settle closes the space after the fade.
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.24 }}
              >
```

Comprobar que el comentario JSX que precede a `<AnimatePresence initial={false}>` (el que empieza «Wikipedia or external info, and it ARRIVES rather than appears.») deja de decir «unfolds from nothing»: sustituir su segundo párrafo («It mounts when its lookup has SETTLED now, with everything it is ever going to have, and unfolds from nothing. Gated on settled rather than on content: …») por:

```
              It mounts when its lookup has SETTLED, with everything it is ever
              going to have, and the hero's settle grows the box around it.
              Gated on settled rather than on content: mounting early on
              `homepage_url` alone — which the entity carries and the lookup does
              not — would put the block on screen before the prose and settle it
              a second time when the paragraph came. One mount, one settle.
```

- [ ] **Step 6: CSS del wrapper**

En `src/components/Explorer/EntityExplorer.css` borrar la regla y su comentario (localizar con `grep -n "ehc-wiki-fold"`):

```css
/* The fold around the block: a box with no padding or border of its own, so
   its `height` can reach zero (EntityExplorer.jsx animates it, together with
   a negative top margin that takes the stack gap out). `overflow: hidden` is
   what clips the block while the fold closes. */
.ehc-wiki-fold {
  overflow: hidden;
}
```

- [ ] **Step 7: Comprobar que pasan, lint y suite entera**

Run: `npm run lint && npm test`
Expected: lint limpio; PASS. Si `explorerReservation.test.js` o `explorerMotion.test.js` fallan por una referencia a `HERO_STACK_GAP_PX` en un regex que no está en este plan, sustituir esa referencia por nada y anotarlo en el commit.

- [ ] **Step 8: Comprobar por mutación**

Volver a poner `height: 'auto'` en `animate` del fold: `explorerLoading.test.js` debe fallar en «framer never touches the height». Restaurar. Quitar `showWikiBlock` de los deps del settle: `explorerMotion.test.js` debe fallar en «showWikiBlock settles». Restaurar.

- [ ] **Step 9: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js src/components/Explorer/explorerEntrance.test.js
git commit -F - <<'EOF'
fix(explorer): el settle vuelve a ser el único dueño de la altura del héroe

Durante dos días (3b96b3a → aea5a59) el fold de Wikipedia animó su propia
`height: 'auto'` dentro de la caja que ya anima useHeightSettle, y para que no
se pisaran el hook ganó un latch, una marca de memoria rancia, un re-sync y una
rama de entrega, y el componente un efecto de reinicio, una medida síncrona
antes de pintar y la retirada deliberada de tres deps. La revisión del 09-09
midió ese andamiaje como la causa de tres defectos: la entrega esqueleto→héroe
saltaba en toda navegación, un dato que llegara durante el plegado de salida
animaba desde una altura a medio plegar, y un bloque con sólo `homepage_url`
quedaba recortado bajo un settle en vuelo.

El propio fichero ya lo decía (2080: «el settle ya lleva esta altura; una
proyección encima era un segundo dueño del mismo número»), y el panel de
experiencia ya entra así en la misma caja: monta a su altura y sólo su
contenido se funde. El fold hace ahora lo mismo — opacidad, 240 ms de entrada,
150 de salida — y su espacio lo lleva el settle bajo su recorte, con
`showWikiBlock`, `wikiDescription` e `isWikiRequestPending` de vuelta en los
deps. Se van `wikiFoldAnimatingRef`, `settleSuspended`, `WIKI_FOLD_OUT`,
`HERO_STACK_GAP_PX`, el efecto de reinicio y el `useLayoutEffect` de medida.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 4: El bloque queda montado a través de una re-búsqueda

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx` — estado nuevo junto a `settledWikiRequestKey` (:277), el reset por entidad (:662, junto a `setWikiInfo(null)`), el cálculo de `showWikiBlock` (:465-467), el comentario de la rama interna del esqueleto (:2148-2160)
- Modify: `src/components/Explorer/explorerLoading.test.js` (un test nuevo)

**Interfaces:**
- Consumes: `isWikiRequestPending`, `wikiDescription`, `entity?.homepage_url` ya calculados; `useHeightSettle` con `showWikiBlock` en deps (Tarea 3).
- Produces: `const [wikiBlockOpened, setWikiBlockOpened] = useState(false)` y `showWikiBlock` con la semántica «abierto una vez con contenido, y desde entonces mientras haya contenido O una búsqueda en curso».

- [ ] **Step 1: Test que falla**

Añadir a `src/components/Explorer/explorerLoading.test.js`, después del test `'the Wikipedia block arrives under the settle...'`:

```js
/**
 * Once open, the block stays open across a RE-lookup. `wikiRequestKey` carries
 * the language and the localized name, so switching the app language on an
 * institution (or a localized name landing late) starts a new lookup; gated on
 * `!isWikiRequestPending` alone, that unmounted the block — a 480ms fold-out,
 * the list rising — and mounted it again when the new paragraph came. Reported
 * and reproduced 2026-09-09. Open once with content, the block holds its rows
 * while the new lookup is out and swaps them for the prose in place, which is
 * what the pre-3b96b3a code did and what the in-fold skeleton branch is for.
 */
test('the Wikipedia block opens once, and a re-lookup swaps its contents in place', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /const \[wikiBlockOpened, setWikiBlockOpened\] = useState\(false\);/);
  // Adjusted during render — the documented way to derive state from a prop —
  // so the commit that settles with content is the one that opens the block.
  assert.match(
    jsx,
    /const wikiHasContent = Boolean\(wikiDescription \|\| entity\?\.homepage_url\);\s*if \(!isWikiRequestPending && wikiHasContent && !wikiBlockOpened\) setWikiBlockOpened\(true\);/,
  );
  assert.match(jsx, /const showWikiBlock = wikiBlockOpened && \(wikiHasContent \|\| isWikiRequestPending\);/,
    'held open through a re-lookup, and closed only when a settled lookup finds nothing');
  // Per entity, from closed: the next page's first lookup opens it again.
  const reset = jsx.match(/setWikiInfo\(null\);([\s\S]{0,400})/);
  assert.ok(reset && /setWikiBlockOpened\(false\);/.test(reset[1]), 'reset with the rest of the wiki state when the entity changes');
  assert.match(jsx, /\{isWikiRequestPending \? \(\s*<div className="ehc-wiki-skeleton" role="status"/, 'the rows inside the block are what a re-lookup shows');
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/components/Explorer/explorerLoading.test.js`
Expected: FAIL — `wikiBlockOpened` no existe.

- [ ] **Step 3: Implementar**

(a) Junto a `const [settledWikiRequestKey, setSettledWikiRequestKey] = useState('');` (:277) añadir:

```js
  // Whether this entity's Wikipedia block has opened. Once it has, a re-lookup
  // (the language changed, a localized name landed) keeps it mounted on its
  // rows instead of folding it out and in — see `showWikiBlock`.
  const [wikiBlockOpened, setWikiBlockOpened] = useState(false);
```

(b) En el bloque de reset por entidad, justo después de `setWikiInfo(null);` (:662):

```js
      setWikiBlockOpened(false);
```

(c) Sustituir las tres líneas de `showWikiBlock` (:465-467, comentario incluido) por:

```js
  // The block opens the first time its lookup settles WITH content — never on
  // `homepage_url` alone while the prose is still out, which would settle the
  // box twice — and stays open from then on through a re-lookup, holding its
  // rows until the new paragraph replaces them in place. Closed only by a
  // settled lookup that finds nothing. Adjusted during render, the documented
  // way to derive state from a prop, so the settling commit is the opening one.
  const wikiHasContent = Boolean(wikiDescription || entity?.homepage_url);
  if (!isWikiRequestPending && wikiHasContent && !wikiBlockOpened) setWikiBlockOpened(true);
  const showWikiBlock = wikiBlockOpened && (wikiHasContent || isWikiRequestPending);
```

(d) En la rama interna del esqueleto (:2148-2160), sustituir el comentario que empieza «Three lines because the collapsed paragraph is clamped…» por:

```
                    {/* A re-lookup, not the first one: the block is already
                        open and holds its rows until the new paragraph
                        replaces them in the same commit. Three lines because
                        the collapsed paragraph is clamped to exactly three,
                        then the show-more toggle, then the source links —
                        146px where 155px arrives, and the settle carries
                        those 9px. */}
```

- [ ] **Step 4: Comprobar que pasa; lint; suite**

Run: `npm run lint && npm test`
Expected: PASS. El regex de `showWikiBlock` en la Tarea 3 (`explorerLoading.test.js`, test «arrives under the settle») no lo pina, así que no cambia.

- [ ] **Step 5: Mutación**

Volver a `const showWikiBlock = !isWikiRequestPending && wikiHasContent;` → el test nuevo falla en «held open through a re-lookup». Restaurar.

- [ ] **Step 6: Commit**

```bash
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerLoading.test.js
git commit -F - <<'EOF'
fix(explorer): el bloque de Wikipedia se queda montado durante una re-búsqueda

`wikiRequestKey` lleva el idioma y el nombre localizado, así que cambiar de
idioma en una institución (o una localización que aterriza tarde) arranca una
búsqueda nueva. Montado sólo con `!isWikiRequestPending`, el bloque se
desmontaba en ese instante — 480 ms de plegado, la lista subiendo ~155 px — y
volvía a montarse con el párrafo nuevo. Reproducido el 09-09: determinista.

Abierto una vez con contenido, el bloque se queda a través de la re-búsqueda
sobre sus filas grises y el párrafo las sustituye en el mismo commit — lo que
hacía el código anterior a 3b96b3a, y para lo que existe la rama interna del
esqueleto (que desde 3b96b3a era inalcanzable). Sólo lo cierra una búsqueda
asentada que no encuentra nada.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 5: Código muerto de la reserva fuera, escalera re-etiquetada

**Files:**
- Modify: `src/components/Explorer/EntityExplorer.jsx` — `WikiBlockSkeleton` (:155-172) y su sitio (:1455)
- Modify: `src/components/Explorer/EntityExplorer.css` — la regla `.ehc-wiki--reserved { width: 100%; }` y su comentario; la línea `.explorer-skeleton .ehc-wiki-skeleton span:nth-child(5)::after { animation-delay: 0.39s; }`; y el comentario `/* An institution's Wikipedia paragraph rides the same sweep ... */` que precede a la escalera (localizarlos con `grep -n`, los números de línea de este fichero se mueven)
- Modify: `src/utils/explorerSkeletonShape.js` (un párrafo de doc)
- Modify: `src/components/Explorer/explorerLoading.test.js:46` y `explorerMotion.test.js:268` (etiquetas)

**Interfaces:** ninguna nueva. Sólo retira lo que la Tarea 3 dejó sin alcanzar y corrige etiquetas.

- [ ] **Step 1: Test que falla**

Añadir a `src/components/Explorer/explorerLoading.test.js`:

```js
test('nothing is left of the page skeleton reserving the Wikipedia block', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(jsx, /WikiBlockSkeleton/, "explorerSkeletonShape never answers 'wiki' any more, so the component was unreachable");
  const css = stripComments(await read('./EntityExplorer.css'));
  assert.doesNotMatch(css, /\.ehc-wiki--reserved/);
  assert.doesNotMatch(css, /\.explorer-skeleton \.ehc-wiki-skeleton span:nth-child\(5\)/, 'no skeleton under the page skeleton has a fifth span (the in-block rows of a re-lookup do, and keep theirs)');
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/components/Explorer/explorerLoading.test.js`
Expected: FAIL en las tres aserciones.

- [ ] **Step 3: Borrar**

(a) `EntityExplorer.jsx`: borrar el bloque de doc `/** The Wikipedia paragraph before it has been fetched. ... */` y `const WikiBlockSkeleton = () => ( ... );` (:155-172). Borrar la línea `{shape.aside === 'wiki' && <WikiBlockSkeleton />}` (:1455). En el comentario JSX que la precede, sustituir «an author's ORCID card, an institution's Wikipedia paragraph. A project carries neither — its summary is optional — so it reserves nothing rather than inventing a block that would then have to collapse.» por «an author's ORCID card, a project's summary box. The Wikipedia block is not reserved: it arrives under the settle once its lookup settles (explorerSkeletonShape.js says why a reservation and an arrival cannot both be right).»

(b) `EntityExplorer.css`: borrar el comentario `/* Reserved rather than live: ... */` y la regla `.ehc-wiki--reserved { width: 100%; }`. Borrar la línea `.explorer-skeleton .ehc-wiki-skeleton span:nth-child(5)::after { animation-delay: 0.39s; }`. Sustituir el comentario `/* An institution's Wikipedia paragraph rides the same sweep from its own
   spans, so it is phased through those. */` por:

```css
/* The project summary's rows (ProjectSummarySkeleton borrows the Wikipedia
   block's line box: three lines and a toggle) ride the same sweep, phased
   through their own spans. */
```

(c) `explorerSkeletonShape.js`: en el párrafo que empieza «The Wikipedia block is NOT among them: it was reserved here between 2026-09-06 and 2026-09-08…», sustituir «it mounts when its lookup settles and unfolds from nothing (EntityExplorer.jsx)» por «it mounts when its lookup settles and the hero's settle grows the box around it (EntityExplorer.jsx)».

(d) `explorerLoading.test.js:46`: la etiqueta `'the Wikipedia lines'` → `'the project summary lines'`. `explorerMotion.test.js:268`: `'both the shapes and the wiki lines carry the sweep'` → `'both the shapes and the summary lines carry the sweep'`.

- [ ] **Step 4: Comprobar; lint; suite; commit**

```bash
npm run lint && npm test
git add src/components/Explorer/EntityExplorer.jsx src/components/Explorer/EntityExplorer.css src/utils/explorerSkeletonShape.js src/components/Explorer/explorerLoading.test.js src/components/Explorer/explorerMotion.test.js
git commit -F - <<'EOF'
chore(explorer): fuera el esqueleto de Wikipedia que ya no se reservaba

`explorerSkeletonShape` dejó de contestar 'wiki' en 3b96b3a, así que
`WikiBlockSkeleton`, su sitio, `.ehc-wiki--reserved` y el quinto peldaño de la
escalera eran inalcanzables — y sus comentarios describían una reserva que se
había retirado a propósito. La escalera de retardos sigue viva para las cuatro
filas del resumen de proyecto, que toman prestado el mismo line box; ahora
está etiquetada por lo que fasea, no por lo que faseaba.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 6: Verificación en vivo de la Parte A

**Files:**
- Create (scratch, fuera del repo): `/tmp/papertok-lang-probe.mjs`
- Usa: `scripts/diagnostics/explorer-hero-frames.mjs`, `scripts/diagnostics/entity-back-frames.mjs`

**Interfaces:** ninguna. Esta tarea no cambia código; produce números para el commit de la Tarea 10.

- [ ] **Step 1: Build de producción y servidor**

```bash
grep -n "^export const IS_DEMO = false" src/services/firebase.js && npm run build && (npx vite preview --port 5174 --strictPort &)
```

Si el usuario no ha iniciado sesión en `~/.papertok-probe-profile` en esta máquina, pedirle que abra `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9223 --user-data-dir="$HOME/.papertok-probe-profile" --no-first-run --no-default-browser-check http://localhost:5174`, inicie sesión, y **cierre esa ventana**. Nunca pedirle credenciales ni escribirlas en ningún sitio.

- [ ] **Step 2: Institución en frío — el bloque llega como un settle, no como un salto**

```bash
pkill -f papertok-probe-profile; sleep 2
PROFILE_DIR="$HOME/.papertok-probe-profile" PORT=9340 ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/institution/I136199984' 9000 > /tmp/inst-after.txt 2>&1
node -e "
const rows=require('fs').readFileSync('/tmp/inst-after.txt','utf8').split('\n').filter(l=>l.startsWith('{\"t\"')).map(l=>JSON.parse(l));
let prev=null,jumps=[],settles=new Set();
for(const r of rows){const t=r.tabs?parseFloat(r.tabs):null;
 if(prev!==null&&t!==null&&Math.abs(t-prev)>=30) jumps.push('t='+r.t+' '+(t-prev).toFixed(1));
 if(t!==null)prev=t; if(r.settle) settles.add(r.settle.from+'>'+r.settle.to);}
console.log('saltos de la tira >=30px:', jumps.length, jumps.join('  '));
console.log('settles distintos:', [...settles].join('  '));"
```

Expected: `saltos de la tira >=30px: 0`. Entre los settles debe aparecer uno cuyo `to` supera al `from` en ~155 px (el bloque de Wikipedia llegando bajo el settle). Un salto ≥30 px en un fotograma es un fallo de la Tarea 3.

- [ ] **Step 3: Vuelta autor → institución — el settle tras el `reveal` asienta, no salta**

```bash
pkill -f papertok-probe-profile; sleep 2
PROFILE_DIR="$HOME/.papertok-probe-profile" PORT=9341 ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/entity-back-frames.mjs 2>&1 | head -40
```

Expected: `settles arrancados durante la vuelta: 0` (la suspensión por llegada sigue), Y en las filas posteriores al primer `rest` debe haber al menos una con `settle` no nulo cuyo `@` avanza fotograma a fotograma (el primer dato tras la llegada se ASIENTA). Si tras `rest` la tira cambia ≥30 px en un fotograma sin `settle`, el `resync` sigue vivo: fallo de la Tarea 2.

- [ ] **Step 4: Cambio de idioma en una institución — el bloque no se pliega**

Escribir `/tmp/papertok-lang-probe.mjs`:

```js
// Cambia el idioma desde la barra con el bloque de Wikipedia abierto y mide
// si el bloque se desmonta. Nunca borra PROFILE_DIR.
import { spawn } from 'node:child_process';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.PORT || 9342);
const ORIGIN = process.env.ORIGIN || 'http://localhost:5174';
const PROFILE = process.env.PROFILE_DIR;
if (!PROFILE) { console.error('PROFILE_DIR required'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
try {
  let wsUrl = null;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); wsUrl = l.find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
    if (!wsUrl) await sleep(100);
  }
  const ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id) { const p = pend.get(m.id); pend.delete(m.id); p(m.result); } });
  const cmd = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => (await cmd('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;
  await cmd('Page.enable');
  await cmd('Page.navigate', { url: `${ORIGIN}/?probe=${Date.now()}#/explorer/institution/I136199984` });
  for (let i = 0; i < 400; i++) { if (await ev("!!document.querySelector('.ehc-wiki p')")) break; await sleep(100); }
  await sleep(1500);
  // Sampler: cada rAF, ¿existe .ehc-wiki? ¿está en filas grises? altura del fold y top de la tira.
  await ev(`(() => { window.__s = []; window.__on = true;
    const q = (s) => document.querySelector(s);
    const tick = () => { if (window.__on) { const w = q('.ehc-wiki'); const f = q('.ehc-wiki-fold');
      window.__s.push({ t: Math.round(performance.now()), wiki: !!w, rows: !!q('.ehc-wiki-skeleton'), prose: !!q('.ehc-wiki p'),
        foldH: f ? Math.round(f.getBoundingClientRect().height * 10) / 10 : null,
        tabs: q('.ee-tabs') ? Math.round(q('.ee-tabs').getBoundingClientRect().top * 10) / 10 : null }); }
      requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  // El interruptor de idioma vive en el menú de preferencias de la barra.
  const toggled = await ev(`(() => { const open = document.querySelector('.navbar-icon-btn--prefs, [aria-label*="referenc"], [aria-label*="ettings"]'); if (open) open.click(); return !!open; })()`);
  await sleep(400);
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll('button, [role="menuitemradio"], [role="option"]')].find((el) => /^(English|Español|EN|ES)$/i.test((el.textContent || '').trim())); if (b) b.click(); return b ? b.textContent.trim() : null; })()`);
  console.log('menú abierto:', toggled, ' idioma pulsado:', clicked);
  await sleep(3000);
  const out = await ev(`(() => { window.__on = false; const p = window.__s; const t0 = p[0].t; const o = []; let last = '';
    for (const x of p) { const k = [x.wiki, x.rows, x.prose].join(); if (k !== last) { last = k; o.push({ ...x, t: x.t - t0 }); } }
    return { frames: p.length, unmounted: p.some((x) => !x.wiki), minFold: Math.min(...p.map((x) => x.foldH ?? Infinity)), changes: o }; })()`);
  console.log('fotogramas', out.frames, ' ¿el bloque se desmontó?', out.unmounted, ' altura mínima del fold', out.minFold);
  for (const c of out.changes) console.log(JSON.stringify(c));
} finally { chrome.kill(); await sleep(400); }
```

```bash
pkill -f papertok-probe-profile; sleep 2
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 node /tmp/papertok-lang-probe.mjs
```

Expected: `¿el bloque se desmontó? false`, y la lista de cambios muestra `wiki:true` en todos los fotogramas con una transición `prose:true → rows:true → prose:true` (las filas mientras la búsqueda nueva está fuera). Si `idioma pulsado: null`, el selector del menú no casó: abrir la página en el Chrome visible, localizar el botón de idioma con las DevTools y ajustar los dos selectores de la sonda; no es un fallo del código.

- [ ] **Step 5: Anotar los números**

Guardar los tres resultados (saltos ≥30 px, settles tras `rest`, desmontaje en cambio de idioma) para el commit de la Tarea 10. Parar el `vite preview` (`pkill -f "vite preview --port 5174"`).

---

# Parte B — La puerta de autor (`78cb22d`)

### Task 7: El id se injerta por posición, o por coincidencia única

**Files:**
- Modify: `src/services/PaperBuilder.js:196-206`
- Test: `src/services/PaperBuilder.test.js`

**Interfaces:**
- Consumes: `matchesAuthorName(reqName, oaName)` de `src/utils/authorNameMatch.js` (sin cambios).
- Produces: `merged.authors` con la misma forma que hoy. Ningún llamante cambia.

- [ ] **Step 1: Tests que fallan**

Añadir a `src/services/PaperBuilder.test.js`, tras el test `'an author OpenAlex does not name, or does not disambiguate, is left as it was'`:

```js
/**
 * Two co-authors sharing a surname and an initial. `matchesAuthorName` lets an
 * initial match any part starting with that letter, so a first-match `find`
 * handed BOTH of them the first "Wang, J." — executed against the real matcher
 * during the 2026-09-09 review — and the id door opened the other person's
 * page with no name check downstream. arXiv and OpenAlex list the same work in
 * the same order, so when the two lists are the same length the position is
 * the identity; otherwise only a UNIQUE name match may carry an id.
 */
test('co-authors sharing a surname get their own ids, by position', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Jing Wang', id: null }, { name: 'Jun Wang', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Wang, J.', id: 'https://openalex.org/A1' }, { name: 'Wang, J.', id: 'https://openalex.org/A2' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => a.id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});

test('when the lists differ in length, an ambiguous name carries no id', () => {
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'J. Smith', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [
      { name: 'John Smith', id: 'https://openalex.org/A1' },
      { name: 'Jane Smith', id: 'https://openalex.org/A2' },
      { name: 'Grace Hopper', id: 'https://openalex.org/A3' },
    ],
  }, 'openalex');
  assert.equal(merged.authors[0].id, null, 'two Smiths match: the door stays the slow one rather than the wrong one');
});

test('a position that does not match the name falls back to a unique match', () => {
  // Same length, but OpenAlex lists them in the other order.
  const base = PaperBuilder.create({
    id: '2609.05134',
    authors: [{ name: 'Ada Lovelace', id: null }, { name: 'Grace Hopper', id: null }],
  });
  const merged = PaperBuilder.merge(base, {
    authors: [{ name: 'Hopper, G.', id: 'https://openalex.org/A2' }, { name: 'Lovelace, A.', id: 'https://openalex.org/A1' }],
  }, 'openalex');
  assert.deepEqual(merged.authors.map((a) => a.id), ['https://openalex.org/A1', 'https://openalex.org/A2']);
});
```

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/services/PaperBuilder.test.js`
Expected: FAIL en el primero (ambos reciben `A1`) y en el segundo (`A1` en vez de `null`). El tercero pasa ya (documenta que la vuelta a coincidencia única sigue funcionando).

- [ ] **Step 3: Implementar**

Sustituir el bloque `if (enrichmentData.authors?.length) { ... }` (:196-206) por:

```js
    if (enrichmentData.authors?.length) {
      if (!merged.authors?.length) {
        merged.authors = enrichmentData.authors;
      } else {
        const candidates = enrichmentData.authors;
        // Same work, same order on both sides: when the lists are the same
        // length the POSITION is the identity, and the name only confirms it.
        // Otherwise a name may carry an id only when exactly one candidate
        // matches it — "J. Smith" against two Smiths keeps the slow door
        // rather than opening the wrong one (2026-09-09 review).
        const byPosition = candidates.length === merged.authors.length;
        merged.authors = merged.authors.map((author, index) => {
          if (typeof author === 'string' || author?.id) return author;
          const positional = byPosition ? candidates[index] : null;
          if (positional?.id && matchesAuthorName(author?.name, positional?.name)) {
            return { ...author, id: positional.id };
          }
          const matches = candidates.filter(candidate => candidate?.id
            && matchesAuthorName(author?.name, candidate?.name));
          return matches.length === 1 ? { ...author, id: matches[0].id } : author;
        });
      }
    }
```

- [ ] **Step 4: Comprobar; lint; suite; mutación; commit**

Run: `npm run lint && npm test` → PASS (los cinco tests de injerto anteriores siguen pasando: el de «out of order» cae en la rama de coincidencia única).

Mutación: cambiar `matches.length === 1` por `matches.length >= 1` → el segundo test falla. Restaurar.

```bash
git add src/services/PaperBuilder.js src/services/PaperBuilder.test.js
git commit -F - <<'EOF'
fix(feed): el id de OpenAlex se injerta por posición, o por coincidencia única

`find` con `matchesAuthorName` cogía el PRIMER candidato que casara, y el
matcher deja que una inicial case con cualquier parte que empiece por esa
letra: «Jing Wang» y «Jun Wang» contra dos «Wang, J.» recibían el MISMO id, y
la puerta por id abría la página de la otra persona sin ninguna comprobación
de nombre aguas abajo (ejecutado contra el matcher real en la revisión del
09-09). La puerta anterior tenía el mismo primer-casa en el clic; lo que
78cb22d cambió es que el id equivocado se decide en silencio al enriquecer y
queda cosido a la ficha.

arXiv y OpenAlex listan el mismo trabajo en el mismo orden: con listas de la
misma longitud la posición es la identidad y el nombre sólo la confirma. Si no,
un nombre sólo lleva id cuando casa con exactamente un candidato — «J. Smith»
contra dos Smith se queda con la puerta lenta antes que con la equivocada.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 8: Los `authorships` mapeados se acotan

**Files:**
- Modify: `src/services/openAlexService.js:130-140` (`mapOpenAlexEnrichmentWork`) y una constante nueva junto a `OPENALEX_ENRICHMENT_SELECT`
- Test: `src/services/openAlexService.test.js` (junto a `'a work with no authorships enriches without an authors key'`, :577)

**Interfaces:**
- Produces: `MAX_ENRICHMENT_AUTHORS = 50` (exportada para el test). `mapOpenAlexEnrichmentWork(work).enrichment.authors` tiene como mucho 50 entradas, en orden de autoría.
- Lo que no cambia: el `select` sigue pidiendo `authorships` entero (OpenAlex rechaza la selección de subcampos, `:67-68`). El coste de red por chunk sigue siendo el que 78cb22d aceptó; lo que se acota es la entrada de caché y el trabajo de mapeo.

- [ ] **Step 1: Test que falla**

Añadir a `src/services/openAlexService.test.js`, tras `'a work with no authorships enriches without an authors key'`:

```js
/**
 * Collaboration papers carry 1,000–3,000 authorships. Mapped whole, a
 * 2,000-author work serialises to ~150K chars of `authors` alone — over the
 * 150,000-char cap a persistent entry may have (openAlexClient.js), so it was
 * silently dropped and re-fetched every session (2026-09-09 review). The graft
 * only needs candidates for the names a card already shows, and a card never
 * shows thousands; fifty keeps the entry under 5K and the first fifty authors
 * — the ones a reader can actually reach — get their door.
 */
test('the mapped authorships are capped, in authorship order', () => {
  const authorships = Array.from({ length: 2000 }, (_, i) => ({
    author: { id: `https://openalex.org/A${i}`, display_name: `Author ${i}` },
  }));
  const mapped = mapOpenAlexEnrichmentWork({ id: 'https://openalex.org/W1', authorships });
  assert.equal(mapped.enrichment.authors.length, MAX_ENRICHMENT_AUTHORS);
  assert.equal(mapped.enrichment.authors[0].id, 'https://openalex.org/A0');
  assert.equal(mapped.enrichment.authors[MAX_ENRICHMENT_AUTHORS - 1].id, `https://openalex.org/A${MAX_ENRICHMENT_AUTHORS - 1}`);
  assert.ok(JSON.stringify(mapped.enrichment).length < 20_000, 'and the entry stays far under the persistent cap');
});
```

Y añadir `MAX_ENRICHMENT_AUTHORS,` a la lista de imports desde `'./openAlexService.js'` en la cabecera del test (orden alfabético: entre `isOpenAlexEnrichmentId` y `mapOpenAlexEnrichmentWork`).

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/services/openAlexService.test.js`
Expected: FAIL — `MAX_ENRICHMENT_AUTHORS` no está exportada.

- [ ] **Step 3: Implementar**

Justo después de la definición de `OPENALEX_ENRICHMENT_SELECT` (tras `].join(',');`, :77):

```js
/**
 * How many of a work's authorships travel into the enrichment. The select has
 * to ask for the whole array (OpenAlex refuses a subfield), but nothing after
 * it needs more than the authors a card can show: the graft (PaperBuilder)
 * matches against names the paper already has. Unbounded, a 2,000-author
 * collaboration paper mapped to ~150K chars of `authors` — over the persistent
 * store's per-entry cap — so it was never cached across sessions.
 */
export const MAX_ENRICHMENT_AUTHORS = 50;
```

Y en `mapOpenAlexEnrichmentWork` sustituir:

```js
  const authorships = Array.isArray(work.authorships) ? work.authorships.slice(0, MAX_ENRICHMENT_AUTHORS) : [];
```

- [ ] **Step 4: Comprobar; lint; suite; mutación; commit**

Run: `npm run lint && npm test` → PASS. Mutación: quitar `.slice(0, MAX_ENRICHMENT_AUTHORS)` → falla. Restaurar.

```bash
git add src/services/openAlexService.js src/services/openAlexService.test.js
git commit -F - <<'EOF'
fix(feed): los authorships mapeados se acotan a cincuenta

78cb22d pidió `authorships` en el select del enriquecimiento (OpenAlex rechaza
la selección de subcampos, así que va el array entero) y lo mapeaba completo.
Un paper de colaboración de 2000 autores serializa a ~150 K caracteres sólo de
`authors`, por encima del tope de 150 000 por entrada del almacén persistente:
`writePersistent` lo descartaba en silencio y el chunk volvía a pagarse en cada
sesión. Cincuenta deja la entrada por debajo de 5 K, y el injerto sólo necesita
candidatos para los nombres que una ficha ya muestra.

Queda sin tocar la tercera clave persistente por trabajo (`enrichment:doi:`),
que triplica la presión de expulsión del almacén de 200 entradas: sólo la lee
quien pidió por DOI, y acotarla a esos chunks es un cambio aparte.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 9: Vuelve el fallback para una autoría sin id

**Files:**
- Modify: `src/services/openAlexService.js:526-535` (dentro de `getAuthorProfileExact`, tras el bloque `if (bestMatch && bestMatch.id) { ... }`)
- Test: `src/services/openAlexService.test.js` (tras `'the authorship match still beats the name search when the work is there'`)

**Interfaces:**
- Consumes: `getAuthorProfile(name)` (ya existe en el fichero) y `recordingFetch` del test.
- Produces: nada nuevo. La búsqueda en paralelo desde el nombre de la ficha se conserva (decisión medida de 78cb22d: 51 de 56 enlaces lentos no están indexados y ahí ahorra un viaje); lo que vuelve es la búsqueda con la grafía de OpenAlex cuando el trabajo nombra al autor pero no le enlaza id.

- [ ] **Step 1: Test que falla**

```js
/**
 * The work names the author but OpenAlex never linked an id to that
 * authorship. Before 78cb22d a second search ran from OpenAlex's own spelling
 * of the name; 78cb22d deleted it and left only the search already in flight
 * from the CARD's spelling — an initialled "N. Cuello" where the work says
 * "Nicolás Cuello" — which is the one more likely to miss. Both spellings are
 * tried again: the card's first (it was already out), OpenAlex's if that misses.
 */
test('an authorship without an id falls back to a search from the spelling the work used', async () => {
  const realFetch = openAlexClient.fetchImpl;
  const { urls, impl } = recordingFetch([
    ['works/doi:', () => new Response(JSON.stringify({
      id: 'https://openalex.org/W1',
      authorships: [{ author: { id: null, display_name: 'Nicolás Cuello' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    // The card's spelling misses; the work's spelling finds them.
    ['authors?search=N.', () => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
    ['authors?search=Nicol', () => new Response(JSON.stringify({
      results: [{ id: 'https://openalex.org/A5', display_name: 'Nicolás Cuello', works_count: 12, summary_stats: { h_index: 4 } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })],
  ]);
  openAlexClient.fetchImpl = impl;
  try {
    const profile = await getAuthorProfileExact('N. Cuello', '2309.03290');
    assert.equal(profile.id, 'https://openalex.org/A5', 'found from the spelling the work used');
    assert.ok(urls.some((url) => url.includes('authors?search=Nicol')), 'the second search ran');
  } finally {
    openAlexClient.fetchImpl = realFetch;
  }
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/services/openAlexService.test.js`
Expected: FAIL — `profile.id` es `stub-N.-Cuello` (sólo corrió la búsqueda desde la ficha, que devuelve vacío).

- [ ] **Step 3: Implementar**

Sustituir el comentario de cuatro líneas que sigue al bloque `if (bestMatch && bestMatch.id) { ... }` («The work named them but OpenAlex never linked an id to that authorship. The search already in flight is the answer; …») por:

```js
        // The work named them but OpenAlex never linked an id to that
        // authorship. The search already in flight — from the name the reader
        // clicked, the card's spelling — is tried first because it is already
        // out; if it misses, the work's own spelling of the name is the better
        // query (78cb22d deleted this second search; the 2026-09-09 review put
        // it back: "N. Cuello" misses where "Nicolás Cuello" does not).
        if (bestMatch && bestMatch.display_name) {
          const fromCard = await byName;
          if (fromCard) return fromCard;
          const fromWork = await getAuthorProfile(bestMatch.display_name).catch(() => null);
          if (fromWork) return fromWork;
        }
```

- [ ] **Step 4: Comprobar; lint; suite; mutación; commit**

Run: `npm run lint && npm test` → PASS (el test «still beats the name search» sigue pasando: allí `bestMatch.id` existe y devuelve antes).

Mutación: borrar las dos líneas `const fromWork ... if (fromWork) return fromWork;` → falla. Restaurar.

```bash
git add src/services/openAlexService.js src/services/openAlexService.test.js
git commit -F - <<'EOF'
fix(explorer): vuelve la búsqueda con la grafía del trabajo para una autoría sin id

78cb22d borró `getAuthorProfile(bestMatch.display_name)` — la búsqueda que se
hacía cuando el trabajo nombra al autor pero OpenAlex no le enlaza id — y dejó
sólo la búsqueda ya en vuelo desde la grafía de la ficha. Esa es la grafía con
iniciales («N. Cuello» donde el trabajo dice «Nicolás Cuello») y la más
propensa a fallar: cuando fallaba, la página del autor era un stub.

Se prueban las dos: primero la de la ficha, porque ya está fuera; si falla, la
del trabajo. La búsqueda en paralelo se queda — 51 de 56 enlaces lentos medidos
no están indexados y ahí ahorra un viaje; el slot que ocupa en el caso indexado
es el precio de esa decisión, y se acepta.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 10: El registro

**Files:**
- Modify: `docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md` (nueva sección al final)
- Modify: `scripts/diagnostics/README.md` (sección de `entity-back-frames.mjs`)

**Interfaces:** ninguna.

- [ ] **Step 1: La retirada, en el documento de auditoría**

Añadir al final de `docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md`:

```markdown
---

## 10. Revisión del 09-09: una decisión retirada y tres bugs cerrados

La revisión de código del rango `5fb6c03..aea5a59` (siete buscadores, un
verificador por candidato) encontró que la decisión del 08-09 de dejar que el
fold de Wikipedia animara su propia `height: 'auto'` — con el settle suspendido
detrás de un pestillo — era la causa de tres defectos, y **queda retirada**:

- el `resync` saltaba la entrega esqueleto→héroe en toda navegación hacia
  delante o atrás (la marca de memoria rancia se levantaba también durante la
  llegada de ruta, donde la memoria es honesta);
- el efecto de reinicio del pestillo corría en el mismo commit que arrancaba el
  plegado de salida, y un dato que aterrizara en sus 480 ms animaba desde una
  altura a medio plegar;
- un bloque con sólo `homepage_url` montaba bajo un settle en vuelo y quedaba
  recortado hasta que el settle acababa.

El propio fichero ya decía en `:2080` que un segundo dueño de ese número era el
defecto, y el panel de experiencia ya entraba correctamente en la misma caja:
montado a su altura, sólo su contenido por opacidad. El fold hace ahora lo
mismo y el settle lleva su espacio. Medido tras el cambio (Tarea 6 del plan):

| Caso | Antes | Después |
|---|---|---|
| Institución en frío, saltos de la tira ≥30 px | 0 (el fold animaba) | [anotar] |
| Vuelta autor→institución, settle tras `rest` | salta (resync) | [anotar: asienta] |
| Cambio de idioma con el bloque abierto | se pliega y se despliega (480 + 320 ms) | [anotar: no se desmonta] |

Con la sesión real se confirmaron también, y se cerraron en el mismo plan: la
línea base de seguidos de `FeedContext` grabada antes de conocer el uid (un
re-rank y una recarga en cada carga fría con sesión), el injerto de id por el
primer nombre que casara (dos coautores, un id), los `authorships` sin tope y
el fallback borrado para autorías sin id.

**No volver a proponer** que un hijo de `.explorer-hero-content` anime su
altura. Un bloque que llega dentro de esa caja anima su contenido; su espacio
lo lleva `useHeightSettle`.
```

Rellenar los tres `[anotar]` con los números de la Tarea 6.

- [ ] **Step 2: README de las sondas**

En `scripts/diagnostics/README.md`, en la sección de `entity-back-frames.mjs`, añadir al final:

```markdown
Desde 2026-09-09 el número que importa tras `rest` es el contrario al de antes:
la primera fila con `settle` no nulo cuyo `@` avanza fotograma a fotograma es
la entrega asentándose. `0 settles durante la vuelta` sigue siendo lo esperado
(la llegada de ruta suspende el settle); una tira que cambie ≥30 px en un
fotograma DESPUÉS de `rest` y sin `settle` es el `resync` que este día se
retiró.
```

- [ ] **Step 3: Commit**

```bash
git add docs/AUDITORIA-ANIMACIONES-AUTOR-2026-09-07.md scripts/diagnostics/README.md
git commit -F - <<'EOF'
docs(animaciones): la revisión del 09-09 retira la propiedad del fold y cierra tres bugs

Para que la próxima sesión no vuelva a proponer que un hijo de la caja del
héroe anime su propia altura: el registro de por qué se retiró, los tres
defectos que causaba, y los números de después.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

# Parte C — Lo que la auditoría en vivo del 09-09 añadió

### Task 11: Una entidad ya en caché nace pintada, no como esqueleto

**Files:**
- Modify: `src/services/openAlexService.js` (una función nueva junto a `getEntityById`)
- Modify: `src/components/Explorer/EntityExplorer.jsx:250-257` (`bornResolved` y el estado inicial de `entity`)
- Test: `src/services/openAlexService.test.js`, `src/components/Explorer/explorerEntrance.test.js`

**Interfaces:**
- Consumes: `readOpenAlexPersistent(key, maxAgeMs)` (importado ya en openAlexService.js:32 desde `./openAlexClient.js`; devuelve `{ data, stale }` o null, **síncrono**) y `ENTITY_CACHE_TTL_MS` (:44).
- Produces: `export function peekEntity(type, id)` → la entidad fresca en caché o `null`; sólo para `author` e `institution` (los topics ya nacen locales; los proyectos son OpenAIRE, Tarea 12).

Por qué: medido el 09-09 con sesión real, una institución ya visitada pinta el esqueleto durante **30 ms — dos fotogramas —** y un autor abierto desde su institución durante uno; después las cuatro cifras llegan a la vez en el fundido 0,35 → 1 del héroe. Es un destello, no una espera, y es lo que el lector describe como «no hay animación de carga»: no hay nada que ver. El repo ya tiene regla para esto (los placeholders se retrasan 320 ms; `RouteFallback.css:13` la aplica) y una vía mejor para este caso: la página nacida resuelta, que es como llega una entidad traspasada desde la paleta — el control que mejor se siente. `getEntityById` lee esa misma entrada de caché primero (:9), pero es async y cuando contesta el esqueleto ya se ha pintado.

Caveat conocido, aceptado: una institución nacida de la caché llega sin la localización ROR (`getEntityById` la añade en `enrichInstitutionWithRor`), así que `entityDisplayName` puede cambiar cuando el efecto de carga actualiza el registro. Con la Tarea 4 en su sitio el bloque de Wikipedia se queda montado durante esa re-búsqueda; el nombre del masthead sí puede cambiar de texto una vez. Es el mismo trato que ya hace un traspaso desde la paleta.

- [ ] **Step 1: Test que falla — el peek**

Añadir a `src/services/openAlexService.test.js` (y `peekEntity` al import desde `'./openAlexService.js'`, en orden alfabético tras `normalizeRecentImpactEntityId`):

```js
import { openAlexClient, writeOpenAlexPersistent } from './openAlexClient.js';

/**
 * Measured 2026-09-09 on a warm institution: the skeleton stood for 30 ms —
 * two frames — before the hero replaced it, and the four numbers landed at
 * once inside the hero's own crossfade. A flash, not a wait. getEntityById
 * reads this same entry first, but it is async, and by the time it answers
 * the skeleton has painted. A page born from the entry paints its data on its
 * first frame, the way one handed over from the search palette does.
 */
test('peekEntity answers the persistent cache synchronously, fresh entries only, authors and institutions only', () => {
  const previousStorage = openAlexClient.storage;
  const previousStore = openAlexClient.persistentStore;
  const memory = new Map();
  openAlexClient.storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  openAlexClient.persistentStore = null;
  try {
    writeOpenAlexPersistent('entity:author:A5000000001', { id: 'https://openalex.org/A5000000001', display_name: 'Ada Lovelace', works_count: 3 });
    assert.equal(peekEntity('author', 'https://openalex.org/A5000000001')?.display_name, 'Ada Lovelace', 'a full OpenAlex url is keyed by its last segment, like getEntityById');
    assert.equal(peekEntity('author', 'A5000000001')?.works_count, 3, 'and a bare id finds the same entry');
    assert.equal(peekEntity('author', 'A5000000002'), null, 'unknown: null, never a stub');
    assert.equal(peekEntity('project', 'A5000000001'), null, 'projects come from OpenAIRE, never from here');
    assert.equal(peekEntity('topic', 'A5000000001'), null, 'topics are born local already');
  } finally {
    openAlexClient.storage = previousStorage;
    openAlexClient.persistentStore = previousStore;
  }
});
```

Si `openAlexClient.persistentStore = null` no fuerza la recarga desde `storage` (comprobar en `src/services/openAlexClient.js` alrededor de la línea 240, donde `this.persistentStore = JSON.parse(this.storage.getItem(STORAGE_KEY) || '{}')`), usar en su lugar el patrón de `openAlexClient.test.js:351-369`: construir un `new OpenAlexClient({ storage })` propio. En ese caso `peekEntity` debe leer a través de una función inyectable; preferir arreglar el reset del singleton antes que eso.

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/services/openAlexService.test.js`
Expected: FAIL — `peekEntity` no está exportada.

- [ ] **Step 3: Implementar `peekEntity`**

En `src/services/openAlexService.js`, justo antes de `export async function getEntityById`:

```js
/**
 * The entity the persistent cache already holds for this route, or null —
 * synchronously, for a page deciding what it is born with.
 *
 * `getEntityById` reads the same entry first, but it is async, and a page
 * that awaits it has painted a skeleton by the time it answers. Measured
 * 2026-09-09 on a warm institution: the skeleton stood for 30 ms — two frames
 * — before the hero replaced it, a flash that reads as a glitch rather than
 * as a wait. A page born from this peek paints its data on its first frame,
 * the way one handed over from the search palette does; the load effect still
 * runs and upgrades the record (an institution gains its ROR localisation
 * there), so nothing is lost by not waiting.
 *
 * Authors and institutions only: topics are born from CATEGORIES already, and
 * a project's record is OpenAIRE's, not this cache's. Only a FRESH entry
 * qualifies — a stale one is `getEntityById`'s business, which revalidates.
 */
export function peekEntity(type, id) {
  if (!id || (type !== 'author' && type !== 'institution')) return null;
  const cleanId = String(id).includes('/') ? String(id).split('/').pop() : String(id);
  const cached = readOpenAlexPersistent(`entity:${type}:${cleanId}`, ENTITY_CACHE_TTL_MS);
  return cached && !cached.stale && cached.data ? cached.data : null;
}
```

- [ ] **Step 4: Test que falla — la página nace de la caché**

Añadir a `src/components/Explorer/explorerEntrance.test.js`:

```js
test('an entity already in the persistent cache is born resolved, like one handed over from the palette', async () => {
  const jsx = (await read('./EntityExplorer.jsx')).replace(/^\s*\/\/.*$/gm, '');
  assert.match(jsx, /import \{[^}]*\bpeekEntity\b[^}]*\} from '\.\.\/\.\.\/services\/openAlexService/);
  assert.match(jsx, /const cachedEntity = useMemo\(\(\) => peekEntity\(type, id\), \[id, type\]\);/);
  assert.match(jsx, /const bornResolved = Boolean\(handedEntity\) \|\| Boolean\(localTopic\) \|\| Boolean\(cachedEntity\) \|\| \(type === 'topic' && isOpaqueQueryTopicText\(id\)\);/);
  assert.match(jsx, /useState\(\(\) => \(bornResolved \? \(handedEntity \|\| localTopic \|\| cachedEntity \|\| resolveQueryTopicRoute\(id, searchParams\)\) : null\)\)/,
    'the handed entity still wins — it is the fresher of the two');
});
```

- [ ] **Step 5: Comprobar que falla; implementar**

Run: `node --test src/components/Explorer/explorerEntrance.test.js` → FAIL.

En `src/components/Explorer/EntityExplorer.jsx`: añadir `peekEntity` al import de `'../../services/openAlexService'` (junto a `getEntityById`), y sustituir el bloque de `bornResolved` (:251-257) por:

```js
  const handedEntity = useMemo(() => handedEntityFor(type, id, location.state), [id, location.state, type]);
  const localTopic = useMemo(
    () => (type === 'topic' || type === 'concept' ? getLocalTopicEntity(id) : null),
    [id, type],
  );
  // The fourth way to be born live (2026-09-09): the record is already in the
  // persistent cache. Measured on a warm institution, born loading instead:
  // the skeleton for 30 ms — two frames — then the hero replacing it, which
  // reads as a flash rather than as a wait. The handed entity still wins when
  // both exist; it is the fresher of the two. The load effect below runs
  // either way and upgrades the record.
  const cachedEntity = useMemo(() => peekEntity(type, id), [id, type]);
  const bornResolved = Boolean(handedEntity) || Boolean(localTopic) || Boolean(cachedEntity) || (type === 'topic' && isOpaqueQueryTopicText(id));
  const [entity, setEntity] = useState(() => (bornResolved ? (handedEntity || localTopic || cachedEntity || resolveQueryTopicRoute(id, searchParams)) : null));
```

Y en el efecto de carga, donde el reset por entidad hace `if (handedEntity) { setEntity(handedEntity); setIsLoadingEntity(false); } else { setIsLoadingEntity(true); setEntity(null); }` (:651-657), sustituir por:

```js
      const bornWith = handedEntity || cachedEntity;
      if (bornWith) {
        setEntity(bornWith);
        setIsLoadingEntity(false);
      } else {
        setIsLoadingEntity(true);
        setEntity(null);
      }
```

y añadir `cachedEntity` a la lista de dependencias de ese efecto (:853, junto a `handedEntity`). Comprobar que el cierre de éxito `setEntity(data || handedEntity)` (:771) y el de error `setEntity(handedEntity || null)` (:846) pasan a `data || handedEntity || cachedEntity` y `handedEntity || cachedEntity || null`.

- [ ] **Step 6: Comprobar; lint; suite; mutación**

Run: `npm run lint && npm test` → PASS. Mutación: quitar `|| Boolean(cachedEntity)` de `bornResolved` → el test SOURCE falla. Restaurar.

- [ ] **Step 7: Medir**

Con el servidor de producción y el perfil con sesión (Tarea 6, Step 1), la sonda de stats por celda de la auditoría del 09-09 — copiarla de `/private/tmp/…/scratchpad/stats-probe.mjs` si sigue ahí, o reescribirla: muestrea por rAF `!!document.querySelector('.explorer-skeleton')`, la opacidad calculada de `.explorer-hero-content` y el texto de cada `.ehc-stat-value`, y colapsa fotogramas idénticos. Contra una institución YA VISITADA en esa sesión:

```bash
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 node stats-probe.mjs '#/explorer/institution/I136199984' 7000
```

Expected: ninguna fila con `SKEL` — la primera fila con héroe ya lleva las cuatro cifras. Antes: `356 SKEL` → `386 live` (30 ms de esqueleto).

- [ ] **Step 8: Commit**

```bash
git add src/services/openAlexService.js src/services/openAlexService.test.js src/components/Explorer/EntityExplorer.jsx src/components/Explorer/explorerEntrance.test.js
git commit -F - <<'EOF'
feat(explorer): una entidad ya en caché nace pintada, no como esqueleto

Medido el 09-09 con sesión real: una institución ya visitada pintaba el
esqueleto durante 30 ms — dos fotogramas — y un autor abierto desde su
institución durante uno; después las cuatro cifras llegaban a la vez dentro
del fundido 0,35 → 1 del héroe. Un destello, no una espera, y lo que el
lector describe como «no hay animación de carga»: no había nada que ver.

`getEntityById` lee esa misma entrada de la caché persistente antes que nada,
pero es async, y cuando contesta el esqueleto ya está pintado. `peekEntity`
la lee síncrona en el montaje, y la página nace resuelta con ella — la cuarta
forma de nacer viva, junto al traspaso de la paleta, el topic local y la
consulta libre — igual que el traspaso, que es la llegada que mejor se siente.
El efecto de carga sigue corriendo y actualiza el registro (una institución
gana ahí su localización ROR).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

### Task 12: `getProjectDetails` entra en la caché que ya usan sus vecinas

**Files:**
- Modify: `src/services/openAireService.js:54-60` (`getProjectDetails`)
- Test: `src/services/openAireService.test.js`

**Interfaces:**
- Consumes: `CACHE` (exportada, :4) y `CACHE_TTL` (:5, 24 h), el mismo par que `getProjectForPaper` usa en :142-145 y :169/:180.
- Produces: nada nuevo; la misma firma y el mismo objeto.

Por qué: es la única lectura del Explorer sin caché. Cada vuelta a un proyecto — y cada apertura desde la píldora de un paper ya visto — paga el viaje entero a OpenAIRE con el esqueleto en pantalla, y el esqueleto del proyecto es el que reserva peor (dos celdas de stats donde el 09-09 llegaron cuatro, 124 px de resumen donde llegaron 100). El settle lleva bien la diferencia (medido: un solo settle 246,8 → 473,0 px en 360 ms, pico 28,3 px/fotograma); lo que sobra es la espera antes.

- [ ] **Step 1: Test que falla**

Añadir a `src/services/openAireService.test.js` (y `CACHE`, `getProjectDetails` al import desde `'./openAireService.js'`):

```js
/**
 * The only Explorer read with no cache: every return to a project paid a full
 * OpenAIRE round trip with the skeleton on screen (2026-09-09 review). The
 * same 24 h CACHE its two neighbours in this file use.
 */
test('getProjectDetails answers a second call from the cache without a request', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ response: { results: { result: [{ header: { 'dri:objIdentifier': { $: 'corda__h2020::abc' } }, metadata: { 'oaf:entity': { 'oaf:project': { code: { $: '101000000' }, acronym: { $: 'QUANTUMLEAP' }, title: { $: 'Quantum leap' }, startdate: { $: '2021-01-01' }, enddate: { $: '2025-12-31' }, totalcost: { $: '4998750' }, fundedamount: { $: '4998750' }, currency: { $: 'EUR' }, fundingtree: { funder: { shortname: { $: 'EC' }, name: { $: 'European Commission' } } } } } } }] } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    CACHE.clear();
    const first = await getProjectDetails('101000000');
    const second = await getProjectDetails('101000000');
    assert.equal(first?.acronym, 'QUANTUMLEAP');
    assert.deepEqual(second, first, 'the same object, from the cache');
    assert.equal(calls, 1, 'one request for two calls');
  } finally {
    globalThis.fetch = realFetch;
    CACHE.clear();
  }
});

test('getProjectDetails does not cache a miss', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 404 }); };
  try {
    CACHE.clear();
    assert.equal(await getProjectDetails('nope'), null);
    assert.equal(await getProjectDetails('nope'), null);
    assert.equal(calls, 2, 'a miss is asked again — OpenAIRE indexes late');
  } finally {
    globalThis.fetch = realFetch;
    CACHE.clear();
  }
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/services/openAireService.test.js`
Expected: FAIL — `calls` es 2 en el primero.

- [ ] **Step 3: Implementar**

Sustituir el arranque de `getProjectDetails` (:54-58):

```js
export async function getProjectDetails(projectId) {
  if (!projectId) return null;
  // The same 24 h cache the two lookups below keep. Without it this was the
  // only Explorer read that paid a full round trip on every return, with the
  // project's skeleton — the one that reserves worst — on screen for all of
  // it (2026-09-09). A miss is not cached: OpenAIRE indexes late.
  const cacheKey = `projectDetails_${projectId}`;
  if (CACHE.has(cacheKey)) {
    const cached = CACHE.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
  }
  const url = `https://api.openaire.eu/search/projects?format=json&size=1&grantID=${encodeURIComponent(projectId)}`;
```

Y justo antes del `return {` que construye el objeto (tras el bloque de `measures`), envolver: construir el objeto en `const details = { ... };`, después `CACHE.set(cacheKey, { data: details, timestamp: Date.now() }); return details;`.

- [ ] **Step 4: Comprobar; lint; suite; mutación; commit**

Run: `npm run lint && npm test` → PASS. Mutación: quitar el `CACHE.set` → el primer test falla (`calls === 2`). Restaurar.

```bash
git add src/services/openAireService.js src/services/openAireService.test.js
git commit -F - <<'EOF'
perf(explorer): los detalles de un proyecto entran en la caché de 24 h de OpenAIRE

`getProjectDetails` era la única lectura del Explorer sin caché: cada vuelta a
un proyecto, y cada apertura desde la píldora de un paper ya visto, pagaba el
viaje entero a OpenAIRE con el esqueleto en pantalla — y el esqueleto del
proyecto es el que peor reserva (dos celdas de stats donde el 09-09 llegaron
cuatro). El settle lleva bien esa diferencia (medido: un solo settle de 246,8
a 473,0 px en 360 ms); lo que sobraba era la espera de antes. Misma caché y
mismo TTL que `getProjectForPaper` y `getPapersByProject`; un fallo no se
cachea, porque OpenAIRE indexa tarde.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

---

## Auto-revisión del plan

**Cobertura de la spec.** Hallazgo 1 → Tarea 1. Hallazgo 2 → Tarea 2. Hallazgos 6, 8 y 9 → Tareas 2–3 (un dueño). Hallazgo 5 → Tarea 4. Hallazgo 10 → Tarea 5. Hallazgo 3 → Tarea 7. Hallazgo 4 → Tarea 8 (el tope; la tercera clave persistente se deja anotada y fuera, con el porqué en el commit). Hallazgo 7 → Tarea 9 (el fallback; la búsqueda en paralelo se conserva a propósito, con el porqué). Hallazgo 11 → Tarea 11. Hallazgo 12 → Tarea 12. Verificación → Tarea 6 (Parte A) y los Step 7 de la Tarea 11. Registro → Tarea 10.

**Placeholders.** Los únicos `[anotar]` están en el documento de la Tarea 10 y se rellenan con los números de la Tarea 6, que los produce.

**Consistencia de nombres.** `planHeightSettle({ remembered, depsChanged, running, current, natural, suspended })` en Tarea 2 y en el regex de Tarea 2/`explorerEntrance.test.js`. `useHeightSettle(heroBodyRef, [... showWikiBlock, wikiDescription, isWikiRequestPending], { ..., suspended: isPageArriving, ... })` en Tarea 3 y en los tres regex de Tarea 3. `wikiBlockOpened` / `wikiHasContent` / `showWikiBlock` en Tarea 4 y su test. `MAX_ENRICHMENT_AUTHORS` en Tarea 8, exportada y en el import del test. `byName` y `bestMatch.display_name` en Tarea 9 son los nombres que ya usa `getAuthorProfileExact`.

**Orden.** Las Tareas 1, 7, 8, 9 y 12 son independientes entre sí y de las demás. La Tarea 11 va DESPUÉS de la 4 (una institución nacida de la caché cambia de nombre al ganar su localización ROR, y sin la 4 eso replegaría el bloque de Wikipedia). Las Tareas 2 → 3 → 4 → 5 → 6 → 10 van en ese orden: la 3 retira el latch que la 2 dejó sin efecto, la 4 cambia una condición que la 3 acaba de mover, la 5 borra lo que la 3 dejó sin alcanzar, la 6 mide el resultado de 2–5 y la 10 lo anota.
