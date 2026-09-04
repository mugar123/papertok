# Auditoría de rendimiento móvil — 2026-08-28

Motivo: la app se siente pesada en móvil; el ejemplo concreto del usuario es la
animación de cambio claro/oscuro. Esta auditoría midió en vivo lo medible
(dev server, viewport 375×812, sesión real), leyó el código completo de CSS y
runtime con dos barridos independientes, y construyó el bundle de producción
para tener números actuales. El plan de implementación asociado es
`docs/superpowers/plans/2026-08-28-optimizacion-movil.md`.

## Números de partida (medidos hoy)

- **Bundle de arranque**: `index-*.js` 729,7 KB crudos / 235,4 KB gzip;
  `firebase-*.js` 341,9 KB / 103,9 KB; CSS de entrada 197,5 KB / **35 KB gzip**
  (el 22-08 eran 13,4 KB — casi el triple en seis días; la 0.2 metió el modo
  oscuro, las anotaciones y el rediseño social en el grafo eager).
- **DOM del feed**: ~4.100 nodos con 16 tarjetas montadas.
- **Cambio de tema**: el commit (atributo + estado) cuesta **0,3 ms** y el
  recálculo de estilos por volteo de `data-theme` **1–3 ms** en desktop
  (extrapolado ~5–20 ms en un móvil medio). **React y el CSS de tokens NO son
  el problema**: solo `ThemeToggle` consume el contexto y el valor está
  memoizado.
- **Fuentes**: la hoja de Google Fonts es render-blocking confirmado
  (`renderBlockingStatus: "blocking"`); 69 font faces declaradas, ~10 usadas
  en el primer render.
- **En reposo**: 15 tarjetas ejecutan `cardSlideUp` a la vez al montar
  (14 invisibles), más un `scrollNudge` infinito.
- Con el documento oculto la view transition **aborta**
  (`InvalidStateError`), así que el timing del barrido no es medible desde el
  pane; el diagnóstico de abajo sale del mecanismo, no de un frame rate.

## F1 — El cambio de tema (la queja concreta)

Mecanismo (`src/utils/themeTransition.js`, `src/styles/global.css:262-340`):
View Transitions API con un círculo de `clip-path` que crece desde el botón —
420 ms al entrar en oscuro, 320 ms al volver.

Dónde está el peso en móvil, por orden:

1. **La captura.** `startViewTransition` congela el render, pinta la página
   entera dos veces (instantánea del tema viejo + primer frame del nuevo) y
   sube dos texturas de pantalla completa. A DPR 3 (375×812) son ~22 MB de
   texturas. En un móvil medio eso es un frame largo — decenas a >100 ms de
   congelación **antes** de que nada se mueva.
2. **420 ms animando `clip-path` a pantalla completa.** En WebKit la animación
   de `clip-path` no está garantizada en el compositor: cada frame puede
   repintar. Y el easing `cubic-bezier(0.16,1,0.3,1)` tiene una cola larga:
   el borde del círculo se demora, y sumado a la congelación previa la
   percepción pasa del medio segundo.
3. **El fallback sin View Transitions es el peor caso posible**:
   `html.theme-crossfade *` (`global.css:321-330`) pone una transición con
   `!important` en **todos** los elementos, dos recálculos completos de
   estilo (poner y quitar la clase) y 240 ms de interpolación de color por
   elemento pintada en main thread. Justo los navegadores viejos —los
   dispositivos lentos— son los que caen aquí.

`prefers-reduced-motion` está bien resuelto (cambio instantáneo).

## F2 — Arranque (el coste dominante de la primera visita móvil)

- **~355 KB gzip de JS antes de pintar el feed** (entrada + Firebase +
  jsx-runtime). En CPU móvil el parse/exec de 729 KB crudos es el techo.
- **`PaperCard.jsx:25` importa estáticamente `PaperReader`** (el lector
  completo con `Annotations`): su JS y ~41 KB crudos de CSS viajan en el
  arranque aunque el lector solo se abre al pulsar «leer».
- **framer-motion (~122 KB crudos) en la entrada** por `PageTransition`; y
  `AnimatePresence mode="wait"` hace las transiciones de ruta estrictamente
  secuenciales: **0,5 s muertos por navegación** (0,2 salida + 0,3 entrada).
- **Google Fonts render-blocking** con Newsreader variable a ejes completos.
- **Sin service worker** pese a manifest completo: la revisita móvil pasada
  la `max-age=600` re-descarga ~350 KB gzip (GH Pages además sirve gzip, no
  Brotli). PWA instalable sin offline.
- `App.jsx:97-99` pre-carga 5 chunks a los 2,5 s sin mirar `saveData` ni el
  tipo de conexión.
- Firestore (~190 KB crudos) sigue en el arranque del visitante (pendiente
  conocido desde el 22-08).

## F3 — Runtime del feed

- **El re-ranking es O(N²) y corre en cada snap con dwell ≥3 s**
  (`recommendationEngine.js:383-387`): el bucle re-puntúa el pool entero en
  cada iteración (~1.600 llamadas con 60 papers), cada llamada hace
  normalización Unicode NFD + 3 regex por entidad seguida × señal, y
  construye una explicación (`topReasons`, `:63-68`) que solo lee un panel de
  debug. Es el origen de los 58–151 ms por snap medidos en producción, y
  empeora cuadráticamente al profundizar.
- **Sin ventana de montaje**: `FeedContainer.jsx:347` monta todos los papers
  cargados (15/página, sin tope; el centinela dispara a **5 viewports**,
  `rootMargin: '0px 0px 500% 0px'`). `content-visibility: auto` salva pintura,
  no JS: cada tarjeta mantiene IntersectionObserver, ResizeObserver y ~7
  efectos.
- **`FeedContext.jsx:1980` y `AuthContext.jsx:300` no memoizan su `value`**
  (25 y 20 claves): cada re-rank, enriquecimiento tardío o like re-renderiza
  a todos los consumidores. Son justo los dos providers que más cambian; el
  resto lo hace bien.
- **`mergeOpenAlexEnrichment` devuelve objetos nuevos** para todos los papers:
  el enriquecimiento tardío re-renderiza todas las tarjetas y recrea sus
  observers (`PaperCard.jsx:370` depende de `paper`).
- **`PaperCard.jsx:909` lee `localStorage` en el cuerpo del render** de cada
  tarjeta; `ScientificText.js:9-11` re-parsea LaTeX del abstract sin memo,
  dos veces por tarjeta.
- **Animaciones de layout**: `gridTemplateRows: '0fr'→'1fr'` con framer
  (`PaperCard.jsx:1126, 1279`) fuerza un layout completo del subárbol ~37
  veces por animación de 620 ms, dos veces por tarjeta al asentarse.
- **Figuras sin acotar** (`PaperCard.jsx:945-955`): sin `loading="lazy"`, sin
  dimensiones ni `aspect-ratio` (CLS), y la figura original del publisher se
  decodifica entera para una caja de ~120 px.
- Menores: intervalo de `SearchPage.jsx:611` que se rearma en cada tick y
  sigue en background; `resize` sin throttle con lecturas de layout en
  `EntityExplorer.jsx:318`; `writeFeedSnapshot` serializa 30 papers también
  en cada merge de enriquecimiento; `markSeen` hace JSON parse+stringify por
  ítem.

Lo que ya está bien y hay que proteger: cero listeners de scroll/touch (snap
CSS puro), enriquecimiento gateado por `isCardSettled`,
`content-visibility: auto` en los items, batching de skips a 220 ms.

## F4 — CSS móvil

- **`global.css:149`**: `button { transition: all 200ms }` para todos los
  botones de la app (la sensación «botón blando», ya diagnosticada el 22-08).
- **Safe areas**: `viewport-fit=cover` + standalone están declarados, pero
  `.navbar` no tiene `env(safe-area-inset-top)` (la barra queda bajo el
  notch en PWA y el feed hereda el desplazamiento), y el banner de consentimiento,
  el FollowSheet y el rail de anotaciones no tienen el inset inferior.
- **`.analytics-consent`** (`AnalyticsConsentBanner.css`): fijo permanente
  sobre el feed con `blur(18px)` + sombra de 54 px — la peor combinación de
  la app — y sin prefijo `-webkit-` (6 de 17 sitios con `backdrop-filter` no
  lo llevan → sin blur en iOS <18 pagando la capa igualmente).
- **Cinco backdrops animados con blur** (fade de opacidad sobre
  `backdrop-filter`): `PaperCard.css:1104`, `CommentsSheet.css:28`,
  `EditInterestsModal.css:8`, `PDFViewer.css:7`, `CreateListDialog.css:20` —
  el patrón que peor digiere una GPU móvil; más `--shadow-xl` (48 px) en las
  hojas con spring.
- **`vh` residual donde debe ser `dvh`**: el abstract de la tarjeta
  (`PaperCard.css:653` `46vh`, `:2313` `34vh`) dentro de una tarjeta en
  `100dvh` — se desincroniza al esconderse la URL bar; `EntityExplorer.css`
  entero (0 `dvh` en 2.206 líneas); hojas móviles en `:2170` y `:2395`;
  `EditInterestsModal.css:6`; `Annotations.css:473`.
- **`will-change` permanente ×4 por tarjeta** (`PaperCard.css:486, 503, 744,
  759`) en una lista sin tope.
- **Shimmer del skeleton por `background-position`** (pintado por frame, 7
  selectores) y animación infinita de `filter: drop-shadow`
  (`ProtectedRoute.jsx:57-62`) en la pantalla de carga de auth.
- **EntityExplorer**: el único `backdrop-filter` sticky de la app re-muestreado
  en cada frame de scroll (`:698`), un héroe con `filter: blur(48px)` sobre
  imagen cover (`:65`), y un drawer de filtros de 320 px sin breakpoint móvil
  (`:1234`).
- **Hovers sin guarda** en hojas táctiles: `FollowSheet.css` (6 reglas, 0
  guardas), `MyCommentsPage.css`.
- `scroll-behavior: smooth` global sin override de reduced-motion (el feed no
  lo hereda — no hay conflicto con el snap, contra el diagnóstico del 22-08).
- Muertos: `@keyframes float` y `gradientShift` sin consumidores.

## Priorización

| Prioridad | Qué | Por qué |
|---|---|---|
| P0 | Tema (F1) | La queja concreta; arreglo barato y acotado |
| P1 | CSS quick wins (F4) | Una tarde de cambios de líneas sueltas, mejora transversal |
| P2 | Runtime del feed (F3) | Los 58–151 ms por snap y los re-renders anchos son la aspereza al usar |
| P3 | Arranque (F2) | El coste dominante de la primera visita; cirugías más largas |
| P4 | Service worker | La revisita móvil pasa de ~350 KB a ~0 |
