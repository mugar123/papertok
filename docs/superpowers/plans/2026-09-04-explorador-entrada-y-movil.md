# Abrir un autor desde una tarjeta, sin glitch; y el feed más fluido en móvil (2026-09-04)

Petición: «mejora las animaciones de entrada al pulsar en un autor (cómo se
carga la info y el cambio entre el feed y la página del autor; parece que hay
un pequeño glitch visual), haz lo mismo con proyectos, instituciones y temas, y
mejora la fluidez de la app en móvil». Las cuatro páginas son la misma pantalla
(`EntityExplorer`), así que lo que sigue vale para las cuatro; lo específico de
cada una se anota donde aparece.

## Cómo se midió

Chrome headless conducido por CDP (`scripts/diagnostics/explorer-loading-probe.mjs`,
modos nuevos `open` y `swipe`) contra el **build de producción** servido en
`localhost:5173` con la API real (`VITE_PAPER_API_BASE_URL=https://api.papertok.app`,
que admite ese origen), perfil limpio, 390×844 a 2×, táctil. `open` abre una
entidad desde el feed de invitado —por el enlace del nombre (`sel=…` para un
tema o un proyecto) o, con `viamodal`, por el camino del teléfono: tap en la
fila de autores, hoja, tap en un autor— y muestrea cada frame las dos páginas
bajo `#main-content` (opacidad, transform, dirección), el esqueleto, el héroe
vivo, la caja del héroe, la primera fila, la tira de pestañas, la hoja de
autores y los frames perdidos y tareas largas; al final vuelca los bloques del
héroe en el primer frame de esqueleto y en el primer frame vivo, y hace
`history.back()`. `slow` pone la CPU a un cuarto. `swipe` hace gestos de
deslizar en el feed y cuenta frames, tareas largas y lo que tarda en asentar.

Lo que el modo dev enseñaba y el build no: 126 ms entre el tap y el primer
frame de salida. En producción la salida arranca en el frame siguiente. Se
midió todo sobre el build por eso.

## Lo que hacía glitch al abrir un autor

1. **El héroe encogía 150 px de golpe al llegar el perfil.** El esqueleto de
   autor reserva la tarjeta ORCID (96 px), la tira de temas (25 px) y una
   segunda línea bajo el nombre; un autor sin ORCID y sin conceptos —todos los
   que se abren por nombre desde el feed de invitado, y muchos con id— llega
   con un héroe de 400 px donde el esqueleto medía 550. Medido: pestañas
   515 → 339 px, primera fila 627 → 480 px, en un solo frame, 300 ms después
   de que la página hubiera terminado de entrar. Con ORCID el salto era de
   40 px (552 → 512).
2. **La tira de pestañas del esqueleto medía 16 px y la real 40.** Otro salto
   de 24 px hacia arriba en el mismo frame, en las cuatro páginas.
3. **La transición de página escalaba la hoja** (`scale: 0.997`, 0.995 en
   proyectos). No se ve como movimiento —un píxel en 390— pero obliga a
   rasterizar el texto a esa fracción y otra vez, nítido, el frame en que la
   transformación se retira (`transform: none` unos 300 ms después de montar):
   un pequeño «pop» de nitidez sobre una página de 1.300 px con el esqueleto
   barriendo debajo.
4. **En el teléfono, la hoja de autores salía disparada con la página.** Bajo
   768 px los nombres no reciben el puntero: el tap abre la hoja y el autor se
   elige en ella. La hoja es `position: fixed` dentro de la tarjeta, y la
   tarjeta va dentro de `.feed-snap-item` con `content-visibility: auto`
   (contención de layout) y del contenedor de la transición, que recibe un
   `transform` el frame en que empieza a irse: un `fixed` dentro de un
   ancestro con transform o contención se fija a ese ancestro, no al viewport.
   Medido en el build antiguo: al elegir un autor la hoja bajaba de 505 a
   805 px en 220 ms con el muelle de su salida (~0,6 s, cortado a la mitad
   cuando la tarjeta desaparece) mientras la página se fundía, con un frame
   congelado de 145 ms justo después del tap.
5. **Volver al feed con la CPU a un cuarto** eran dos tareas de 222 y 211 ms:
   las tres tarjetas de la ventana reanudada montadas en el frame en que la
   página vuelve (un hueco en blanco entre la salida del autor y la llegada
   del feed) y el primer crecimiento de la ventana, tres tarjetas más, dentro
   de la propia entrada, que se quedaba congelada ese tiempo.

## Lo que cambia

- **`useHeightSettle`** (`src/hooks/useHeightSettle.js`): FLIP sobre una sola
  propiedad. Tras cada commit mide el elemento y, si la última altura medida
  era distinta, anima con Web Animations de aquella a esta (0,36 s, expo-out);
  no escribe nunca la altura natural, así que el contenido sigue maquetando
  solo. Mientras asienta recorta (`overflow: hidden`) y al terminar devuelve
  el `overflow` que tenía, para que el menú de enlaces de un proyecto siga
  colgando fuera en reposo. El ref viaja en el cuerpo del héroe
  (`.explorer-hero-content`) del esqueleto y en el vivo: la altura recordada
  es del hueco, no del nodo, y el relevo entre los dos asienta como el resto.
  El cuerpo y no el héroe entero: la tira de pestañas va dentro del héroe,
  detrás del cuerpo, y con la caja exterior animada saltaba a su sitio nuevo
  mientras la caja se cerraba encima (medido: pestañas 515 → 451 en un frame
  bajo un asentamiento de 200 ms). Un asentamiento aún en marcha se lee por
  donde va y se cancela, para que una ráfaga de llegadas (perfil, ORCID,
  Wikipedia, impacto) sea un solo movimiento. Con movimiento reducido solo
  recuerda.
- `.explorer-skeleton .ee-tabs { min-height: 40px }`: la tira del esqueleto
  mide lo que la real.
- `PageTransition`: opacidad y deslizamiento, sin `scale` ni `transformOrigin`.
- La hoja de autores va por `createPortal` a `document.body`, como ya iban la
  hoja de relacionados y el lector. Al elegir un autor no se cierra: pasa a su
  pose de salida con `animate` (24 px hacia abajo y a cero en 0,18 s sobre la
  curva de salida de la página, que se va en 0,2 s, sin recibir taps) y la
  desmonta la propia página al irse. Se probó primero como salida de
  `AnimatePresence` con `custom` para distinguir el motivo, y la medida
  enseñó que seguía corriendo el muelle de descartar; el motivo no llega a
  la salida con fiabilidad, y la pose no depende de eso. Descartarla por el
  velo o el botón sigue siendo el muelle de siempre.
- Ventana de montaje del feed (`utils/feedMountWindow.js`): al reanudar monta
  solo la tarjeta en la que estabas (`MOUNT_WINDOW_RESUME_RADIUS = 0`; un
  feed nuevo conserva su vecina, que abre bajo el velo y no tiene transición
  que proteger), crece de dos en dos y el primer crecimiento espera 400 ms
  desde el montaje (`MOUNT_WINDOW_SETTLE_MS`, los 0,3 s de la entrada y un
  respiro) antes de pedir el `requestIdleCallback`, cuyo `timeout` sube de
  120 a 600 ms.

- **La caché persistente de OpenAlex se lee y parsea una vez, no una vez por
  lectura** (`openAlexClient.readPersistentStore`). Cada `readPersistent`
  hacía `getItem` del blob entero de `localStorage` (200 entradas, entre
  ellas páginas de obras y respuestas de búsqueda) y `JSON.parse`, y el feed
  lo lee una vez por paper (`enrichment:<id>`) cada vez que monta. Con la CPU
  a un cuarto, el perfil de la vuelta al feed la señalaba como el mayor coste
  JavaScript: 92 ms en una corrida y 422 ms en otra, casi todo dentro de la
  entrada. Un primer intento memorizaba solo el parse y seguía pidiendo la
  cadena en cada lectura: quedaban 115 ms, que a ese tamaño es la copia
  fuera del almacenamiento. Ahora el store parseado se conserva y se suelta
  cuando otra pestaña escribe la clave (evento `storage`, que solo llega a
  las pestañas que no escribieron) o al pedirlo (`forgetPersistentStore`);
  las lecturas devuelven copias (`structuredClone`), como devolvía un parse
  fresco, para que quien edite lo que recibe no edite la caché.

- **Las escrituras de la caché se agrupan y el blob tiene tope.** Cada
  `writePersistent` serializaba y escribía el blob entero, y el lote de
  enriquecimiento escribe dos claves por obra: sesenta serializaciones de
  3,5 MB por página de obras del autor (27 ms cada una en el perfil, a CPU
  ×1). Ahora la escritura entra en la memoria al instante y llega al
  almacenamiento en la microtarea siguiente, una vez por ráfaga; el blob se
  recorta a 1,2 M de caracteres (fuera primero lo de menor prioridad y más
  antiguo, con los tamaños recordados por clave para no serializar para
  medir) y una entrada de más de 150 K no se persiste.
- **Las páginas de obras y de autores se persisten ya mapeadas**
  (`persistentSlim` en `openAlexClient.json`, claves `entity-works-v2` y
  `entity-authors-v2`): una página cruda de treinta obras pasaba del millón
  de caracteres (abstracts en índice invertido, autorías, localizaciones);
  los papers que el explorador hace con ella son la décima parte y son lo
  único que lee. Un acierto de caché devuelve la misma forma que la red.

- **La lista del explorador monta ocho filas por tanda y no maqueta lo que
  no se ve.** Con la caché arreglada, el perfil de la llegada de una página
  de obras (Singh, CPU ×4) era casi todo trabajo nativo: maquetar y pintar
  treinta filas —13.000 px—, más KaTeX y `areaKeyForCategory` por fila en
  cada render. Ahora `mountedPapers` es `filteredPapers.slice(0, rowBudget)`
  con `EXPLORER_ROW_CHUNK = 8` (dos pantallas) y el presupuesto crece en
  `requestIdleCallback`; el centinela de «cargar más» solo se monta cuando la
  página entera está dentro, para no pedir la siguiente desde debajo de la
  primera tanda; las filas llevan `content-visibility: auto` con
  `contain-intrinsic-size: auto 200px` (su altura habitual, para que la
  extensión del scroll sea la correcta antes de que la fila exista); y el
  color y la etiqueta de área se derivan una vez por lista (`rowAreas`).

Pruebas fuente: `pageTransition.test.js`, `explorerEntrance.test.js` (asiento
del héroe, hook, pestañas), `explorerLoading.test.js` (tandas, centinela,
`content-visibility`), `authorsSheetExit.test.js`,
`feedMountWindow.test.js`; de comportamiento, `openAlexClient.test.js`
(lectura única, copias, escritura ajena, ráfaga de escrituras en una
serialización, topes, `persistentSlim`) y `openAlexService.test.js`
(forma persistida de obras y autores) y `entityExplorer.test.js`
(presupuesto de filas).

## Medido

Build de producción, 390×844, feed de invitado, chunk del explorador ya
precargado (`late`). «Antes» es `origin/main` en `0bdcda7`; «después», este
cambio. Tiempos desde el tap.

**Abrir un autor por su enlace (CPU sin acelerar):**

| | Antes | Después |
|---|---|---|
| Salida del feed | 0 → 203 ms, sin huecos | 0 → 199 ms, sin huecos |
| Entrada del esqueleto | 221 → 536 ms; `transform: none` a 536 con re-raster por el `scale` | 220 → 533 ms, solo `translate` |
| Tira de pestañas del esqueleto | 16 px (la real, 40) | 40 px |
| Relevo esqueleto → perfil (autor sin ORCID) | héroe 552 → 400 px y pestañas 515 → 339 px **en un frame** | cuerpo del héroe 576 → 400 px en **0,28 s**, pestañas 515 → 339 siguiéndolo frame a frame (1346 → 1629 ms) |
| Relevo (autor con ORCID) | 552 → 512 px en un frame | 576 → 512 px en 0,3 s |
| Frames >34 ms / tareas largas | 0 / 0 (una corrida con hueco de 194 ms a mitad de entrada, no reproducido) | 0 / 0 |

**Por la hoja de autores (el camino del teléfono):**

| | Antes | Después |
|---|---|---|
| Caja del velo durante la salida | 52+792 px (fijado a la tarjeta) | 0+844 px (viewport) |
| La hoja al elegir un autor | baja 505 → 805 px en 220 ms con el muelle de descartar, cortado al desmontarse la tarjeta | baja 24 px y se funde a cero en 180 ms, en fase con la página |
| Frame congelado tras el tap | 145 ms | ninguno |

**Con la CPU a un cuarto (`slow`):**

| | Antes | Después |
|---|---|---|
| Abrir el autor: huecos / tareas largas | 147 ms a 1201 ms / 59 ms | 60 ms / 55 ms (la llegada del perfil) |
| Volver al feed: tareas largas | 222 ms (montaje) + 211 ms (crecimiento, dentro de la entrada) | ninguna en una corrida; 217 + 209 ms en otra — el perfil CPU (`profile`, build sin minificar) las atribuye a `readPersistent`, 92 y 422 ms; con el parse memorizado, ver la fila siguiente |
| Volver al feed, con la caché leída una vez | — | **0 frames >34 ms, 0 tareas largas** en dos corridas (el feed monta a 229 ms y llega a opacidad 1 a 446); `openAlexService` pasa de 116–426 ms de tiempo propio en el perfil a 2 ms |
| Feed: 4 deslizamientos de tarjeta | — | 0 frames >34 ms, 0 tareas largas, asentado a ~480 ms del gesto |

Sitio desplegado (`https://papertok.app`, misma sonda): una sola navegación
al arrancar, sin clave de recarga y con service worker en control. La
recarga que la sonda veía en local venía de un `workbox-window` sin resolver
tras un `pnpm install` accidental; con `npm ci` de verdad desaparece.

**La página del autor después de la entrada, con la CPU a un cuarto:**

| | Antes de tocar la caché | Después |
|---|---|---|
| Blob de la caché tras una página de autor | 3.502.021 caracteres | 156.724 |
| Tareas largas con la caché arreglada y la lista de golpe | 142, 63, 117, 56 ms (frames de hasta 148) | — |
| Tareas largas con la lista por tandas de ocho (`wait=7000`, dos corridas) | — | 63, 60, 65 ms y 51, 79, 53, 53 ms (frames de hasta 88) |
| Filas montadas | 30 en un commit | 8 → 16 → 24 → 30 en idle, ~70–90 ms entre tandas |

La página del autor queda sin ninguna tarea por encima de 80 ms con la CPU
a un cuarto, y el muestreador de la sonda es parte de esas (lee estilos y
cajas en cada frame).

## Lo que queda

- La sonda corre en Chrome headless con raster por software: mide frames,
  tareas y geometría con fidelidad; el coste de GPU real de la transición
  queda por ver en un teléfono.
- Las entradas viejas `entity-works:`/`entity-authors:` (respuestas crudas)
  no se borran: caen solas por el tope de tamaño y de antigüedad.
- Ya antes de este cambio, la segunda página de obras se pide a veces nada
  más entrar la primera (páginas de 13.400 px en la sonda con 55 filas): el
  centinela de «cargar más» corta con el viewport cuando no debería. No es
  un tirón, pero es una página que nadie ha pedido; queda por mirar.

