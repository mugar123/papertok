# Plan 2026-09-03 — Following lento, y el feed que "recarga" al volver del perfil

## Diagnóstico (medido)

### A. Following tarda demasiado
Medido en Chromium headless (modo demo, fuentes reales, 14 seguimientos:
4 autores por id de OpenAlex, 3 por nombre, 3 temas por categoría arXiv,
1 tema por id, 2 instituciones por ROR, 1 proyecto OpenAIRE), caché fría:

- Pantalla «Buscando descubrimientos» desde los 251 ms; **primera tarjeta a
  los 6 459 ms**; las 41 tarjetas llegan de golpe.
- Ruta crítica: la cadena serializada de arXiv (`arxivService`: una petición
  cada ~350 ms de hueco + 250–600 ms de latencia). Following mete en ella
  1 petición por autor sin id de OpenAlex, **2 por tema de categoría** (`cat:`
  + búsqueda `all:"etiqueta"`) y 1 por proyecto (`id_list`), compitiendo con
  la del feed principal. Los `id_list` del proyecto salieron a los 6 315 ms
  aunque OpenAIRE respondió a los 2 460 ms.
- `FollowingUpdatesProvider.refresh` hace `setItems` una sola vez, al acabar
  `Promise.all` sobre todas las entidades: nada se pinta hasta la última.
- Los temas de categoría abren 5 proveedores (arXiv cat, dominio, búsqueda
  arXiv, búsqueda OpenAlex, PubMed) para 5 papers, sin plazo por entidad.

### B. Volver del perfil/ajustes no reanuda en la tarjeta
- El mecanismo de reanudar (`savedPaperIdByKey` + `resumeIndex`,
  `resumeOrderedPapers`) funciona en las 7 variantes probadas (botón, atrás
  del navegador, marca, scroll del documento, avatar, editor, espera de 12 s),
  para For You y para Following.
- Lo que lo rompe en producción es una **recarga completa de la pestaña**:
  `src/main.jsx` recarga en `vite:preloadError` (ba3fc12, 02-09) cuando un
  chunk perezoso ya no existe, y en papertok.app un chunk viejo responde 404
  (comprobado). El precache del SW solo lleva el conjunto de arranque (50
  entradas); las rutas perezosas se cachean solo al pedirlas. `FollowingFeedPage`
  se precarga en idle, así que Following ⇄ For You nunca pide un chunk;
  **Perfil y Ajustes no se precargan**: la primera visita tras cualquier
  despliegue (11 merges a main solo entre las 00:18 y la 01:22 de hoy) da 404
  → recarga → la memoria de módulo (posición, orden de Following, papers)
  desaparece → «For you» vuelve desde el snapshot, arriba del todo.

## Arreglo

### A. Following
1. `fetchFollowingUpdates(follows, { onProgress })`: entrega parcial tras cada
   entidad (papers fusionados hasta el momento + contadores). El provider
   aplica los parciales al estado; la página ya fusiona sin reordenar
   (`mergeOrderedPapers`) y la pantalla de descubrimiento acaba con la primera.
2. Orden de trabajo «rápidos primero»: entidades que resuelven por OpenAlex
   (autor con id, tema con id, institución) antes que las que pasan por la
   cadena de arXiv (autor por nombre, tema de categoría, proyecto).
3. Plazo por entidad (`settleWithin`) para que una fuente colgada no retenga
   el `lastUpdatedAt` ni la escritura de la caché.
4. En el inbox, los temas de categoría no lanzan las búsquedas genéricas por
   frase (arXiv `all:` y PubMed): duplican la consulta exacta `cat:` dentro
   de la cadena serializada y devuelven relevancia, no novedad.

### B. Resume tras recarga
5. `src/utils/feedResumeMemory.js`: la memoria de posición por superficie
   (paper id + índice) se escribe en `sessionStorage` al asentarse el scroll y
   se siembra desde ahí al cargar el módulo. Sobrevive a la recarga, no a la
   pestaña.
6. `FollowingFeedPage`: el orden con el que se salió se guarda como lista de
   claves en `sessionStorage`; `resumeOrderedPapers` lo reconstruye sobre los
   items restaurados de localStorage.
7. `App.jsx`: `PublicProfilePage` y `SettingsPage` entran en la precarga en
   idle (un toque desde la barra), para que un despliegue no obligue a recargar
   en el trayecto más común. La recarga sigue existiendo para lo demás; con 5
   y 6 deja de costar la posición.

## Verificación (hecha el 03-09)
- `node --test`: 10 tests nuevos (servicio: entregas en orden, carril rápido,
  plazo; followingFeed: orden por claves; feedResumeMemory; SOURCE de
  FeedContainer, FollowingUpdatesContext y App). Suite completa: 1890/1890.
  lint y build en verde.
- A/B en Chromium headless (worktree demo con `IS_DEMO = true`, 14
  seguimientos, caché del navegador ignorada, borde del Worker templado, el
  feed principal compitiendo en la cadena de arXiv como en producción):
  - Servicio viejo: pantalla de descubrimiento hasta la primera tarjeta a los
    **22,9 s** y **32,3 s** (dos corridas); las 41 llegan de golpe.
  - Servicio nuevo: primera tarjeta a los **1,3 s** (25 tarjetas) en las dos
    corridas; el resto se añade cuando la cadena de arXiv se libera (21,9 s
    en dev, donde cada petición atascada cuesta 4 s + 5 s del fallback del
    proxy; en producción son 4 s).
  - El plazo por entidad quedó en 45 s: a 20 s descartó un tema cuya petición
    respondió un segundo después de esperar la cadena.
- Posición tras recarga: en dev, `location.reload()` en `#/profile` →
  ajustes → «For you» vuelve a la tarjeta 3 (antes: arriba). En la build de
  producción (`vite preview`, SW puenteado con CDP), un 404 del chunk del
  perfil dispara la recarga forzada de main.jsx (marca
  `papertok_preload_reloaded_at`), y la vuelta aterriza en la misma tarjeta;
  sin bloqueo, `PublicProfilePage` y `SettingsPage` se piden en idle a los
  2,57 s junto a `FollowingFeedPage`.
- Trampas del arnés: el SW sirve los chunks desde su contexto y el dominio
  `Fetch` de la página no los ve (`Network.setBypassServiceWorker`); un 404 en
  la precarga en idle YA dispara la recarga (la app la captura aunque el
  `preload()` lleve `.catch`), así que para que el 404 caiga al navegar hay que
  omitir la precarga (`navigator.connection.saveData`).

## Fuera de alcance (anotado)
- La cadena serializada de arXiv es compartida con el feed principal, cuyas
  consultas de relevancia con `start=20..60` expiran (4 s) y bloquean a las de
  Following detrás. Una cola con prioridad, o no encolar consultas
  especulativas del feed por delante de las del inbox, es el siguiente paso.
- El snapshot del feed principal guarda 30 papers (15 min): una recarga
  cuando el lector iba por la tarjeta 35 aterriza en la última del snapshot.
