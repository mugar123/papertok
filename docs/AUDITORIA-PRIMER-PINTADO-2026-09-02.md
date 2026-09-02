# Auditoría de los cambios de primer pintado (2026-09-02)

Alcance: los dos commits del colaborador en `origin/main` que acortan el tiempo
hasta la primera tarjeta — `ade641a` («Cut first-card wait by painting before
enrichment») y `ef82a42` («Paint as soon as the first sources have enough
papers») — más una mirada a `ea55494` (cachés de cuenta y anclaje de hilos),
cuyos dos fallos ya están corregidos en el main local (`794eecb`, `8b68c5a`).

Solo examen: nada de esto se ha tocado. Cada hallazgo se contrastó con el
código antes de darlo por bueno, y los que resultaron falsos se listan al final.

## Hallazgos confirmados

### A1 — El feed con sesión descarta las fuentes lentas (ef82a42)

`settleSourcesForFirstPaint` devuelve `{ first, all }`. En `useGuestFeed` las
dos promesas se consumen: se pinta con `first` y las tarjetas de `all` se
anexan sin reordenar lo visible. En `FeedContext` solo se consume `first`;
`all` únicamente se espera si `first` no trajo ningún paper
(`src/context/FeedContext.jsx`, bloque `settleSourcesForFirstPaint`).

Consecuencia: en cuanto una fuente sola junta 15 papers deduplicados (arXiv
lo hace casi siempre), PubMed, OpenAlex y las fuentes de dominio de esa página
se piden y se tiran. Las peticiones siguen saliendo, así que no ahorra red:
pierde variedad. Y `filtered` recorta después los papers leídos o descartados,
así que un usuario con historial puede quedarse por debajo de la página con
papers de las otras fuentes ya desechados.

El mensaje del commit («later sources append instead of replacing the card»)
describe el feed de invitado, no el feed con sesión.

### A2 — Los papers de PubMed pierden todo el enriquecimiento (ade641a)

`PubmedAdapter` dejó de llamar a OpenAlex (abstract de reserva y conceptos) y
a Europe PMC (acceso abierto, PDF de PMC, citas, términos biomédicos). El
mensaje dice que «those sources still enrich the visible cards through the
shared feed/card paths after paint». No es así:

- `europePmcService` no tiene ningún llamador en `src/` fuera de un comentario.
- El enriquecimiento tardío del feed pasa por `getOpenAlexEnrichmentId`, que
  solo reconoce ids `W…` y de arXiv; un `pmid:…` devuelve `null`, así que los
  papers de PubMed no entran en ese lote.

Lo que sí sobrevive: Unpaywall por DOI desde la tarjeta (a los 900 ms), para
los papers de PubMed que traen DOI en el esummary.

### A3 — La muestra del perfil semántico no es la de los últimos «me gusta» (ade641a)

`selectSemanticProfilePositiveIds(liked, saved)` corta a 24 ids, pero `liked`
viene de `orderedSet('liked')`, que ordena por id (`curatedIds(...).sort()`).
Los 24 elegidos son los primeros alfabéticamente (`0801.…`, `arxiv:…`), no los
más recientes. El sesgo es silencioso: el ranking sigue funcionando, con un
perfil que no cambia aunque el usuario cambie de tema.

### A4 — Los temas seguidos ya no orientan la consulta principal (ade641a)

`rankedPreferences` dejó de incluir las categorías de los temas seguidos
(`getFollowedTopicCategoryIds`). Esos temas solo llegan ahora por
`fetchFollowedEntityCandidates`: 4 seguimientos al azar, 3 papers cada uno,
tope 6 por carga. Es un cambio de producto más que un bug, pero reduce mucho
el peso de «seguir un tema» para quien sigue varios.

### A5 — Menor: `loadItalicSerifFont` y `waitForInitialEnrichment` sin llamadores

Ninguna hoja de estilo usa Newsreader en itálica, así que quitarla del arranque
no rompe nada visible; el helper queda muerto. `waitForInitialEnrichment`
sigue exportado sin uso fuera de sus tests.

## Contrastados y descartados

- **Atajo de búsqueda con `SearchCommand` perezoso.** El atajo `/` vive en
  `Navbar`, no en el componente, así que montar la paleta solo mientras está
  abierta no lo rompe.
- **`mainSourceResults` con entradas `pending` en `shouldAbortFeedLoad`.** Solo
  se consulta cuando no hay ningún paper, y en ese caso ya se esperó a `all`.
- **Nunito fuera del arranque.** `--font-rounded` solo se usa en los CSS de
  perfil, y ambas pantallas llaman a `loadProfileFonts()`.
- **El reordenado tras el perfil semántico.** `reRankFeed` bloquea las tres
  primeras tarjetas y baraja la cola; es el comportamiento previo, no nuevo.

## Recomendación

A1 y A2 son regresiones reales y las dos se dejan arreglar sin deshacer la
mejora de latencia: consumir `all` en `FeedContext` con el mismo
`mergeKeepingShownOrder` del feed de invitado, y devolver a `PubmedAdapter` un
enriquecimiento diferido (después del pintado, no antes). A3 se resuelve
cortando la muestra sobre el orden de recencia del agregado, no sobre el set
ordenado por id.

## Corregido — 2026-09-02, rama `fix/primer-pintado`

Plan ejecutado: `docs/superpowers/plans/2026-09-02-primer-pintado-correccion.md`.
Ninguna corrección vuelve a poner una espera de red delante del primer pintado.

- **A1** — `75840bf`. Lo que devuelven las fuentes lentas se filtra contra lo ya
  pintado (`src/utils/feedLateCandidates.js`) y entra en el pool de candidatos
  de la página siguiente, consumido una sola vez. Nada de lo visible se mueve.
- **A2** — `c2cc4da`. `mergeEuropePmcEnrichment` fusiona los registros de Europe
  PMC en la página ya pintada, con la disciplina de identidad de iCite, desde el
  feed con sesión y desde el de invitado. No se restaura la consulta a OpenAlex
  por `pmid`: Europe PMC cubre abstract y términos, y era la mitad más cara.
- **A3** — `640393c`. La muestra semántica se toma de `curatedIds`, que viene del
  agregado con el más reciente primero, no de los `Set` ordenados por id.
- **A4** — `46fb805`. Los ids de categoría de los temas seguidos vuelven a
  `rankedPreferences`, con `resolveWithin` a 300 ms y reserva vacía, y el módulo
  de temas se precalienta en cuanto se conoce un seguimiento de tipo tema.
- **A5** — `22bed25`. Borrados `loadItalicSerifFont` y `waitForInitialEnrichment`.

### Verificación

`npm run check` en verde: 1791 tests (34 nuevos), lint limpio, build sin avisos,
dry-run del Worker correcto.

En vivo, sobre el árbol de la rama, como invitado: el feed pinta sin errores de
aplicación, y una llamada real a Europe PMC desde el origen de la app devuelve
para `pmid:33301246` acceso abierto, PDF de PMC, 12 438 citas, PMCID y términos
biomédicos — exactamente los campos que A2 daba por perdidos.

Sin verificar en vivo, porque necesitan sesión iniciada: A1 y A4, que viven en
`FeedContext` y no en el feed de invitado. Sus contratos quedan fijados por
tests de fuente, y el de A3 se comprobó por mutación (revertir el arreglo pone
el test en rojo).

### Nota sobre los tests de fuente

Se escribieron siguiendo `ce139ce`, que aterrizó mientras se redactaba el plan:
despojan los comentarios antes de buscar, acotan la captura y comprueban su
longitud, y atan las piezas en un único regex contiguo. Un comentario que cite
el arreglo no puede hacerlos pasar.
