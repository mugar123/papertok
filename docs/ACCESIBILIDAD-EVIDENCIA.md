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

## Entrega: fase 3 (verificación ejecutada el 2026-09-04)

Fase 3 cerró seis diálogos caseros o sin gestión de foco (todos migrados al
hook compartido `useDialogFocus`), los anuncios de estado que faltaban en
búsqueda y comentarios, un barrido de regiones vivas que nacían vacías con
solo un `aria-label`, y cuatro campos sin nombre accesible propio o con su
error sin asociar. El detalle de cada arreglo está en
`.superpowers/sdd/fase-3/lote-1-report.md`, `lote-2-report.md` y
`lote-3-report.md`; esta entrada registra qué de eso se pudo comprobar
funcionando en un navegador real, y por qué el resto no se pudo alcanzar.

### Cómo se comprobó

- **Servidor**: `npm run dev` de este worktree, `VITE_PAPER_API_BASE_URL`
  apuntando al mismo Worker de producción que usaron las fases 1-2, así que
  el feed de invitado y las páginas públicas muestran papers y perfiles
  reales.
- **Sin sesión, otra vez**: el usuario se autentica él; nunca se le pidieron
  credenciales. A diferencia de las fases 1-2 — que solo tenían `/` para
  cubrir casi todo lo suyo — la fase 3 toca sobre todo superficies que
  **exigen sesión por diseño** (Ajustes, Búsqueda, el lector con IA, Listas,
  Research): de los defectos que tocó esta fase, solo tres viven en una
  ruta pública: el cajón de filtros avanzados y el esqueleto de carga del
  Explorer (`/public/entity/:type/:id`, con `publicMode` cuando no hay
  usuario), y la hoja de seguidores de un perfil público
  (`/public/user/:handle`). Se comprobaron los tres. El resto — los otros
  cuatro diálogos y campos, y todas las regiones vivas salvo la de
  `PublicPaperPage` y la de `CommentsSheet` — se registra como no
  verificado, con la ruta protegida exacta que lo bloquea.
- **La frontera de sesión se comprobó, no se asumió**: navegar a `#/search`
  sin sesión redirige de verdad a `#/login` (mismo componente
  `<ProtectedRoute>` que envuelve `/settings`, `/settings/profile`,
  `/settings/following`, `/research`, `/lists`, `/following`, `/profile`,
  `/admin/moderation` y `/onboarding` — una sola comprobación en vivo basta
  para las diez). El botón "Read in plain words" de una tarjeta, el icono
  "Search" de la cabecera de invitado y el icono "Save" de una tarjeta
  abren los tres `AuthPrompt` en vez de `PaperReader`, `SearchCommand` o
  `SaveToListModal` — confirmado con capturas, no solo leído en el código.
- **Un hallazgo que corrige la propia expectativa del encargo**: las dos
  regiones vivas que el lote 2 arregló en `PublicProfilePage`
  (`loadingRows`, `loadingRowList`) viven en la pestaña
  "Lists/Saved/Liked" del perfil, que solo se monta cuando
  `view.isOwner` es cierto — es decir, exigen sesión igual que si vivieran
  en `/settings`, aunque la página en sí (`/public/user/:handle`) sea
  pública. Un visitante anónimo en el perfil de `@nick_mugar` ve una
  sección "Lists" sin pestañas, sin esas dos regiones. Se creyeron
  alcanzables al planificar esta verificación y no lo son.
- Detalle completo, con las lecturas exactas de `document.activeElement`,
  `role`, `aria-*` y los recorridos de `Tab`/`Escape`, en
  `.superpowers/sdd/fase-3/verificacion-report.md`.

### Matriz

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| Explorer público (`/public/entity/institution/...`) | Cajón de filtros avanzados | 2.1.2, 2.4.3, 4.1.2 | Cumple | `role="dialog"` `aria-modal="true"` `aria-labelledby` → "Advanced filters"; foco inicial en "Close filters" (`data-dialog-initial-focus`); `Shift+Tab` desde el primero salta a "Apply filters" (el último) y `Tab` vuelve a cerrar el ciclo; `Escape` desmonta el diálogo y el foco vuelve al botón "Open filters" que lo abrió | — | `verificacion-report.md` §1 |
| Perfil público (`/public/user/:handle`) | Hoja de seguidores (`FollowSheet`) | 2.1.2, 2.4.3, 4.1.2 | Cumple | Mismo patrón: foco inicial en "Close", `Tab` desde "Close" llega al enlace del último seguidor y vuelve a envolver a la primera pestaña, `Escape` devuelve el foco al botón "See followers" | — | `verificacion-report.md` §2 |
| Explorer público | Esqueleto de carga — botón "Volver" | 4.1.2, 1.3.1 | Cumple | `aria-label="Back"` sin ancestro `aria-hidden="true"` (`backBtnInsideAriaHiddenAncestor: false`), `.explorer-hero` sin `aria-hidden` propio; captura con el nombre de la entidad ya pintado junto a los bloques de esqueleto | — | `verificacion-report.md` §3 |
| Explorer público | Esqueleto de carga — contenedor (`.explorer-container.explorer-skeleton`) | 4.1.3 | No cumple | `{"role":"status","ariaBusy":"true","ariaLabel":"Loading","hasVisuallyHiddenTextInside":false}`, comprobado en vivo el 2026-09-04 sobre una segunda entidad | **No es un defecto nuevo**: `lote-2-report.md` (sección 3) ya lo dejó fuera a propósito por vivir en un fichero que otra sesión tenía reservado. Sigue exactamente así nueve días después | Cuando alguien retome `EntityExplorer.jsx` para otra cosa |
| Página de paper público (`/public/paper/:paperKey`) | Esqueleto de carga | 4.1.3 | Cumple | `.public-paper-skeleton` con `role="status"` y `<span class="visually-hidden">Loading paper...</span>` real desde el instante en que se monta | Patrón *mount-with-content*: el nodo nace con su texto puesto en vez de nacer vacío y rellenarse — más débil que el patrón persistente-y-vacío, pendiente de confirmación con lector de pantalla real | Lector de pantalla real (fase 6) |
| Feed de invitado / paper público | `CommentsSheet` — región de aviso (`comments-sheet-notice`) | 4.1.3 | Cumple | Presente para cualquier visitante, `role="status"` `aria-live="polite"` `textContent === ''`, sin la clase `has-text` | Solo se verificó la mitad "nace vacía"; el relleno real al publicar/editar/borrar/reportar exige `isAuthenticated` y no se pudo provocar | Verificación con sesión |
| Feed de invitado | `CommentsSheet` — nombre del campo del composer | 3.3.2 | No verificado | — | El `<textarea>` no se monta sin sesión: `composerState === 'signed-out'` lo sustituye por "Sign in to join the conversation." (confirmado: `hasComposerTextarea:false`, `hasSignInGate:true`) | Verificación con sesión |
| Feed de invitado | `CommentsSheet` — anuncios de publicar/editar/borrar | 4.1.3 | No verificado | — | Misma razón que la fila anterior: exigen estar autenticado | Verificación con sesión |
| Búsqueda | Anuncio de resultados y nombre del campo principal | 3.3.2, 4.1.3 | No verificado | Razonado por lectura de código en `lote-2-report.md` y `lote-3-report.md`; la redirección de `/search` a `/login` sin sesión sí se confirmó en vivo | **Justificación**: `/search` exige sesión | Verificación con sesión |
| Búsqueda | Indicador "aún buscando" (`search-input-loader`) | 4.1.3 | No verificado | Declarado en `lote-2-report.md` ("Ronda de arreglos 1"): se monta bajo demanda con el texto ya dentro | **Patrón mount-with-content, aceptado como convención del repo desde la revisión del lote 1** — no reverificado en vivo por la misma razón que la fila anterior | Verificación con sesión + lector de pantalla real |
| Ajustes | `EditInterestsModal` (diálogo) | 2.1.2, 2.4.3, 4.1.2 | No verificado | Razonado por lectura de código en `lote-1-report.md` | **Justificación**: `/settings` exige sesión | Verificación con sesión |
| Siguiendo / Ajustes | `EmailNotificationModal` (diálogo) | 2.1.2, 2.4.3, 4.1.2 | No verificado | Ídem | **Justificación**: `/settings/following` exige sesión | Verificación con sesión |
| Perfil | `VisibilityPrompt` (diálogo) | 2.1.2, 2.4.3, 4.1.2 | No verificado | Ídem | **Justificación**: solo se monta si `view.isOwner`, que exige sesión — incluso desde una página por lo demás pública | Verificación con sesión |
| Lector | `ReaderBar` — indicador de reescritura (`rd-bar-streaming`) | 4.1.3 | No verificado | — | **Justificación, confirmada en vivo**: "Read in plain words" abre `AuthPrompt` en vez de `PaperReader` cuando no hay sesión | Verificación con sesión |
| Lector | `SelectionMenu` — nombre del campo de nota | 3.3.2 | No verificado | — | **Justificación**: misma que la fila anterior — sin `PaperReader` no hay anotación | Verificación con sesión |
| Research | `ScientificReport` — esqueleto de tendencias | 4.1.3 | No verificado | — | **Justificación**: `/research` exige sesión | Verificación con sesión |
| Global | `SearchCommand` — esqueleto de la paleta | 4.1.3 | No verificado | — | **Justificación, confirmada en vivo**: el icono de búsqueda de invitado abre `AuthPrompt`; la paleta solo se monta con `user` (`App.jsx`) | Verificación con sesión |
| Perfil público | `PublicProfilePage` — `loadingRows` / `loadingRowList` | 4.1.3 | No verificado | Página visitada en vivo sin sesión; sin pestañas "Lists/Saved/Liked" visibles | **Justificación**: ambas regiones viven dentro de la interfaz de propietario (`view.isOwner`), invisible para un visitante aunque la ruta sea pública — ver nota más arriba | Verificación con sesión |
| Listas | `CreateListDialog` — error asociado al campo del nombre | 3.3.1 | No verificado | — | **Justificación, confirmada en vivo**: "Save" en una tarjeta de invitado abre `AuthPrompt`; `/lists` exige sesión | Verificación con sesión |
| Ajustes | `ProfilePage` — `aria-live` del hint/error del handle | 3.3.1 | No verificado | — | **Justificación**: `/settings/profile` exige sesión | Verificación con sesión |
| Navegación | `RouteFallback` — deja de anunciarse como región viva | 4.1.3 | No verificado (comportamiento) | Lectura directa: `<div className="route-fallback" aria-hidden="true" />`, sin `role`, sin contenido condicional | **No se pudo capturar en el DOM en ningún intento**: en desarrollo local los módulos se sirven desde disco y la ventana de `Suspense` es sistemáticamente más corta que un fotograma. Una lectura de código, por sencilla que sea, no es una observación de comportamiento | Recorrido con red real limitada (3G lento) o en producción |
| Global | Nombre accesible calculado por el navegador (control de método) | 4.1.2 | Cumple | El árbol de accesibilidad real de Chrome (`read_page`) informa el buscador de `EntityExplorer` como `textbox "Search publications in this entity"` — el `aria-label`, no el `placeholder` visible | Campo ya correcto antes de la fase 3, sin relación con sus cuatro arreglos; confirma que el método (computar, no leer el atributo) funciona en este árbol antes de declarar los cuatro campos reales no verificados | `verificacion-report.md`, sección de campos |

### Lo que esta entrega no intentó

- No se aplicó ningún arreglo de código: el único defecto confirmado en vivo
  (el contenedor de esqueleto del Explorer sin texto real) ya estaba
  declarado como deuda fuera de alcance antes de empezar esta tarea.
- No se repitió el recorrido de teclado completo de las fases 1-2 sobre `/`;
  esta entrega se centró en lo que la fase 3 tocó.
- Ningún lector de pantalla real, otra vez. Sigue sin ejecutarse en ninguna
  fase.

## Lo que las fases 4-6 siguen debiendo

Esta matriz es un registro vivo. Lo que sigue abierto, para que la próxima
entrega lo amplíe en lugar de volver a descubrirlo:

- **Fase 3, cerrada**: C7, C6, A4, M3, A6, A5 y M8 (investigado a fondo:
  los tres `aria-invalid` originales eran genuinos, y ahora hay cinco)
  están implementados — ver la entrada de fase 3 arriba para lo que de
  todo eso se pudo comprobar en vivo y lo que sigue sin sesión. C8
  (`AuthPrompt`) y C10 (`OnboardingFlow`) ya estaban resueltos antes de que
  empezara esta fase (`.superpowers/sdd/fase-3/progress.md`, "Sondeo del
  estado REAL"); no eran trabajo suyo, pero tampoco quedan pendientes. M4 y
  M24 no aparecen mencionados en ningún informe de lote — ningún lote los
  tocó, y esta entrega no tenía forma de confirmar qué son sin el documento
  de auditoría original, así que siguen abiertos sin más información que la
  que ya había. Los landmarks que faltan — las tres ramas `.feed-empty` y
  `/following` sin su propio `h1` — se releyeron el 2026-09-04
  (`FeedContainer.jsx`, `FollowingFeedPage.jsx`) y siguen exactamente como
  las dejaron las fases 1-2: **siguen debiendo**.
- **Lo que la fase 3 deja debiendo, además de lo anterior**:
  - Dos regiones vivas de `EntityExplorer` con el mismo antipatrón que el
    lote 2 barrió en otros siete sitios (`.explorer-container.explorer-skeleton`
    sin texto real, y `.ehc-wiki-skeleton`) — declaradas fuera de alcance en
    `lote-2-report.md` por vivir en un fichero reservado, confirmadas en vivo
    que la primera sigue exactamente así el 2026-09-04.
  - **Casi todo lo que implementó la fase 3 vive detrás de una sesión y
    sigue sin observarse funcionando**: los tres diálogos que no son el
    cajón de filtros ni la hoja de seguidores (`EditInterestsModal`,
    `EmailNotificationModal`, `VisibilityPrompt`), el anuncio de resultados
    y el campo de `SearchPage`, el indicador de reescritura de `ReaderBar`,
    el nombre del campo de `SelectionMenu`, el esqueleto de
    `ScientificReport`, el de `SearchCommand`, las dos regiones de
    `PublicProfilePage` que resultaron ser de propietario y no de visitante,
    `CreateListDialog` y el `aria-live` del handle en `ProfilePage`. La
    entrega de fase 3 en la matriz de arriba lista la razón exacta de cada
    uno; la primera verificación que cuente con una sesión debería empezar
    por esta lista antes que por nada nuevo.
  - El patrón *mount-with-content* (la región nace ya con su mensaje dentro,
    en vez de nacer vacía y rellenarse) quedó como el mecanismo de facto de
    casi todos los esqueletos de carga que tocó esta fase
    (`PublicPaperPage`, y por lectura de código `ReaderBar`,
    `ScientificReport`, `SearchCommand`, las dos de `PublicProfilePage`, y
    el `search-input-loader` ya existente de `SearchPage`) — es la
    convención que ya usaba el repo y la que aceptó la revisión del lote 1,
    pero sigue siendo el patrón más débil que el persistente-y-vacío de
    `CommentsSheet` y el propio anuncio de resultados de `SearchPage`. Ni
    uno ni otro patrón se ha confirmado con un lector de pantalla real.
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
