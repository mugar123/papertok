# Auditoría de las animaciones del Explorer (2026-09-05)

Revisión de motion de los ocho caminos que abren una entidad: autor, institución,
proyecto y tema, desde el feed y desde la paleta de búsqueda. Es la especificación
del plan `docs/superpowers/plans/2026-09-05-explorer-animaciones-arreglo.md`.

## Cómo se midió

Build de producción (`npm run build`, `vite preview --port 5173`), Chrome headless
conducido por CDP, 1280×900 y 390×844 a 2×, perfil limpio por corrida, como
visitante. Un muestreador por `requestAnimationFrame` registra cada fotograma la
caja (`top+height`) del cuerpo del héroe (`.explorer-hero-content`), la Web
Animation del settle (`from`, `to`, `currentTime`), el panel de experiencia y su
inner, la tarjeta ORCID, el fold y el bloque de Wikipedia con su `transform`
computado, la tira de pestañas y el borde superior de la lista, y las dos páginas
bajo `#main-content` (opacidad y transform). Los fotogramas idénticos consecutivos
se colapsan; lo que queda es la lista de fotogramas en los que algo se movió.

Para la paleta de búsqueda hizo falta una build con `IS_DEMO = true` (nunca
commiteado) y `papertok_user`, `papertok_onboardingComplete` y
`papertok_selectedCategories` sembrados en `localStorage` antes del primer script:
la paleta solo monta con sesión. El texto se teclea con `Input.insertText` (cmdk
ignora el setter nativo).

El feed no tiene enlace a instituciones. La insignia de proyecto no llegó a
montarse en el feed de invitado en dos pasadas; ese disparador va revisado por
código y la página de proyecto medida desde la búsqueda.

## Hallazgos

Cada uno lleva su medida y el fichero. La letra es la referencia que usa el plan.

### A1. El settle aplasta a cero los hijos con `overflow: hidden`

`useHeightSettle` pinza la altura de `.explorer-hero-content` (flex column,
`EntityExplorer.css:101`) con una Web Animation. Con altura definida menor que su
contenido, flex encoge a los hijos cuyo mínimo automático es 0, que son
exactamente los que llevan `overflow` distinto de `visible`:
`.ehc-experience-panel` (`:294`), `.ehc-wiki-fold` (`:606`), `.ehc-wiki` (`:588`).

Medido, autor A5068353058, escritorio y 390 px: al llegar ORCID el cuerpo asienta
237,9→479,3 en 360 ms; el panel mide **0 px durante 117 ms** con su inner a 136
todo el rato, crece 0→152 en la cola del settle y empuja 152 px hacia abajo la
tarjeta ORCID que ya había aterrizado en el hueco del esqueleto. En institución el
fold mide 150 con 168 de contenido bajo un settle de +18. Es el «bug del
desplegable al construir la página». El `initial={false}` de b0b9fe2 no lo tocó
porque nunca fue framer.

### A2. La memoria del settle se queda rancia

`lastHeightRef` (`useHeightSettle.js:44-55`) solo se actualiza cuando cambian las
`deps`. Cualquier cambio de altura sin dep la deja atrás: el botón «Leer más»
monta un commit después del párrafo por el rAF de `measureExpandableDescriptions`
(`EntityExplorer.jsx:476-484`); plegar el panel de experiencia; los participantes.

Medido, tema `bio.neuro` desde la píldora de una tarjeta: Wikipedia llega a 949 ms,
settle 146→216,4 medido sin el botón (que monta a 966); al soltar, **la lista
salta +27 px en un fotograma**. A 2732 ms carga la miniatura, `hasLoadedWikiImage`
cambia, y el hook anima desde la altura rancia: **la lista sube 27 px de golpe y
baja en 350 ms**. Es el «sube y baja». Proyecto FW04020064 desde la búsqueda:
cuerpo 366,8→388,8 y pestañas 462,8→484,8 en un fotograma al soltar. Institución
I173304897: 333→311→320, rescatado por casualidad porque la miniatura llegó antes
de soltar.

### A3. `layout` en el fold de Wikipedia y en la caja de resumen

`.ehc-wiki-fold` lleva `layout` (`EntityExplorer.jsx:1982`, `:2018`) y
`.project-summary-box` también (`:1871-1884`). Son un segundo dueño de la misma
altura que el settle ya lleva. Medido: la proyección estira el párrafo a scaleY
1,21 con 13,5 px de desplazamiento durante 380 ms en el tema, y a 1,3 con 20 px
durante un fotograma en la institución. Texto serif escalado en vertical.

### A4. El panel de experiencia aparece a opacidad 1

`initial={!experienceToggled ? false : …}` (`EntityExplorer.jsx:1784`) apaga
también el fundido. Medido: opacidad 1,00 desde el primer fotograma.

### A5. Un tema local nace cargando un commit

`bornResolved` solo cubre ids `query-` (`EntityExplorer.jsx:224`). La píldora de
categoría de una tarjeta navega a un id local (`bio.neuro`), que `getEntityById`
resuelve sin red vía `getLocalTopicEntity` (`openAlexService.js:1133`) pero a través
del efecto asíncrono. Medido: esqueleto commiteado y sustituido en el mismo
fotograma; settle 109→146 durante la propia entrada de la página, con el fold
aplastado 21→58.

### A6. Elegir un resultado de la paleta disuelve tres cosas en tres relojes

`go()` cierra la hoja y navega en el mismo tick (`SearchCommand.jsx:165-169`). La
hoja sale con `scSheetOut` 220 ms `[0.4, 0, 1, 1]` y −14 px, el velo con `fadeOut`
220 ms `ease` (`SearchCommand.css:348-361`), y el feed debajo con la salida de
página de 200 ms `ease-in`. Medido: a 100 ms hoja 0,72, velo 0,25, feed 0,64; a
203 ms los tres por debajo de 0,14 y la página nueva sin montar; el esqueleto
monta a 225 ms bajo un fantasma de la hoja al 2 %. Dos fotogramas vacíos y tres
direcciones para un toque.

### A7. La entidad que la paleta ya tiene llega como esqueleto

Las filas de la paleta tienen el objeto entero (`SearchCommand.jsx:270-330`) y
`go()` solo pasa estado de router para papers. Medido: autor desde la búsqueda,
settle 226→113 a los 627 ms, pestañas 322→209; en móvil 434→278 arrancando a
301 ms con la página al 0,86 y todavía deslizándose.

### A8. El esqueleto de autor reserva ORCID para todos

`explorerSkeletonShape.js:60-64` reserva `aside: 'orcid'` para cualquier autor.
Tres de los cuatro autores abiertos en la sesión no traían panel; el que sí lo
traía (Sanchez-Costa, T., desde el feed) empujó la lista 1108 px en 710 ms con el
panel abierto por defecto. Un bloque reservado que no llega es la lista subiendo
113 px 400 ms después de aterrizar; un bloque no reservado que sí llega es un
crecimiento por debajo bajo el recorte del settle.

### A9. La paleta abre en 380 ms sobre un velo de 380 ms

`scSheetIn` 380 ms y velo `fadeIn` 380 ms `ease` (`SearchCommand.css:344-357`);
filas a 260 ms con escalón de 24 ms hasta diez (`:235`, `ENTER_STAGGER_CAP = 10`).
Medido: hoja al 0,98 a 200 ms, velo todavía al 0,86 y oscureciendo hasta 350; la
última fila termina a ~500 ms. Se pidió más lento el 03-09; el motivo de entonces
(«parecía encendida») lo resuelven los 24 px de recorrido, no los 380 ms.

### A10. La insignia de proyecto de la tarjeta tarda 900 ms

`PaperCard.jsx:1258-1300`: `height: 0 → auto` 450 ms `[0.25, 0.1, 0.25, 1]` y dentro
`y`/`scale` con 300 ms de retardo y 600 ms. Propiedad de maqueta y atajos de framer
en el hilo principal dentro del feed, decenas de veces al día. Revisado por código.

### A11. El error corta en seco y el párrafo de Wikipedia se sustituye sin llegar

`.explorer-error` (`EntityExplorer.css:20`) no tiene entrada: medido abriendo desde
el feed un autor de arXiv sin perfil en OpenAlex, 700 ms de esqueleto de 1300 px y
un mensaje centrado en un fotograma. El `<p>` de Wikipedia cambia de texto sin
remontar (`EntityExplorer.jsx:2061`): pasa de una línea local a tres de Wikipedia
a opacidad 1, sin la llegada que `wikiProseIn` promete.

### A12. La transición de página: `ease-in` y `mode="wait"`

`EASE_LEAVING = [0.4, 0, 1, 1]` (`PageTransition.jsx:56-60`) con
`AnimatePresence mode="wait"` en `App.jsx`. Medido desde una tarjeta: feed al 0,06 a
190 ms y a 0 a 208; esqueleto a 0 a 225 y al 0,34 a 242; 500 ms de toque a página
quieta. **Fuera de este plan**: toca todas las rutas y merece uno propio.

## Lo que está bien y no se toca

El menú de enlaces del proyecto (`transform-origin: top left`, 160 ms, escala 0,98
con opacidad). La hoja de la paleta anclada arriba (`transform-origin: 50% 0`) y su
salida más corta que su entrada. El encadenado de settles cuando una dep llega a
tiempo. El fundido cruzado icono→foto con el velo del fondo en un solo reloj. Todo
el movimiento respeta `prefers-reduced-motion` y conserva el color; el hover va
tras `(hover: hover) and (pointer: fine)`.

## Después (2026-09-05)

Mismo montaje que en «Cómo se midió»: build de producción, `vite preview` en :5173, Chrome
headless por CDP a 1280×900, perfil limpio por corrida, sonda por fotograma
(`scripts/diagnostics/explorer-hero-frames.mjs`). Para los tres caminos de paleta se repitió
la build con `export const IS_DEMO = true;` en `src/services/firebase.js`, sesión sembrada en
`localStorage`, y se revirtió a `false` antes de medir nada más: `git diff --stat
src/services/firebase.js` no imprimió nada, comprobado antes de lanzar las cuatro sondas
`fromsearch`. La build de `dist/` termina la tarea como build normal (`index-l2bo-j40.js`,
mismo hash que la primera build de esta verificación).

Rango de commits que cubre el arreglo: `e4c7a00..ba7de5e` (22 commits en el árbol). De esos,
16 son de este plan — tareas 0 a 12, con la tarea 13 omitida — incluido el merge `74e17d7`
que trajo `3672991` (la migración de la interfaz a shadcn/ui sobre Base UI, hecha en
`origin/main`). Los otros 6 commits (`0382b31`, `6800abc`, `298a7ef`, `13f6225`, `ee6b967` y
el propio `3672991`) pertenecen a un plan distinto y concurrente sobre el mismo worktree — el
del toque en las pestañas del móvil — entrelazados con estos por dos sesiones trabajando el
mismo árbol; el ledger de esta tarea (`.superpowers/sdd/2026-09-05-explorer-animaciones-arreglo/progress.md`)
tiene el detalle commit a commit.

### La tabla

Los mismos ocho caminos de la auditoría: autor, institución, proyecto y tema, desde el feed
y desde la paleta. La sonda no puede alcanzar «proyecto desde el feed» por la misma razón que
en la medición original — la insignia no llegó a montarse en el feed de invitado — así que
sigue sin medirse en vivo; el resto, siete corridas. «Paso máx. tira» es el mayor salto de un
fotograma al siguiente en la posición de la tira de pestañas; «antes» usa la cifra más
comparable que dejó la auditoría, y donde no hay ninguna dice `n/d` en vez de inventarla.

| Camino | Paso máx. tira: antes → después | Panel exprimido: antes → después | Fold estirado: antes → después | Esqueleto: antes → después |
| --- | --- | --- | --- | --- |
| Autor, ruta directa (A5068353058) | n/d → **30,2 px** (dentro de un settle de 360 ms, ver nota) | **~7 fotogramas** (0 px durante 117 ms, Tareas 3+4) → **0** (39 fotogramas reales) | no aplica (el autor no tiene fold) | n/d → 2 de 90 (arranque en frío por URL; no es un camino que la paleta entregue) |
| Autor, paleta (q=moher → A5105180016) | **113 px** (settle 226→113, pestañas 322→209, A7) → **0,0 px** | no aplica: ni `orcidSkel` ni `orcidCard` aparecen en ningún fotograma — este autor no tiene ORCID | no aplica | n/d → 0 de 50 |
| Institución, ruta directa (I173304897) | n/d directo; A2 da la secuencia equivalente 333→311→320 (ver nota) → **2,3 px** | no aplica (institución no tiene panel) | **150 vs 168 de contenido, exprimido 18 px** (A1) → **0** (68 fotogramas reales, transform siempre `none`) | n/d → 2 de 72 (arranque en frío por URL) |
| Institución, paleta (Harvard University → 03vek6s52) | n/d (A7 solo dio el número del autor) → **1,6 px** | no aplica | n/d → **0** (59 fotogramas reales) | n/d → 0 de 74 |
| Tema, feed (`.pc-topic-link` → cs.AI, ver nota) | **+27 px en un fotograma** (A2, sobre bio.neuro) → **12,2 px**, repartidos en un settle de ~350 ms | no aplica | **aplastado 21→58 al nacer** (A5) → nace ya en 58, **0** (57 fotogramas reales) | «comiteado y sustituido en el mismo fotograma» (A5) → **0** de 72 |
| Tema, paleta (q=neuroscience → bio.neuro) | n/d → **12,3 px**, mismo tipo de settle de contenido | no aplica | n/d → **0** (58 fotogramas reales) | n/d → 0 de 72 |
| Proyecto, paleta (q=graphene → FW04020064) | **22,0 px en un fotograma, sin animación** (A2, mismo proyecto) → **13,4 px**, repartidos en un settle de 360 ms hacia el mismo destino (388,8) | no aplica | sin dato — esta sonda mide `.ehc-wiki-fold`, no `.project-summary-box` | n/d → **5 de 45** (ver «Qué no mejoró») |
| Proyecto, feed | no medido (igual que en la auditoría: la insignia no monta en el feed de invitado en corridas de prueba) | — | — | — |

### Por qué los ceros son ceros de verdad

Los siete `.log` tienen su `[navigated]`, su `hash` final correcto y, en los cuatro caminos de
paleta, su línea `target: …` con el texto de la fila que se clicó — nunca un target vacío ni
un hash que se quedó en `#/`. Antes de confiar en el «0» de cada columna:

- **Panel exprimido**: el chequeo compara `panel` contra `inner`; en el camino de autor por
  ruta hay 39 fotogramas con ambos campos no nulos, y en los 39 el panel (152,3 px) es mayor
  que su inner (136,3 px) todo el tiempo — nunca al revés. No es un campo ausente que colapse
  a cero por defecto.
- **Fold estirado**: el chequeo busca `sy1.` seguido de un dígito en la transform computada.
  Institución, los dos temas y la institución-paleta tienen entre 57 y 68 fotogramas reales
  con `fold` no nulo, y en los cuatro el campo de transform es literalmente `@none` en el
  100 % de esas filas — no hay ninguna matriz que el regex pudiera fallar en leer. En
  institución, además, se comprobó a mano que la caja del fold (155,4 px) mide exactamente lo
  mismo que su `wiki` (155,4 px) durante todo el settle re-apuntado: nunca hay contenido que no
  quepa.
- **Esqueleto**: en los tres caminos de paleta con handover (autor, institución, tema) es 0 de
  50/74/72 fotogramas reales, no de una corrida vacía. En autor y institución por ruta directa
  sí aparecen 2 fotogramas de esqueleto cada uno — arranque en frío por URL, nunca resuelto por
  esta tarea porque no es uno de los caminos que la paleta entrega (el navegador no trae nada
  en el estado del router al escribir el hash a mano).
- **Paso máximo de la tira**: se revisaron todos los fotogramas con un salto mayor de 10 px en
  los siete ficheros (23 en total) y los 23 tienen un objeto `settle` no nulo en esa misma
  fila — ninguno ocurre fuera de un settle en marcha. En autor por ruta el pico (30,2 px) cae
  en `ct=117` de un settle `237.938px→479.328px` (360 ms, cubic-bezier(0.4,0,0.2,1)): con la
  proporción que la Tarea 2 ya midió en su propia regla (8,8 px de pico sobre 70,4 px de
  recorrido = 12,5 %), un settle de 241,4 px de recorrido predice 30,2 px — coincide con el
  valor medido a la décima, y queda muy por debajo del cuarto de recorrido (60,3 px) que el
  guion de verificación da como techo.

### Institución por ruta: el mismo caso, ahora sin depender de la suerte

El hallazgo A2 describe I173304897 como «333→311→320, rescatado por casualidad porque la
miniatura llegó antes de soltar». La corrida de hoy, sobre la misma institución, deja ver el
mecanismo: un primer settle `315px→333.219px` termina normalmente a los 350 ms; 134 ms después
llega una re-decisión que apunta a `293.219px`, y 15 ms después —antes de que esa primera
re-decisión se pintara siquiera un fotograma, `ct=0` en ambas— una segunda re-decisión la
reemplaza por `320.219px`. El settle que de verdad se pinta es un único tramo suave
`333.219px→320.219px` a lo largo de 350 ms, sin frenazo ni doble salto: cada fotograma se
mueve como mucho 1,6 px. Los mismos tres valores del hallazgo — un pico cerca de 333, un valle
más abajo, un cierre cerca de 320 — siguen apareciendo, porque el contenido no cambió; lo que
cambió es que ya no dependen de que la miniatura gane la carrera por casualidad. El re-apuntado
los absorbe siempre.

### Tarea 13: omitida a propósito

La tarea 13 habría bajado la apertura de la paleta de 380 ms a 200 ms (hallazgo A9). El
controlador la saltó antes de dispatchear nada: los 380 ms de apertura (y el velo a 380 ms) son
un pedido explícito del usuario del 2026-09-03, documentado en el docstring del propio test de
motion de la paleta, y bajarlos habría revertido esa decisión sin que nadie lo pidiera de
nuevo. El problema real que A9 señalaba no era la duración de la apertura sino la salida al
elegir un resultado — eso es el hallazgo A6, y A6 sí se corrigió (tarea 9, commits
`f298842..efa5e2f`). La paleta de esta build sigue abriendo en 380 ms; lo que cambió es la
salida. Verificado en vivo en las cuatro corridas `fromsearch` de esta tarea: en las cuatro la
hoja cae de opacidad 1,00 a 0,01 en 60-70 ms desde el cambio de hash, con la transform en
`none` todo el tiempo (fundido puro, sin recorrido) — por debajo del propio umbral de «los tres
por debajo de 0,14» que la auditoría medía a los 203 ms en el código viejo. La omisión de la tarea
13 es una decisión registrada, no un olvido: el número que un lector futuro necesita para
revisarla está en `docs/superpowers/plans/2026-09-05-explorer-animaciones-arreglo.md`, tarea 13,
como «el cambio de una constante».

### Qué no mejoró, o no se pudo medir

- **Proyecto desde la paleta sigue naciendo en esqueleto.** La tarea 7 solo conectó tres tipos
  de fila (autor, institución, tema) al mecanismo de «la página nace ya con lo que la paleta
  tenía»; proyecto quedó fuera por decisión del propio plan (`SearchCommand.jsx` solo tiene
  `onSelect` especial para esos tres). El resultado se ve en la tabla: 5 de 45 fotogramas con
  esqueleto, y un settle real de 360 ms al llegar los datos. Lo que sí mejoró — y es lo que
  medía A2 — es que ese settle ya no es un salto de un solo fotograma sin animación (22,0 px
  «al soltar», sin curva) sino un tramo suave de la misma familia que los demás. El esqueleto en
  sí sigue sin resolverse; no es una regresión de esta tarea, es alcance que el plan nunca
  reclamó.
- **Proyecto desde el feed sigue sin medirse en vivo**, exactamente como en la auditoría
  original: la insignia de la tarjeta no llegó a montarse en el feed de invitado en las
  corridas de esta verificación tampoco. La tarea 12 cambió el código (900 ms → 200 ms, llega
  por compositor) y quedó revisada y verificada en vivo dentro de su propio dispatch (ver
  ledger, Tareas 11+12); esta tarea no repite esa medición porque no es uno de los siete
  comandos del paso 2 del brief.
- **No hay número de «antes» directamente comparable** para el paso máximo de la tira en
  autor-por-ruta, ni para ningún métrica en institución-paleta o tema-paleta: la auditoría
  original midió esos caminos con otras magnitudes (opacidad, porcentaje de recorrido) o no los
  midió en la combinación exacta que salió hoy (autor/institución/tema con handover, en vez de
  vía ruta). Se anota `n/d` en la tabla en vez de forzar una comparación que no existe.
  Cualitativamente el mecanismo es el mismo en los tres (nace ya resuelto, cero settle de
  entrada), y eso sí quedó verificado fotograma a fotograma arriba.
- **El tema por feed de hoy no es el mismo id que el de la auditoría.** A5 midió una píldora de
  categoría hacia `bio.neuro`; la corrida de hoy, contra el feed en vivo, aterrizó en `cs.AI`
  (Inteligencia Artificial) — el feed sirvió otra tarjeta, exactamente la variabilidad que ya
  advertía el encargo de esta tarea. La comparación de arriba es por mecanismo (nace resuelto,
  fold sin exprimir, cero esqueleto), no por id idéntico; donde hizo falta el id exacto de la
  auditoría (proyecto FW04020064, tema bio.neuro por paleta, institución I173304897 por ruta)
  la sonda sí lo alcanzó.
- **A12 (la transición de página, `ease-in` + `mode="wait"`) sigue fuera de este plan**, tal
  como la propia auditoría lo marcó («Fuera de este plan: toca todas las rutas y merece uno
  propio»). No se tocó ni se midió aquí.
- **Puntos ya señalados en el ledger de tareas y no vueltos a comprobar en esta verificación**:
  el bloque hermano `pc-linked-resources-slot` de `PaperCard.jsx` conserva la coreografía vieja
  de 450 ms que la tarea 12 dejó de usar para la insignia de proyecto, con un comentario que
  todavía la llama «la misma coreografía» (ya no lo es); y un fetch de entidad que lanza
  excepción sigue demoliendo un héroe ya pintado en vez de limpiar solo el esqueleto (hallazgo
  pre-existente, fuera del alcance de A11/tarea 10). Ninguno de los dos es nuevo: están en
  `progress.md` como diferido desde las tareas 7, 10 y 11+12.

### Verificación de arranque (paso 1 del brief)

`npm run lint` — limpio, sin salida, `exit 0`. `npm test` — 2164/2164 verdes, `exit 0` (las
líneas `Specialist source failed` y `Thread anchor failed` son ruido esperado de tests que
ejercitan a propósito esas rutas de error, no fallos). `npm run build` — build de producción
completa sin errores, `exit 0` (el aviso de chunks mayores de 500 kB es sobre el bundle
principal de la app, no sobre nada que este plan haya tocado — CSS y lógica de motion no
mueven esa aguja).
