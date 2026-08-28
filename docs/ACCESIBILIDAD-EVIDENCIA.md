# Evidencia de accesibilidad

Matriz viva exigida por `docs/ACCESIBILIDAD.md` («Evidencia y criterio de
finalización»). Cada entrega la amplía o la reprueba. Los resultados usan
`Cumple`, `No cumple`, `No aplicable` o `No verificado`, y los dos últimos van
siempre justificados.

Este documento no afirma conformidad AA de la web. Registra qué se comprobó,
cómo, y qué quedó fuera.

## Entrega: fases 1-2 (verificación ejecutada el 2026-08-28)

### Cómo se comprobó

- **Servidor**: Vite del propio worktree (`npm run dev`), con
  `VITE_PAPER_API_BASE_URL` apuntando al Worker de producción, de modo que el
  feed se recorrió con papers reales (arXiv, 2026) y no con textos de prueba.
- **Navegador**: Chrome conducido desde el panel del agente. Ventana de
  escritorio 1280×800 y preset móvil 375×812. Temas claro y oscuro.
- **Ruta usada**: `/` sin sesión, que renderiza `GuestFeedPage`. Es la única
  superficie alcanzable sin autenticarse, y monta **el mismo `PaperCard`** que
  el feed con sesión, así que cubre la mayor parte de lo que las fases 1-2
  tocaron.
- **Sin sesión**: el usuario se autentica él; nunca se le piden credenciales.
  `/lists`, `/research`, `/search`, `/following` y Ajustes quedan fuera.

### Artefactos del entorno que condicionan las lecturas

Se declaran porque cambian el significado de la evidencia, no como excusa.

1. **La pestaña corre oculta** (`document.hidden === true`). Las transiciones
   CSS quedan congeladas en t=0, de modo que `getComputedStyle(...).outline`
   devolvía el valor *inicial* (currentColor, 1.5px, offset 0) mientras la
   captura de pantalla mostraba el anillo correcto. Todas las lecturas de
   `outline` de esta matriz se tomaron tras inyectar
   `* { transition: none !important }`, y se contrastaron con capturas.
   `framer-motion` se congela igual: varias capturas muestran paneles a media
   animación. No es un defecto de la app.
2. **Los eventos de teclado sintéticos no activan `<button>`.** `Tab` y
   `Shift+Tab` mueven el foco, `Escape` llega a los manejadores de la app y
   `Enter` **sí** activa los `<a>` (el skip link navega). Pero sobre un
   `<button>` llegan `keydown` y `keyup` sin que el navegador genere el `click`
   de la acción por defecto — comprobado con escuchas propias, y con
   `defaultPrevented === false`, es decir, nada de la app se traga la tecla. La
   activación por teclado de los botones se verificó con `.click()` sobre el
   elemento **enfocado**, que recorre el mismo `onClick`. Queda declarado: la
   pulsación real de `Enter` sobre botones **no** está verificada.
3. **Con la pestaña oculta, `window.innerWidth`/`innerHeight` pueden leer `0`**,
   y con ellos cualquier `clientWidth`/`getBoundingClientRect()` de la página —
   `scrollIntoView` tampoco mueve nada mientras tanto. Se comprobó reproducible:
   al frontar la pestaña (`tabs_select`) y forzar las animaciones en curso a su
   estado final (`document.getAnimations().forEach(a => a.finish())`) los valores
   vuelven a ser reales. Las medidas de layout de esta entrega (truncamiento de
   `.pc-author-names`, posición del foco) se tomaron después de ese paso, nunca
   con la pestaña recién abierta.

### Matriz

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| Global | `variables.css` (tokens de foco y texto) | 1.4.3, 1.4.11 | Cumple | `src/styles/contrast.test.js` (20 aserciones, ambos temas) | — | `npm test` |
| Global, tema claro | `global.css` `:focus-visible` + anillos migrados | 2.4.7, 1.4.11 | Cumple | Recorrido `Tab` en `/`: 8 paradas seguidas (recargar, ES, tema, buscar, entrar, píldora de tema, autores ×3, «et al.», abstract, «Read article»), todas con `outline: rgb(180,83,9) 2px solid` = `--focus-ring` `#b45309`. Capturas | Solo verificado en `/`; las rutas con sesión no se recorrieron | Recorrido manual + `src/accessibilityStructure.test.js` |
| Global, tema oscuro | ídem | 2.4.7, 1.4.11 | Cumple | Con `data-theme="dark"`, los 7 controles medidos leen `rgb(255,157,0)` = `#ff9d00`; captura del anillo ámbar sobre fondo tinta | El tema se forzó por atributo, no con el conmutador de la cabecera | Recorrido manual |
| `/` (invitado) | `App.jsx` `.skip-link` — existencia y destino | 2.4.1 | Cumple **tras corrección** | Reverificado en vivo desde `#/login` (no desde `/`): clic real en el enlace enfocado deja el hash en `#/login`, el título en «Sign in \| PaperTok», el formulario de acceso sigue en el DOM y `document.activeElement.id === "main-content"` | **Bloqueador encontrado en la revisión completa de la rama y corregido en esta tarea**: la app monta `HashRouter`, así que activar el enlace reescribía el hash entero a `#main-content`; react-router lo leía como la ruta `/main-content`, no encontraba ninguna, y el catch-all (`<Route path="*">`) redirigía a `/`. La comprobación original de esta fila se hizo sobre `/`, donde el destino de esa redirección coincide con la ruta de partida — el experimento no podía distinguir un enlace sano de uno roto. Ver corrección 4 | Recorrido manual + `src/accessibilityStructure.test.js` |
| `/` (invitado) | `.skip-link` — visibilidad al recibir el foco | 2.4.7, 2.4.11 | Cumple **tras corrección** | Antes: el enlace enfocado estaba en `top: 8px` pero `elementFromPoint` sobre su centro devolvía `DIV.guest-wordmark` — pintado por encima y por tanto invisible. Después: devuelve `A.skip-link`, y la captura muestra el enlace | **Defecto encontrado y corregido en esta tarea**: `z-index: calc(var(--z-toast) + 1)` = 401 frente a `.guest-feed-header` con 900. Ahora `z-index: 1100` | Recorrido manual + captura |
| Feed | `PaperCard` — nombres de autor como enlaces | 2.1.1, 4.1.2 | Cumple **tras corrección** | Reverificado en vivo en `/`: `Tab` real (tecla, no `.click()`) alcanza cada nombre; `:focus-visible` coincide y el anillo interior (`outline: rgb(255,157,0) solid 2px`, `outline-offset: -1px`) se ve completo y sin recorte por `.pc-author-names` (captura a 390 px: «Fitsum Debebe Tilahun, Chung G. K…», con el anillo alrededor del segundo nombre truncado) | **Bloqueador encontrado en la revisión completa de la rama y corregido en esta tarea**: el `<button>` de la Tarea 6 es una caja `inline-block` atómica y `text-overflow: ellipsis` no puede cortar dentro de ella, así que Blink escondía la caja entera que no cabía en vez de truncarla — con un nombre largo desaparecía hasta el 40% de la fila sin ningún aviso visual. Se sustituyó por `<Link to>` de react-router, que ya era, de hecho, una navegación. Activación con `Enter` real no reprobada en esta pasada (artefacto 2); `Tab` y el anillo sí, con tecla real. Ver corrección 5 | Recorrido manual + `src/accessibilityStructure.test.js` |
| Feed | `PaperCard` — separador entre autores | 4.1.2 | Cumple **tras corrección** | `textContent` de los enlaces confirma el separador fuera de cada nombre: la fila concatena a `"Darby M. Kramer, Alexander van Engelen, Frank J. Qu et al."`. Eso prueba el DOM; no prueba lo que se pinta | **Esta fila daba por «Cumple» algo que `textContent` no puede ver**: el separador estaba bien puesto, pero la fila renderizada seguía rota por un defecto distinto y no detectado aquí — el mismo `<button>` inline-block escondía cajas de nombre enteras en vez de truncarlas (ver la fila de arriba, «nombres de autor como enlaces», y corrección 5). Se corrigió junto con esa fila al pasar a `<Link>`; `textContent` sigue siendo buena evidencia del separador, pero no sustituye una captura de lo renderizado | Recorrido manual + `src/accessibilityStructure.test.js` |
| Feed (escritorio) | `PaperCard` — «et al.» y modal de autores | 2.1.1, 2.4.3, 4.1.2 | Cumple | A 1280 px el botón es alcanzable con `Tab`; abre `role="dialog"` `aria-modal="true"` con `aria-labelledby`; el foco entra en el diálogo; `Escape` lo cierra; el foco vuelve al botón «et al.» (`activeElement === opener`) | El foco inicial lo programa `useDialogFocus` con `requestAnimationFrame`, congelado en pestaña oculta hasta forzar un fotograma. No es un defecto | Recorrido manual |
| Feed | `PaperCard` — conmutador del abstract | 4.1.2 | Cumple | `aria-expanded` pasa de `false` a `true`, el rótulo cambia a «Show less», `aria-controls` apunta a un `id` existente y el panel crece | Activación con `.click()` (artefacto 2) | Recorrido manual |
| Feed (móvil) | `PaperCard` — embudo táctil de autores | 2.1.1, 2.5.8 | Cumple | A 375×812: `.pc-author-btn` calcula `pointer-events: none` (el toque cae en la fila y abre el modal) y `.pc-authors-more` calcula `auto` | — | Recorrido manual |
| Feed | Objetivos de puntero de autores y «et al.» | 2.5.8 | No aplicable | Medidos 117×21 y 36×21 px | **Justificación**: se acogen a la excepción *Inline* de 2.5.8 — son objetivos dentro de una frase, con el tamaño limitado por el interlineado del texto que los rodea. En móvil, además, el toque se desvía a la fila entera | — |
| Global | `App.jsx` + `RouteAnnouncer` | 2.4.2, 2.4.3, 4.1.3 | Cumple | `/` → `/login` → atrás: el título pasa de «For you \| PaperTok» a «Sign in \| PaperTok» y vuelve; la región `role="status" aria-live="polite"` pasa a «Sign in» y luego a «For you»; el foco aterriza en `#main-content` en cada cambio y **no** en la carga inicial (`activeElement === BODY`) | Las rutas públicas se titulan por su cuenta (`usePublicPageMetadata`): al navegar a `/public/entity/author/...` el título no cambió, que es el comportamiento previsto | `src/utils/routeMetadata.test.js` + recorrido manual |
| `/` (invitado) | `GuestFeedPage` + `FeedContainer` | 1.3.1 | Cumple | En el DOM hay un solo `<main class="guest-feed-page">`; `FeedContainer` renderiza `div.feed-wrapper` porque no recibe `landmark` | — | `src/accessibilityStructure.test.js` |
| `/` (con sesión) | `FeedContainer` con `landmark` | 1.3.1, 2.4.1 | No verificado | Fijado por código y por test estático (`<main aria-label>` + `h1.visually-hidden`), nunca renderizado | **Justificación**: la ruta exige sesión de Firebase y el usuario se autentica él | `src/accessibilityStructure.test.js` + verificación con sesión |
| Feed (estados vacíos) | `FeedContainer` `.feed-empty` | 1.3.1, 2.4.1 | No cumple | Las tres ramas siguen siendo `div.feed-empty`: error (`:287`), descubrimiento inicial (`:300`, con `role="status"`) y vacío (`:328`, `:332`) | Hueco conocido y declarado (Ruling R7): durante un error de carga la ruta no tiene landmark ni `h1` | Fase 3 |
| `/following` | `FollowingFeedPage` | 1.3.1, 2.4.1 | No cumple | El fichero no contiene ni `<main>` ni `<h1>` | Aplazado a propósito (Ruling R10): heredar el `h1` «Para ti» del feed sería un encabezado falso. Necesita el suyo | Fase 3 |
| Navbar | `Navbar.jsx` | 1.3.1, 4.1.2 | No verificado | `<nav aria-label>` y `aria-current` en «Para ti» fijados por test estático | **Justificación**: la barra solo se monta con sesión. El recorrido `Tab` (marca → buscador → Para ti → Research → Siguiendo → preferencias → avatar) no se hizo | `src/accessibilityStructure.test.js` + verificación con sesión |
| Contenido de papers | `lang="en"` en 7 elementos | 3.1.2 | No cumple | Marcado verificado en `PaperCard`, `PaperReader`, `ListsPage`, `SearchPage` y `ResearchForme` | **Es una heurística de corpus, no un dato**: `src/models/Paper.js` y `PaperBuilder.js` no guardan idioma, así que los registros de revistas hispanohablantes quedan etiquetados como inglés. Mejora la inmensa mayoría del corpus y empeora una minoría; el arreglo correcto necesita un campo `language` en el modelo (Ruling R13) | Fase posterior, con `language` en el modelo |
| Listas | `ListsPage` — el título del paper y de la lista como botón | 2.1.1, 4.1.2 | No verificado | Razonado estáticamente y con una prueba aislada de navegador durante la Task 7; los caminos `.list-card-name-btn` y `.sr-cell-title-btn` nunca se renderizaron en la app | **Justificación**: `/lists` exige sesión | Verificación con sesión |
| Research | `ResearchForme` — titulares operables | 2.1.1 | No verificado | Ídem | **Justificación**: `/research` exige sesión | Verificación con sesión |
| Búsqueda | `SearchPage` — cuatro filas de entidad con Seguir separado | 4.1.2 | No verificado | Las cuatro conversiones (instituciones, proyectos, temas, autores) se comprobaron leyendo el código, fila a fila | **Justificación**: `/search` exige sesión. Además los resultados siguen sin anunciarse (C6) | Verificación con sesión; C6 en fase 3-4 |
| Ajustes | `EditInterestsModal` | 2.1.2, 2.4.3, 4.1.2 | No cumple | El fichero no contiene `role="dialog"`, `aria-modal`, `useDialogFocus` ni manejo de `Escape` | Defecto C7 conocido, fuera del alcance de las fases 1-2. El anillo de foco de las píldoras tampoco se pudo ver: el modal exige sesión | Fase 3 |
| Global | Supresiones del anillo de foco | 2.4.7 | Cumple | `src/accessibilityStructure.test.js` recorre todos los `.css` de `src/` y solo tolera dos `outline: none`, cada uno con su motivo escrito | El plan preveía **una** excepción (`.save-modal-tag-input:focus`); el inventario real tiene **dos**, porque `#main-content:focus` también la apaga. Es correcto — no es un control ni una parada de `Tab` — y queda en la lista con su razón, no oculto | `npm test` |
| Global | `--brand-orange` como color de anillo | 1.4.11 | Cumple | Ningún `.css` de `src/` usa `var(--brand-orange)` en un `outline`, y `button-variants.js` ya no lo usa en `focus-visible:outline-[...]` | `--brand-orange` sigue siendo marca: un `color:` en `ScientificReport.css` y un `hover:border` en el Button compartido | `npm test` |
| Paleta de búsqueda | `command.jsx` `CommandItem` — fila seleccionada | 1.4.11 | Cumple **tras corrección** | Montado el `CommandItem` real desde el dev server (React + cmdk, sin `CommandDialog`): cmdk pone `data-selected="true"` en la primera fila y esta calcula `outline: 2px solid rgb(255,157,0)` con `outline-offset: -2px` en tinta y `rgb(180,83,9)` en papel, mientras las filas no seleccionadas calculan `outline-style: none`. Contraste del anillo contra la hoja: **8,45:1** en tinta y **5,02:1** en papel (contra el propio tinte de la fila, 8,09:1 y 4,69:1). Captura | **Defecto encontrado y corregido en esta tarea**: el indicador era solo `data-[selected=true]:bg-secondary` — `rgb(26,29,36)` sobre `rgb(22,25,31)`, **1,04:1** en tinta y 1,07:1 en papel, un tercio del 3:1 que 1.4.11 pide. La medida se tomó fuera del diálogo y sin sesión, porque `App.jsx` solo monta `SearchCommand` con usuario | `src/accessibilityStructure.test.js` + verificación con sesión |
| Global | Experiencia con lector de pantalla | 1.3.1, 4.1.2, 4.1.3 y demás | **No verificado** | Ninguna | **No se ha ejecutado ningún lector de pantalla real** (ni VoiceOver ni NVDA). La experiencia con tecnología de apoyo NO está verificada, y ningún «Cumple» de esta matriz debe presentarse a terceros como conformidad hasta que se haga | Fase 6 |
| Global | Zoom 200 %, reflujo a 320 px, espaciado de texto | 1.4.4, 1.4.10, 1.4.12 | **No verificado** | Ninguna | No se probaron. El recorrido móvil se hizo a 375 px, que no es el ancho de reflujo que exige 1.4.10, y no se alteró ni el tamaño ni el espaciado del texto | Fase 6 |

### Correcciones hechas durante esta verificación

Las tres primeras las encontró el recorrido en vivo (la tercera salió de medir la
paleta de búsqueda al descartar un falso positivo vecino). Las dos últimas se le
escaparon a ese mismo recorrido — cada una por un motivo distinto, declarado en su
fila de la matriz (arriba, «existencia y destino» y «nombres de autor como
enlaces»/«separador entre autores») — y las encontró después una revisión completa
de la rama con verificación adversarial; la reverificación en vivo de esta tarea
confirma la corrección. Ninguna de las cinco la habría cazado un test automático de
los que había antes de esta tarea.

1. **El skip link estaba oculto bajo la cabecera** (`global.css`). Recibía el
   foco y se colocaba en su sitio, pero `.guest-feed-header` (opaca, `z-index:
   900`) lo tapaba entero: `elementFromPoint` sobre el centro del enlace
   enfocado devolvía `.guest-wordmark`. Es el fallo de 2.4.11 en su forma más
   literal, y dejaba 2.4.1 inservible para cualquiera que necesite ver adónde
   fue el foco. El `z-index` pasa de `calc(var(--z-toast) + 1)` (401) a `1100`,
   que despeja las cabeceras fijas de la app (900 en invitado y paper público,
   1000 en búsqueda) sin subir por encima de los diálogos.
2. **El espacio tras la coma entre autores se perdía** (`PaperCard.jsx`). Los
   `<button>` nuevos son `inline-block`, y el espacio final de `", "` dentro de
   una caja `inline-block` se recorta: la tarjeta leía «Kramer,Alexander van
   Engelen,Frank J. Quet al.». El separador pasa a ser texto hermano del botón,
   lo que de paso lo saca del nombre accesible de cada control.
3. **La fila seleccionada de la paleta se marcaba solo con un tinte**
   (`components/ui/command.jsx`). `data-[selected=true]:bg-secondary` dejaba la
   fila sobre la que están las flechas a 1,04:1 de las que no lo están: la única
   señal de dónde estás en la lista, a un tercio del 3:1 que 1.4.11 pide a la
   información visual que identifica el estado de un componente. Ahora la fila
   lleva además el anillo del resto de la app, `2px solid var(--focus-ring)` con
   `outline-offset: -2px` — interior porque las filas van pegadas dentro del 1px
   de relleno de `CommandList`, donde uno exterior pisa a sus vecinas y lo recorta
   el desbordamiento de la lista. El tinte se queda: ya no es el indicador, pero es
   lo que hace que la fila se lea como un objeto y no como un hueco perfilado.
   Con el anillo se fue el `outline-none` de la fila, que era inocuo mientras nada
   dibujaba un contorno (cmdk nunca da el foco del DOM a una fila) pero que en
   Tailwind v4 es `--tw-outline-style: none`, y `outline-2` pinta
   `outline-style: var(--tw-outline-style)`: juntos en el mismo elemento el anillo
   no llega a existir, con todas las clases puestas y leyéndose bien.
4. **El skip link expulsaba al usuario de la ruta en la que estaba** (`App.jsx`,
   `main.jsx`). La app monta `HashRouter`, así que la ruta ES el fragmento de la
   URL: seguir `href="#main-content"` reescribía el hash entero, react-router lo
   leía como la ruta `/main-content`, no encontraba ninguna, y el catch-all
   (`<Route path="*">`) redirigía a `/`. El recorrido original de esta entrega se
   hizo sobre `/` (fila «existencia y destino» de arriba), donde el destino de esa
   redirección coincide con la ruta de partida — el experimento no podía
   distinguir un enlace sano de uno roto, y por eso pasó como «Cumple» sin serlo.
   Corregido: `onClick` ahora intercepta el clic con `preventDefault()` y mueve el
   foco a mano con `document.getElementById('main-content')?.focus()`; el `href`
   se mantiene para lectores de pantalla. Reverificado en vivo desde `#/login`
   (clic real, no `.click()` sintético): tras activar el enlace, el hash sigue en
   `#/login`, el título sigue en «Sign in \| PaperTok», el formulario de acceso
   sigue en el DOM, y `document.activeElement.id === "main-content"`.
5. **La fila de autores escondía nombres enteros en vez de truncarlos**
   (`PaperCard.jsx`, `PaperCard.css`). El `<button>` de la Tarea 6 es una caja
   `inline-block` atómica: `text-overflow: ellipsis` no puede cortar dentro de una
   caja así, y Blink escondía entera la que no cabía en la fila en lugar de
   truncarla — con nombres largos desaparecía hasta el 40% de la fila sin ningún
   aviso visual, y ni la corrección 2 (`textContent`) ni la fila «separador entre
   autores» de la matriz lo detectaban, porque el texto seguía estando en el DOM,
   solo que sin pintarse. Se sustituyó el `<button>` por `<Link to>` de
   react-router — ya era, de hecho, una navegación, con `path` movido al render
   porque `<Link to>` necesita el destino de antemano — y un `<a>` no se
   «blockifica», así que la elipsis vuelve a funcionar; la clase se mantiene, así
   que el anillo interior y el embudo táctil móvil sobreviven. Cuando
   `getPublicEntityPath` no resuelve destino (solo en `publicMode`), se renderiza
   el nombre como texto inerte en vez de un enlace a ninguna parte. Reverificado
   en vivo en `/`: a 390 px la fila «Fitsum Debebe Tilahun, Chung G. Kang» se
   trunca en «Fitsum Debebe Tilahun, Chung G. K…» (captura), y `Tab` real llega al
   segundo nombre con `:focus-visible` cierto y `outline: rgb(255,157,0) solid
   2px` / `outline-offset: -1px` (anillo interior completo, sin recorte). **Nota
   de alcance**: esta reverificación se hizo con una sesión ya iniciada en el
   navegador compartido del panel (no creada por esta tarea — se evitó cerrarla
   para no interrumpir la verificación en curso de la corrección 3, en el mismo
   navegador), y no en `GuestFeedPage`. `.pc-author-names`/`.pc-author-btn` son el
   mismo `PaperCard` en ambas rutas, así que el hallazgo aplica igual a la ruta de
   invitado, pero esta pasada no se repitió allí.

### Red de regresión

- `src/styles/contrast.test.js` — contraste de los tokens (fase 1).
- `src/utils/routeMetadata.test.js` — títulos y etiquetas de ruta (fase 1).
- `src/accessibilityStructure.test.js` — **nuevo en esta tarea**: skip link y su
  destino, el manejador de clic que impide que `HashRouter` vea el fragmento del
  enlace, `#main-content` con `tabIndex={-1}`, `RouteAnnouncer` montado, `<nav>`
  con nombre, `aria-current` en «Para ti», landmark del feed opt-in (para que la
  ruta de invitado no acabe con dos `<main>` anidados), ninguna supresión nueva
  del anillo de foco en un `.css`, ningún anillo pintado en `--brand-orange`, el
  anillo de la fila seleccionada de la paleta — incluida la prohibición de
  devolverle el `outline-none` que lo anularía en silencio — y la posición del
  `:focus-visible` global fuera de toda capa de cascada.

Cada aserción se comprobó rompiendo a propósito lo que vigila, sobre una copia
del árbol: las once fallan cuando deben, con su mensaje.

## Lo que las fases 3-6 siguen debiendo

Esta matriz es un registro vivo. Lo que sigue abierto, para que la próxima
entrega lo amplíe en lugar de volver a descubrirlo:

- **Fase 3 — diálogos y anuncios de estado**: C7 (`EditInterestsModal` sin
  `role="dialog"`, sin foco gestionado y sin `Escape`), C8 (`AuthPrompt`), C6
  (resultados de búsqueda sin anunciar), A4, M3, M4, A6, C10, M8, M24, A5, y los
  landmarks que faltan: las tres ramas `.feed-empty` y `/following` con su
  propio `h1`.
- **Fase 4 — formularios y nombres**: A10 (botones con `title` y sin
  `aria-label`), A11, M21, M25, B2-B4 y los temporizadores M7.
- **Sin fase asignada, comprobado y descartado**: los dos `outline-none` de
  Tailwind de `src/components/ui/command.jsx` (líneas 77 y 120) se sospecharon
  como anillo perdido y no lo son. Medido en el navegador, con sesión iniciada
  y la paleta abierta (`/`): el campo, con su `outline-none` puesto, computa
  `outline: rgb(255, 157, 0) solid 2px` con `outline-offset: 2px` y cumple
  `:focus-visible`. Sobrevive porque `.outline-none` se genera dentro de
  `@layer utilities` y el `:focus-visible` global de `styles/global.css` está
  fuera de toda capa, y lo no capado gana a cualquier capa por encima de la
  especificidad. La línea 120 (`CommandItem`) además nunca recibe foco: cmdk
  da a las filas `role="option"` y `tabIndex -1`, deja `activeElement` en el
  campo y mueve `aria-activedescendant` con las flechas. Lo que sí era un
  defecto de la misma pantalla —el contraste de la fila seleccionada, 1,04:1 en
  tinta y 1,07:1 en papel— ya está corregido y medido: ver la corrección 3 y su
  fila de la matriz. Con ella desapareció el `outline-none` de la línea 120, así
  que el que queda en `command.jsx` es solo el del campo. Las dos pruebas del
  final de `src/accessibilityStructure.test.js` fijan la posición del
  `:focus-visible` y prohíben las dos formas que sí podrían ganarle
  (`!important` e inline `style`).
- **Fase 5 — lector y objetivos**: C2 (anotación por teclado y táctil), A7, M16,
  B15, y el `lang` del abstract y del lector según se muestre la vista original
  o la simplificada.
- **Fase 6 — verificación con tecnología de apoyo**: VoiceOver como mínimo,
  zoom al 200 %, reflujo a 320 px y espaciado de texto (1.4.12). **Solo después
  de esa fase puede afirmarse conformidad de ningún criterio ante terceros.**
- **Pendiente sin fase asignada**: el recorrido de teclado de `/lists`,
  `/research`, `/search`, `/following` y Ajustes, que exige una sesión iniciada
  por el usuario; y un campo `language` en el modelo de paper que sustituya la
  heurística de `lang="en"`.
