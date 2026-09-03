# Explorador: la carga de autor, proyecto e institución, más fluida (2026-09-03)

Petición: «mejora las animaciones de carga de la pestaña de autor, de proyecto
y de institución; el objetivo es hacer la página más fluida». Las tres son la
misma pantalla (`src/components/Explorer/EntityExplorer.jsx` y su CSS), así que
se auditó la espera entera: el esqueleto, el relevo al héroe vivo, las piezas
que llegan después (ORCID, impacto reciente, Wikipedia) y el cambio de pestaña.

## Lo que hacía áspera la espera

1. **El brillo del esqueleto repintaba en el hilo principal.** `.ex-skel`
   animaba `background-position` (los keyframes `shimmer` de `variables.css`),
   que es propiedad de pintado: cada una de las ~50 formas del esqueleto de un
   autor se repintaba en cada frame mientras el perfil respondía, y también
   durante los 0,3 s en que la transición de página deslizaba la hoja entera.
   El feed (`SkeletonCard.css`) y el párrafo de Wikipedia ya barrían con un
   `transform` en `::after`; el explorador no.
2. **Las filas del esqueleto subían como si fueran filas.** Llevan la clase
   `.explorer-list-item` para heredar el padding y el filete, y con ella
   heredaban la entrada (`staggerFadeUp`): cuatro formas subiendo 6 px encima de
   la transición en el primer pintado, y las cinco del listado subiendo otra
   vez el frame en que aterrizaba el héroe.
3. **Un frame de «no se encontraron resultados» entre el héroe y el listado.**
   `isLoadingPapers` arrancaba en `false`; el primer render vivo llegaba antes
   del efecto que pide los papers, y en ese frame el listado estaba vacío y no
   cargando, que es exactamente la condición del estado vacío.
4. **La tarjeta ORCID saltaba dos veces.** El impacto reciente y el registro
   ORCID se pedían en serie, y `isLoadingOrcid` solo subía cuando el impacto
   había contestado: el hueco reservado por el esqueleto se cerraba al llegar
   el héroe, se reabría segundos después y se rellenaba más tarde. Y al llegar,
   la tarjeta se fundía desde cero (`orcidReveal`) y cada bloque tardaba
   **cuatro segundos** en asentarse (`orcidPremiumReveal 4s`), con el panel de
   experiencia apareciendo de golpe a su altura completa (`initial={false}`).
5. **Una institución sin web perdía su bloque de Wikipedia** al aterrizar el
   héroe (el esqueleto lo reservaba, el héroe vivo solo lo montaba con
   `homepage_url` o con descripción ya llegada) y lo recuperaba, empujando el
   listado, cuando llegaba el párrafo.
6. **Cambiar de pestaña rehacía el listado.** `activeTab` era dependencia del
   efecto de papers y su limpieza cancelaba la petición en vuelo: volver a
   Artículos era un segundo esqueleto y una segunda petición por filas ya
   leídas. Autores igual. Un proyecto pagaba otra vuelta: la entidad optimista
   arrancaba la petición y sus detalles, al llegar con el mismo código, la
   cancelaban y repetían.
7. Las tarjetas de autor partían de `opacity: 0` con `forwards` (parpadeaban
   desde la nada una tras otra), y la nota de impacto pasaba de «…» al número
   de un frame a otro.

## Lo que cambia

- `.ex-skel` es un bloque sólido con el barrido en `::after` (`exSkelSweep`,
  un `translateX`), con las mismas fases descendentes de antes, ahora en el
  pseudoelemento. El párrafo de Wikipedia usa el mismo keyframe. Las filas del
  esqueleto no animan (`.explorer-list-item.ex-skel-row { animation: none }`)
  y el esqueleto de página reserva cinco filas, las mismas que pinta el
  listado.
- `isLoadingPapers` arranca en `true` y cada carga de entidad lo rearma.
- El impacto y el ORCID se declaran antes de arrancar y se piden a la vez
  (`Promise.all`); el panel de experiencia crece al llegar; la tarjeta ORCID
  ya no se funde y sus bloques asientan a 0,42 s desde 0,35 con 6 px de
  subida, como las filas.
- La institución mantiene el bloque de Wikipedia abierto mientras la petición
  está pendiente (misma regla que temas y conceptos); si no llega nada, se
  pliega con la salida de `AnimatePresence` en vez de cortarse.
- La petición de papers se identifica por lo que lee
  (`entityPapersRequestKey`, en `utils/entityExplorer.js`): la pestaña ya no
  es dependencia, un re-render con la misma clave no toca la petición en
  vuelo, y solo el desmontaje cancela. Autores se piden la primera vez que se
  abre la pestaña (`authorsOpened`) y se conservan.
- Las tarjetas de autor usan `both` sin `opacity: 0`; la nota de impacto lleva
  `is-settled` al conocerse y asienta en 0,3 s.

## Medido

Chrome headless conducido por CDP (`scripts/diagnostics/explorer-loading-probe.mjs`)
contra el dev server, perfil limpio en cada corrida. La traza de pintado
sostiene la petición del perfil (`Fetch` en pausa) para que el esqueleto dure,
y compara el barrido nuevo con el antiguo restaurado por una hoja de estilos
inyectada en la misma página; 3 s de traza, 180 frames, 49 formas.

| En 3 s de esqueleto de autor | Barrido antiguo | Barrido nuevo |
|---|---|---|
| Eventos `Paint` | 9000 / 165 ms | **0** |
| `PaintImage` | 8818 | **0** |
| `RasterTask` | 900 / 18 ms | **0** |
| `GPUTask` | 227 / 250 ms | 68 / 4,6 ms |
| `UpdateLayoutTree` | 180 / 107 ms | 120 / 69 ms |
| Animaciones activas | 49 en el elemento (`shimmer`) | 49 en `::after` (`exSkelSweep`) |

Líneas de tiempo (MutationObserver instalado antes de que corra ningún script
de la página, tiempos desde el arranque del documento):

- **Autor** (A5006398227, con ORCID): esqueleto a 263 ms con cinco filas y la
  tarjeta ORCID; héroe vivo a 2322 ms **con la tarjeta ORCID reservada y la
  nota en «…»**; nota asentada a 2425 ms; tarjeta y panel de experiencia a
  3295 ms; 30 filas a 3464 ms. `explorer-empty` no aparece en ningún momento.
- **Institución** (I173304897): esqueleto a 337 ms con el bloque de Wikipedia
  cargando; héroe vivo a 8425 ms con el bloque todavía cargando y la nota en
  «…»; 28 filas a 8701 ms; párrafo a 9139 ms, en el mismo sitio.
- **Proyecto** (820394, ASTERIQS): esqueleto a 226 ms; héroe vivo a 739 ms con
  las cinco filas del esqueleto; 20 filas a 7631 ms. Un solo relevo.
- **Pestañas** (la institución): Autores muestra seis formas al instante y 30
  autores después; volver a Artículos pinta las 28 filas de golpe, sin
  esqueleto y sin petición nueva (las peticiones a `works` son las mismas dos
  antes y después del ida y vuelta — dos porque StrictMode dobla el efecto en
  desarrollo); volver a Autores, los 30 sin esqueleto.

No medido: el «antes» de las líneas de tiempo (se describe desde el código) y
un móvil real. La ganancia de pintado es la que se traslada a un dispositivo
lento; en escritorio el barrido antiguo ya cabía en el frame.

## Pruebas

`src/components/Explorer/explorerLoading.test.js` (fuente, como
`explorerEntrance.test.js`) fija cada decisión de arriba, y
`utils/entityExplorer.test.js` cubre la clave de petición: los detalles de un
proyecto no cambian la clave; página, orden, búsqueda, filtros, parámetros,
reintentos e identidad del autor sí.

## Segunda tanda (misma tarde): el pliegue de Wikipedia, los comentarios y dos tiempos

**El bloque de Wikipedia que se pliega.** En un tema (o institución) sin
extracto en Wikipedia, el bloque reservado se retira con la salida de
`AnimatePresence`: `height: 0`, opacidad y 6 px de subida. Medido con la sonda
(`wikiexit`, muestreando cada frame el borde superior del listado): la altura
llegaba a 0 pero el `border-box` se quedaba en sus 26 px de padding y borde, y
al desmontarse el elemento se iban de golpe esos 26 px más los 16 px del hueco
del flex — **42 px en un solo frame**, 400 ms después de que el pliegue
pareciera acabado. Es exactamente «la sección de papers sube un poco más de
golpe». El bloque va ahora dentro de un plegador sin caja propia
(`.ehc-wiki-fold`) cuya altura sí llega a cero y que anima además
`marginTop` hasta `-16px` (`HERO_STACK_GAP_PX`, el `--space-4` con que apila
`.explorer-hero-content`) para llevarse el hueco consigo. Después: el frame
del desmontaje mueve **0 px** en las tres corridas; el pliegue reparte sus
162 px en frames de 30 px como máximo con la curva expo. Observado y no
resuelto aquí: en una de tres corridas, la llegada de las 30 filas del tema
coincidió con el pliegue y bloqueó el hilo 315 ms; es coste del render de
las filas, no del pliegue, y estaba antes.

**Los comentarios, del esqueleto a «Nadie ha comentado todavía».** React
cambiaba uno por otro en un frame. Los dos van ahora en un
`AnimatePresence mode="popLayout"`: el esqueleto sale del flujo y se funde
(180 ms, 6 px hacia abajo) mientras el mensaje sube a su sitio (320 ms desde
10 px, curva expo). `initial={false}` para que un hilo servido de caché abra
directamente en su estado. Dos detalles que importan: el retraso de 320 ms
del esqueleto se mueve de `.comments-sheet-loading` a sus filas, porque una
animación CSS sobre la misma `opacity` pisaría el valor en línea de framer
durante toda la salida; y `.comments-sheet-body` pasa a `position: relative`,
que es el ancestro contra el que `popLayout` fija el elemento saliente.
Medido (`comments`, feed de invitado, primer hilo): en el frame en que llega
el veredicto el esqueleto ya está `absolute` y el mensaje montado a opacidad
0 y 10 px abajo; el esqueleto baja de 1 a 0 en 185 ms y el mensaje sube a 1
en 320 ms; en ningún frame el cuerpo está vacío.

**La paleta y el modal de guardar, más lentos.** A petición: la paleta entra
en 380 ms y sale en 220 (eran 260 y 140), y el modal de guardar entra en 360
y sale en 300 (eran 240 y 200), con `DIALOG_EXIT_MS` a juego. El velo de la
paleta era el compartido de `dialog.jsx` (150 ms), que ahora despejaría el
fondo antes de que la hoja se fuera: `CommandDialog` y `DialogContent`
aceptan `overlayClassName`, y `.sc-scrim` va en los dos relojes de la hoja.
Clase doblada porque la regla compartida es una variante `data-state` de
Tailwind con la misma especificidad. Pruebas: `paletteMotion.test.js`,
`saveModalMotion.test.js` (tiempos nuevos), `commentsSheetStates.test.js` y
el plegador en `explorerLoading.test.js`.
