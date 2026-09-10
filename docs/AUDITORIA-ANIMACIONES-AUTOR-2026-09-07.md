# Auditoría de animaciones — página de autor del Explorer (2026-09-07)

Ruta auditada: `/explorer/author/:id` (`src/components/Explorer/EntityExplorer.jsx`),
sus tres accesos (feed, página de universidad, paleta de búsqueda) y la capa de
transición de ruta que corre a la vez (`src/components/Layout/PageTransition.*`).

Medido por CDP contra un **build de producción** servido con `vite preview` en
`http://localhost:5174`, con un Chrome headless reutilizando un **perfil con
sesión real de Firebase** (`PROFILE_DIR=~/.papertok-probe-profile`). Sin
estrangular la CPU salvo donde se indica.

> **La lección que hay que llevarse de aquí.** Una auditoría anterior del mismo
> día se hizo sobre un build con `IS_DEMO = true`, y ese build **ocultaba los dos
> defectos que bloquean** (el remontaje del árbol y el salto de banda de la
> barra): el usuario de demo se resuelve en un `setTimeout(0)`
> (`src/context/AuthContext.jsx:60-75`), así que la clave de `App.jsx:508` nunca
> gira de verdad y `authLoading` nunca está abierto mientras la página pinta.
> Además el feed de demo repartía **siempre la ruta rápida por id**, así que la
> ruta por nombre — 2513 ms hasta el héroe frente a 871 — no apareció nunca.
> Para auditar el movimiento de esta página **hace falta sesión real**; el demo
> sirve para el esqueleto y poco más.

---

## 1. Las corridas

El encargo hablaba de siete; las corridas que produjeron números fueron nueve,
más una repetición de confirmación y una comprobación previa de que el headless
heredaba la sesión.

| # | Sonda | Caso | Qué contestó |
|---|---|---|---|
| 0 | `auth-check.mjs` (scratch) | sesión heredada | El headless hereda la sesión: los enlaces del feed apuntan a `#/explorer/author/…` y hay avatar en la barra |
| 1 | `explorer-loading-probe.mjs timeline` | ruta por **id** (`A5006398227`), perfil caliente | Hitos de carga con Firestore en el circuito |
| 2 | `explorer-loading-probe.mjs timeline` | ruta por **nombre** (`A.%20M.%20Gavrilik?arxivId=…`) | El coste de los tres viajes encadenados |
| 3 | `explorer-hero-frames.mjs fromfeed` | clic en el feed, ruta por id | Un solo settle: autor con ORCID **sin** empleos |
| 4 | `explorer-hero-frames.mjs route` | carga en frío de `A5006398227` | **Descubre la llegada doble** |
| 5 | `remount-probe.mjs` (scratch) | frío, escritorio 1280×900 | Identidad del nodo + `padding-top` calculado |
| 5b | `remount-probe.mjs` | repetición del anterior | Reproduce idéntico: determinista |
| 6 | `remount-probe.mjs` con `CLICK` | caliente, clic en el feed | Sin remontaje, sin salto de banda |
| 7 | `warm-nav.mjs` (scratch) | caliente, navegación por hash al mismo autor | El caso caliente comparable con el frío |
| 8 | `remount-probe.mjs MOBILE=1` | frío, 390×844 dpr 3 | La geometría del móvil |
| 9 | `remount-probe.mjs RM=1` | frío, `prefers-reduced-motion: reduce` | Todo convertido en saltos |

Las sondas 5–9 muestrean por `requestAnimationFrame`: identidad del nodo
`.explorer-hero-content` (un contador `gen` que sube cuando el objeto cambia),
presencia de `.explorer-skeleton`, de `.explorer--app` y de `.navbar`, el
`padding-top` calculado, la caja y la opacidad del héroe, la animación WAAPI de
id `height-settle` con sus keyframes y su `currentTime`, y las coordenadas de
`.ee-tabs` y la primera `.explorer-list-item`.

---

## 2. El cuadro

Mismo autor (`A5006398227`, panel de experiencia de 176,3 px) salvo donde se dice.

| Caso | Generaciones del héroe | Saltos sin animar | Settles | Viaje de la tira de pestañas | En reposo |
|---|---|---|---|---|---|
| **Frío** 1280×900 (enlace directo o recarga) | **4** (2 montajes) | **−68,1 px** hacia atrás, **+56 px** de barra | 2 | 210 → 615,6 = **+405,6 px** | 1769 ms |
| Caliente (navegando dentro de la app) | 2 | ninguno | 3 | 277,1 → 615,6 = **+338,5 px** | 849 ms |
| **Móvil** 390×844 frío | **4** | **−108 px** hacia atrás, **+52 px** de barra | 2 | 414 → 795,2 = **+381,2 px** | 2094 ms |
| **Reduced motion** frío | **4** | **seis**, el mayor **−349,6 px** | 0 | 210 → 615,6 | 1347 ms |

En móvil la tira acaba en **y = 795 de una pantalla de 844** y la primera fila
del listado en **936**: el contenido al que va el lector queda entero bajo el
pliegue.

### Hitos de carga (corrida 1, ruta por id, sesión real)

| Hito | Demo (frío) | Sesión (perfil caliente) |
|---|---|---|
| Esqueleto | 475 ms | 418 ms |
| Héroe vivo + esqueleto ORCID + «…/10» | 2053 ms | **871 ms** |
| Nota de impacto asentada | 2507 ms (+454) | **927 ms (+56)** |
| Tarjeta ORCID + panel de experiencia | 3834 ms (+1781) | **1876 ms (+1005)** |
| Filas del listado | 3412 ms | 4400 ms |

Con sesión la nota de impacto sale de la caché de Firestore y **se funde con el
primer settle** en vez de comprar uno tercero. El orden ORCID↔filas está
**invertido** respecto al demo: se han observado los dos órdenes, así que la
carrera es real y no un artefacto.

### Ruta por nombre (corrida 2)

`#/explorer/author/A.%20M.%20Gavrilik?arxivId=2309.03290`, la forma que el feed
real reparte para autores sin id de OpenAlex (`src/utils/explorerPaths.js:6`):
esqueleto a 440 ms, **héroe vivo a 2513 ms** (frente a 871 por id), tarjeta ORCID
a 2912 ms, filas a 5065 ms. No es un defecto de animación y **no entra en este
trabajo**; queda anotado como tarea aparte porque es la palanca más grande que
hay sobre la lentitud percibida de esta página.

---

## 3. Los dos defectos que bloquean

### A. El árbol se remonta cuando la sesión se resuelve

`<FollowingProvider key={user?.uid || 'signed-out'}>` en `src/App.jsx:508`.
`user` nace `null` (`src/context/AuthContext.jsx:43`) y `setUser` corre dentro de
`onAuthStateChanged` (`:83`), así que en **toda carga en frío** la clave gira una
vez de `'signed-out'` al uid y React destruye y reconstruye el subárbol entero
— `<Routes>` y `EntityExplorer` incluidos.

Medido (corrida 5, reproducido en 5b):

```
t=423  gen2  pad 0px  heroH 114    op 0.35  settle 114px>237.938px@0    tabs 210
t=601  gen2  pad 0px  heroH 182.1  op 0.93  settle 114px>237.938px@133  tabs 278.1
t=624  gen3  pad 0px  heroH 114    op 1.00  settle -                    tabs 210    ← vuelve al esqueleto
t=635  gen4  pad 0px  heroH 114    op 0.35  settle 114px>237.938px@0    tabs 210    ← y monta otra vez
```

El héroe llega al **93 %** de su entrada, con la tira ya 68,1 px abajo, y
entonces **retrocede 68,1 px en un fotograma** (278,1 → 210). `slideUpFade`
reinicia en 0,35 y el settle en `currentTime 0`.

Es el **único movimiento hacia atrás** de la página. Un error de dirección, no de
magnitud: un lector no puede leerlo como carga, sólo como fallo.

Lo que hace falta saber para arreglarlo: la clave **es portante**. Existe para
aislar el estado por cuenta (`e507856`, «isolate recommendation state»);
quitarla sin más arrastraría el estado de `FollowingProvider` a través de un
cambio de cuenta. Y al dejar de remontar, los `useState(Boolean(user))` de
`FollowingContext.jsx:59` y `EmailNotificationsContext.jsx:36` — que son lecturas
**del momento del montaje** — dejan de capturar la cuenta: en frío leen `false`
mientras el uid viene de camino, y la ventana entre el uid y el primer snapshot
se lee como un «no sigues a nadie» asentado. Esa es exactamente la ausencia sin
confirmar que `FollowingContext.jsx:105-118` documenta y sobre la que
`FeedContext` espera antes de cargar un feed.

### B. Los 56 px de banda de barra aparecen sin animar

`appChrome={showNavbar}` (`src/App.jsx:395`) y
`.explorer--app { padding-top: var(--nav-total) }`
(`src/components/Explorer/EntityExplorer.css:26`, con `--nav-total` en
`src/styles/variables.css:277` y su variante móvil en `:285`).
`showNavbar` (`src/App.jsx:131-139`) exige `Boolean(user)` además de
`!authLoading`, `onboardingComplete` y `!profileLoadError`.

Medido (corrida 5):

```
t=819  pad 0px   heroTop 80   heroH 194.1  settle 114px>237.938px@150  tabs 290.1
t=909  pad 56px  heroTop 136  heroH 222.7  settle 114px>237.938px@217  tabs 374.7
```

`padding-top` 0 → 56 px y `heroTop` 80 → 136 **en un fotograma, sin animar**,
aterrizando en `currentTime 217/360` — en mitad del settle. Vive en un
**ancestro** de la caja que anima `useHeightSettle`, así que el settle no puede
verlo ni absorberlo: dos movimientos simultáneos del mismo contenido, uno
animado y otro no. En móvil son 52 px, y el mismo fotograma cambia además el
`padding-top` de `.explorer--app .explorer-hero`.

**Son dos arreglos, no uno.** A aterriza a 624 ms y B a 909 ms, 285 ms después,
porque `showNavbar` espera también a `onboardingComplete` y `!profileLoadError`.
Arreglar la clave no mueve el salto de la banda ni un fotograma.

### Y en reduced motion los dos empeoran

Ninguno de los dos está tras `prefers-reduced-motion`. Sin settle que suavice la
re-llegada (`enabled: !prefersReducedMotion` en
`src/components/Explorer/EntityExplorer.jsx:484`), **todo** es salto de un
fotograma (corrida 9):

| t | Salto | Magnitud |
|---|---|---|
| 369 | 114 → 237,9 | +123,9 |
| 819 | 237,9 → 463,6 | +225,7 |
| 981 | 463,6 → 114 (el remontaje) | **−349,6** |
| 1006 | 114 → 237,9 | +123,9 |
| 1152 | `padding-top` 0 → 56 | +56 |
| 1347 | 237,9 → 463,6 | +225,7 |

Dos números distintos, y conviene no confundirlos:

- **Desplazamiento neto** (suma con signo): `123,9 + 225,7 − 349,6 + 123,9 + 56 +
  225,7 = 405,6 px`. Coincide con el viaje total del caso animado, que es
  precisamente lo que lo hacía fácil de malinterpretar.
- **Movimiento total** (suma de magnitudes): `123,9 + 225,7 + 349,6 + 123,9 + 56
  + 225,7 = **1104,8 px**`, repartidos en **seis saltos de un fotograma**, con la
  llegada entera ocurriendo dos veces.

El número que describe lo que sufre el lector es el segundo. Reduced motion no
mitiga estos dos defectos: los empeora.

---

## 3 bis. Verificado tras los arreglos (mismo día, mismas sondas)

Arreglados en `ecab111` (el remontaje) y `cf35e1a` (la banda), medidos otra vez
contra el mismo perfil con sesión y un build de producción del árbol con los
arreglos dentro.

| Objetivo | Antes | Después |
|---|---|---|
| Generaciones del nodo del héroe, en frío | **4** | **1–2** (sólo el relevo esqueleto→vivo, que es irreducible) |
| Retroceso de la tira de pestañas | **−68,1 px** escritorio, −108 móvil, −349,6 reduced motion | **0 en los cuatro casos** |
| Salto de la banda de barra | **+56 px** (52 móvil) en UN fotograma | **0** — se abre en 245 ms, máximo **6,35 px/fotograma** |
| Reduced motion: saltos de un fotograma ≥ 8 px | **6**, suma de magnitudes **1104,8 px**, con un retroceso de −349,6 | **1**, de **281,7 px**, ninguno hacia atrás |

La apertura de la banda, fotograma a fotograma (frío, escritorio): `padTop`
0 → 6,35 → 12,31 → 17,93 → 23,29 → 28,36 → 33,08 → 37,48 → 41,56 → 45,25 →
48,51 → 51,29 → 53,51 → 55,09 → 55,92 → 56 px. Ease-out, front-loaded, sobre el
mismo reloj de 240 ms de `navbarArrive`.

Sin fotogramas perdidos: 537 muestras en 9 s en escritorio, 528 en móvil, 535 en
reduced motion — 59,7, 58,7 y 59,4 fps. Animar `padding-top` es una animación de
layout, pero cae sobre fotogramas en los que el settle ya está forzando layout
completo, así que no añade pasadas.

Lo que **queda** y no se tocó, por estar en la lista de lo ya decidido: el mayor
movimiento por fotograma sigue siendo **32,9 px** (escritorio) / 32,5 px (móvil),
y es entero del settle del panel de experiencia — el hallazgo refutado 2/3 de la
sección 6.

## 4. Reducciones (impacto bajo, sin medición nueva)

- `EntityExplorer.css:754` y `:1021` — `exSkelSweep 1.5s ease-in-out infinite`
  → `linear`. Movimiento constante en bucle; un `ease-in-out` se para en los dos
  extremos y late en vez de barrer.
- `EntityExplorer.css:1177`–`:1181` — la escalera de retardos del esqueleto llega
  a 1,08 s y el esqueleto vive **418 ms** por la ruta rápida: las formas con
  0,96 s y 1,08 s no barren ni una vez. Cortar en ~0,5 s.
- `EntityExplorer.css:338` `transition: transform 0.34s` con su pareja
  `EntityExplorer.jsx:1849` `height: { duration: 0.34 }` → `0.26s` en **ambos**.
  Emparejarlos es correcto; el número pasa el techo de 300 ms.

## 5. Aplazado

El doble fundido del héroe nacido resuelto (`bornResolved`,
`EntityExplorer.css:150`: la exención de `slideUpFade` cuelga de `.is-skeleton`,
que un héroe nacido de traspaso nunca lleva). Medido en el build demo: opacidad
efectiva 0,05 a 86 ms donde una página nacida con esqueleto da 0,10, y el héroe
sigue resolviendo 118 ms después de que la página aterrice. **Su única evidencia
es del build demo** y la ruta con traspaso no se ha medido con sesión real.
Pendiente de esa medida.

---

## 6. Tres conclusiones RETIRADAS

Las tres salieron de la auditoría sobre el build demo y **cayeron** ante una
ronda de refutación adversarial (dieciocho refutadores, tres lentes por
hallazgo) contrastada con la sesión real. **No volver a proponerlas.** Si alguien
cree que hay que reabrir una, que lo diga antes de escribir código.

### ❌ «Subir `SAME_HEIGHT_PX` de 1 a 24» — refutada 3/3

El efecto es real (un re-apuntado a mitad de vuelo arranca un reloj nuevo y
completo de 360 ms), pero **el mecanismo estaba mal atribuido** y la cifra mal
leída:

- El cambio de contenido eran **4,759 px** (233,179 → 237,938). Los «12,6 px» que
  se citaron son el **recorrido de la animación nueva** (237,938 − 225,344), no
  el del contenido.
- El reloj completo no lo causa el umbral: lo causa
  `src/hooks/useHeightSettle.js:84-89`, que construye cada re-apuntado con
  `el.animate(..., { duration })` completo y sólo traslada `currentTime` por la
  rama `resume` (`:89`). `SAME_HEIGHT_PX` (`heightSettlePlan.js:2`, `:35`) sólo
  decide *resume* contra *re-aim*; con 4,759 px de movimiento del objetivo,
  cualquier umbral por debajo de ~4,8 da el mismo resultado.
- **Subirlo reintroduce el salto final** que `heightSettlePlan.js:26-30` y
  `heightSettlePlan.test.js:42-50` documentan como medido.
- El orden de las ramas (`:34` antes de `:40`) es una guarda, no la causa: como
  `useHeightSettle.js:76` cancela la animación en vuelo sin condición, invertir
  el orden haría que un commit a mitad de vuelo sin deps devolviera
  `action:'none'` y **la caja daría un salto**.

Si algún día se ataca: el arreglo vive en la rama de re-apuntado del hook
(arrastrar el tiempo transcurrido, o escalar la duración restante a la distancia
restante), **no en el umbral ni en el orden de las ramas**.

### ❌ «Reservar el panel de experiencia en `OrcidCardSkeleton`» — refutada 2/3

Era el titular de la auditoría del demo. Cae por cuatro razones:

- **Atribución.** El movimiento tardío es **+225,7 px de reposo a reposo**
  (463,625 − 237,938), no los +230,1 que se citaron — ese número está leído a
  mitad de vuelo. Y el panel es **176,3 de esos 225,7 px (78 %)**, no el
  movimiento entero: los ~49 px restantes son la biografía
  (`EntityExplorer.jsx:2168`), los enlaces de investigador (`:2175`) y la
  formación (`:2190`) de la propia tarjeta ORCID, más el galón de la fila del
  título (`:1584`), todo en el mismo commit de `orcidInfo` y todo igual de sin
  reservar.
- **El control no era un control.** La corrida 3 (un solo settle, la tarjeta
  relevando al esqueleto 1:1 a 96 px) es **otro autor**, cuyo registro no tenía
  empleos ni ninguno de los bloques opcionales. No aísla el panel.
- **Ya se probó y se revirtió.** `src/utils/explorerSkeletonShape.js:63-70`
  registra por qué se retiró incluso la reserva de 96 px de la tarjeta en rutas
  por id (`f298842`, 2026-09-05): «tres de cada cuatro autores no tenían
  registro, y un bloque reservado que no llega es la lista subiendo 113 px
  400 ms después de que la página haya aterrizado». Y el empuje **ya está capado
  a 4 filas** (`EntityExplorer.jsx:68-72`, `7e0bbcc`), cap instalado tras medir
  una versión sin capar con 590 px de panel empujando la tira 1108 px en 710 ms.
- **Los datos dicen que fallaría más de lo que acertaría.** Muestreo de 40
  registros ORCID reales: **23 de 40 (57,5 %) no listan ningún empleo**. Los
  empleos sólo se conocen dentro del registro que se está esperando
  (`EntityExplorer.jsx:765`), así que ni siquiera una ruta que traiga un id ORCID
  puede saber si hay panel ni de qué alto.

Lo que sí es cierto y conviene no perder: el defecto es **frecuente**, no raro —
el 79,7 % de los autores de artículos recientes llevan ORCID y 17 de 40 registros
listan 1–4 empleos, la banda que abre por defecto. Pero está acotado, animado y
señalizado por un esqueleto, y apunta a un arreglo ya medido y rechazado.

### ❌ «Cancelar el settle cuando la página deja de estar presente» — refutada 2/3

El mecanismo es real: el hook no tiene limpieza (`useHeightSettle.js:59-97`) y
`AnimatePresence mode="sync"` mantiene montada la página saliente. Pero:

- **La cifra estaba inflada.** La tira viajando 369,2 → 403,6 son 34,4 px, de los
  cuales **24 son el `translateY(24px)` deliberado de `pageLeave`**
  (`PageTransition.css`). Al settle le corresponden **10,4 px**, que son el 9 %
  final de un settle de 115 px cuyo 91 % el lector ya vio.
- **Cancelarlo lo empeora.** Convertiría esos 10,4 px en un salto de un fotograma
  a opacidad ~0,9.
- **La página saliente no puede empujar a nadie.** Es `position: fixed; height:
  auto` desde el fotograma en que deja de estar presente, así que sus cambios de
  caja no mueven las cajas de la página entrante. Los fotogramas de la transición
  medidos en ese escenario exacto salen limpios: `void 0, exposed 0, en reposo a
  317 ms` — más rápido que los 380 ms del caso de ida.

---

## 7. Lo que está bien y no hay que tocar

Medido, no supuesto:

- **La capa de transición de ruta.** `83 fotogramas; barra en 83/83; void 0;
  solape 20; expuestos 0; en reposo a 380 ms; held cards ≥ 1.00`. Saliendo a
  mitad de llegada: `void 0; expuestos 0; en reposo a 317 ms`.
- **La curva del settle**, `cubic-bezier(0.4, 0, 0.2, 1)`, elegida y documentada
  en `EntityExplorer.jsx:479-483` contra una expo-out que gastaba 70 px en un
  fotograma en el móvil.
- **La puerta del hover**: las 23 reglas `:hover` de `EntityExplorer.css` van tras
  `@media (hover: hover) and (pointer: fine)`.
- **`prefers-reduced-motion`** cubre el settle, todos los keyframes, y conserva
  las transiciones de color.
- **`:active { transform: scale(0.97) }` con `transform 0.16s ease-out`**.
- **El stagger**: 35 ms por elemento, capado a 8 en los dos sitios — en el JSX
  para las filas (`EntityExplorer.jsx:2299`, `Math.min(idx, 8)`) y en el CSS para
  las tarjetas de autor (`EntityExplorer.css:1396`,
  `calc(min(var(--i, 0), 8) * 0.035s)`). Máximo 280 ms; no hay escalera larga.
- Ni un `transition: all`, ni un `scale(0)`, ni un `ease-in` en ninguna entrada.

---

## 8. Cómo repetir la medida

```bash
# Servidor: build de producción (NO vite dev — el modo desarrollo de React
# añade tareas de 90-135 ms que el build no tiene).
npm run build && npx vite preview --port 5174 --strictPort

# El perfil con sesión: lo abre el usuario en un Chrome VISIBLE y se cierra
# antes de medir (Chrome bloquea el --user-data-dir mientras hay instancia viva).
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 --user-data-dir="$HOME/.papertok-probe-profile" \
  --no-first-run --no-default-browser-check http://localhost:5174

# Y después, contra ese perfil:
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/explorer-loading-probe.mjs timeline '#/explorer/author/A5006398227' 14
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-author-link[href*="?name="]' late 8000
```

**Sólo las sondas con la guarda `OWN_PROFILE` pueden apuntar a un perfil con
sesión**; sin ella borran el `--user-data-dir` al terminar. Las tres del
directorio la tienen desde 2026-09-07.

Un truco que ahorra tiempo: `fromfeed` con el selector
`.pc-author-link[href*="?name="]` fuerza la ruta rápida por id y
`[href*="arxivId="]` la lenta por nombre; sin sesión los enlaces del feed apuntan
a `/public/entity/…` y no a `/explorer/…`, lo que sirve además como comprobación
de que la sesión se ha heredado.

---

## 11. Ejecución de la revisión del 09-09 (medido el 10-09)

Los diez hallazgos de la revisión de código de `5fb6c03..aea5a59` se ejecutaron en la rama
`sdd/animaciones-autor`, una tarea por commit, cada una con su test que falla primero y su
comprobación por mutación, y cada una revisada por un agente independiente. Suite final:
**2479 tests, 0 fallos, lint limpio**.

### La decisión que ordena todo lo demás

**El settle vuelve a ser el único dueño de la altura del héroe.** Durante dos días (del
`3b96b3a` al `aea5a59`) el fold de Wikipedia animó su propia `height: 'auto'` dentro de la
caja que ya anima `useHeightSettle`, y para que no se pisaran el hook acumuló nueve
mecanismos de reconciliación. La revisión midió ese andamiaje como la causa de tres
defectos distintos. Ahora el bloque entra por **opacidad** y su espacio lo lleva el settle
bajo su recorte — igual que el panel de experiencia, que ya lo hacía bien en la misma caja.

**No volver a proponer que un hijo de `.explorer-hero-content` anime su altura.** Un bloque
que llega dentro de esa caja anima su contenido; el espacio lo lleva `useHeightSettle`.

Una consecuencia que costó encontrar: con el fold sólo animando opacidad, **nadie cerraba
el hueco al irse**. `AnimatePresence` retira el nodo con un `setState` propio que
re-renderiza `AnimatePresence` pero **no** a `EntityExplorer`, y el settle sólo mide en los
commits de ese componente. Cerrado con `onExitComplete`, que incrementa un contador incluido
en los deps del settle. Verificado leyendo el `onExit` de framer: `setRenderedChildren` y
`onExitComplete()` son dos sentencias síncronas seguidas, así que el mismo commit está
garantizado por construcción, no por el agrupamiento de React.

### El «después», medido

Build de producción del worktree servido en `:5174`, perfil de Chrome con sesión real.

| Caso | Antes | Después |
|---|---|---|
| **Institución → autor** | **+152,3 px en UN fotograma** a 642 ms, sin settle | Un único settle `237,938 → 390,234` corriendo su reloj entero (`@0` → `@333`); la tira se desliza 389,9 → 542,2 |
| **Institución en frío** | Esqueleto 30 ms, después las cuatro cifras de golpe | **0 fotogramas de esqueleto**; 0 saltos ≥20 px sin settle |
| **Vuelta autor → institución** | Cuatro settles en 76 ms, la tira hundiéndose 16 px | 0 settles durante el `reveal`; asienta 287,4 → 320,2 **durante** la vuelta, en reposo a 336 ms |

Los cuatro números del esqueleto vienen además de una corrida propia de la Tarea 11: cero
fotogramas con `.explorer-skeleton` y las cuatro cifras en pantalla a **t = 484 ms**, con el
héroe todavía en opacidad 0,35 — es decir, los datos ya están cuando empieza el fundido.
Control negativo hecho con un id inventado (`skel: true`), así que la sonda discrimina.

### Lo que NO está medido, y conviene no dar por hecho

- **El cambio de idioma con el bloque de Wikipedia abierto.** El mecanismo está verificado
  en código y revisado —el bloque se queda montado a través de una re-búsqueda en vez de
  plegarse y volver— pero no se ha visto en vivo.
- **Móvil y `prefers-reduced-motion`** no se remidieron tras estos cambios.

### Trampa de la sonda, para quien repita la medida

`explorer-hero-frames.mjs` **no acota** su `querySelector` a la página que se queda, así que
mientras las dos comparten pantalla lee la tira de la **saliente**. Eso produce un
`−102,2 px` a t≈356 que parece un salto y no lo es. `entity-back-frames.mjs` sí lo acota
(`data-page-motion` distinto de `leave`/`hold`/`fade`); convendría portar esa acotación.

### Una limitación conocida que queda abierta

El injerto de ids de OpenAlex por **posición** (que arregla que dos coautores con el mismo
apellido recibieran el mismo id) **no alcanza a los papers de colaboración**, que son justo
los que motivaron el bug: `MAX_ENRICHMENT_AUTHORS = 50` acota el lado de OpenAlex y el de
arXiv no se acota, así que las listas nunca tienen la misma longitud y sólo actúa el
respaldo por coincidencia única. **No es una regresión de seguridad** — esos autores caen en
`null` (la puerta lenta), nunca en el id de otra persona. El arreglo futuro es barato porque
el recorte es de prefijo: permitir la posición cuando
`candidates.length === MAX_ENRICHMENT_AUTHORS && index < candidates.length`.

### Dos trampas del repositorio que mordieron durante la ejecución

- **`OpenAlexClient` es un singleton de módulo con una caché de respuestas DELANTE de
  `fetchImpl`**, y no se limpia entre tests del mismo proceso. Dos tests que usen la misma
  URL comparten en silencio una respuesta y el stub del segundo **no dispara nunca** — deja
  el test verde sin probar nada. Usa ids distintos por test.
- **`no-use-before-define` es estricto con variables**: un test colocado encima del helper
  que usa pasa `node --test` y **rompe el lint**.
