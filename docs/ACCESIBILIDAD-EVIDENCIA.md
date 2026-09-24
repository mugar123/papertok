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
| Feed (escritorio) | `PaperCard` — «et al.» y modal de autores | 2.1.1, 2.4.3, 4.1.2 | Cumple | A 1280 px el botón es alcanzable con `Tab`; abre `role="dialog"` `aria-modal="true"` con `aria-labelledby`; el foco entra en el diálogo; `Escape` lo cierra; el foco vuelve al botón «et al.» (`activeElement === opener`) | Desde 2026-09-05 la hoja es un `Drawer` de Base UI (shadcn): la trampa de foco, Escape y la restauración las hace la primitiva; el foco inicial lo programa por frame de animación, congelado en pestaña oculta hasta forzar un fotograma. No es un defecto | Recorrido manual (2026-08-29); pendiente repetirlo sobre el Drawer |
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
| Ajustes | `EditInterestsModal` | 2.1.2, 2.4.3, 4.1.2 | Pendiente de verificar | Desde 2026-09-05 es un `Dialog` de Base UI (shadcn): `role="dialog"`, `aria-modal="true"`, trampa de foco, Escape y restauración vienen de la primitiva; las píldoras son botones nativos con `aria-pressed` | Defecto C7 cerrado en código; falta el recorrido manual con sesión | Recorrido manual pendiente |
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

## Entrega: Landing (2026-09)

Cubre la landing de marketing (`src/landing/`, servida en `/`), no la app —
esta entrega es independiente de la numeración de fases de arriba. Task 11 del
plan de rediseño (`.superpowers/sdd/2026-09-17-landing-rediseno/`), pedida por
nombre por el propietario del proyecto. Esta entrada ya incorpora las
correcciones y los hallazgos de una revisión de código posterior ("fix round
1", marcados como tales abajo); no queda como una sección aparte porque
corrigen y afinan la misma entrega, no añaden una nueva. Detalle completo,
con las tres configuraciones de axe antes y después de AMBAS rondas, el
árbol de accesibilidad completo, la prueba de página muerta y la
autorrevisión, en
`.superpowers/sdd/2026-09-17-landing-rediseno/task-11-report.md`.

### Cómo se comprobó

- **Build servido, no dev server**: `vite build` con las variables de entorno
  del Worker de producción, servido con `vite preview` en `:4173`. La
  auditoría corre sobre lo que se despliega, no sobre HMR.
- **axe-core 4.13.0**, sonda propia por CDP sin dependencias
  (`scripts/diagnostics/landing-axe.mjs`, mismo esqueleto que
  `landing-shots.mjs`): `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` y
  `best-practice`, en tres configuraciones — 390×844 con emulación táctil y
  `prefers-color-scheme: light`; la misma a 390 con `dark`; y 1440×900.  El
  run de 1440 fija el tema a `light` **explícitamente**: Chrome headless
  hereda la preferencia oscura de esta máquina, así que sin fijarlo el run
  "de escritorio" habría probado el tema que esta máquina prefiere, no uno
  fijo y reproducible (la misma razón por la que `landing-shots.mjs` ya
  acepta `THEME=`). Script añadido a `package.json` como `npm run a11y:landing`.
- **`label-content-name-mismatch` (WCAG 2.5.3) habilitada explícitamente
  (fix round 1)**: axe-core la etiqueta a la vez `wcag21a` y `experimental`,
  y `runOnly` por etiquetas excluye cualquier regla también `experimental`
  sin importar sus otras etiquetas — el conjunto de etiquetas de arriba
  nunca la habría corrido. Se añadió `rules: { 'label-content-name-mismatch':
  { enabled: true } }` junto a `runOnly`. Sin silenciar ninguna otra regla:
  ni antes ni ahora hay un `disableRules` en el script.
- **La sonda ya no puede confundir una página muerta con una limpia (fix
  round 1)**: antes, `Page.navigate`'s `errorText` se ignoraba y no había
  ninguna comprobación de que la página cargada fuera realmente esta — contra
  un `vite preview` parado, la sonda leía la página de error del propio
  Chrome, encontraba cero violaciones (nada que auditar) y salía en `PASS`.
  Ahora cada escena comprueba `errorText` y exige que exista un centinela en
  el DOM (`#main-content .lp-hero`), fallando en voz alta si no. Demostrado
  deliberadamente rompiendo cada comprobación por separado (no simplemente
  parando el servidor, que la propia sonda ahora arregla sola — ver el punto
  siguiente): apuntar a un host que no resuelve DNS dispara el chequeo de
  `errorText` (`net::ERR_NAME_NOT_RESOLVED`); apuntar a `/privacy.html` (una
  página real, que carga sin error) dispara el chequeo del centinela. Ambas
  pruebas, con su salida completa, en
  `.superpowers/sdd/2026-09-17-landing-rediseno/task-11-report.md`, "Fix
  round 1".
- **La sonda arranca su propio `vite preview` si nadie responde en la URL
  (fix round 1)**, sin tocar nunca un servidor que ya estuviera respondiendo:
  esto es lo que permite encadenar `npm run a11y:landing` justo después de
  `npm run build` en `npm run check` sin que nadie tenga que acordarse de
  levantar un preview a mano. Verificado: con el puerto libre, `npm run
  a11y:landing` arranca, audita y limpia solo (el proceso propio se mata en
  el `finally`, confirmado con `lsof` antes y después).
- **Reflujo y zoom**, en la misma sonda: 320×568 y 390×844 comprobando
  `document.documentElement.scrollWidth <= window.innerWidth` y que ningún
  `p.lp-body`/`.lp-strip p` computa bajo 16px; 1440 con
  `deviceScaleFactor: 2` y ancho 720 (equivalente a zoom 200%), mismo chequeo
  de scroll horizontal. El script sale con código 1 si hay violaciones de axe
  **o** si cualquier escena de reflujo/zoom encuentra scroll horizontal o
  texto bajo 16px — "cero violaciones de axe" solo no basta como puerta si la
  página igual se desborda a 320px.
- **Teclado**: Chrome real del panel del agente (`mcp__Claude_Browser__*`),
  conducido con la tecla `Tab` real, no con eventos sintéticos de CDP salvo
  donde se declara abajo. Viewport real durante el recorrido: 1024×768.
- **Lector de pantalla: NO se condujo VoiceOver.** Declarado, no evitado en
  silencio. Esta sesión tiene acceso a `computer-use`, que controla el
  escritorio **real** de este Mac, no una máquina aislada. Encender VoiceOver
  cambia el comportamiento del teclado a nivel de sistema (las flechas pasan
  a ser navegación de VoiceOver) de forma disruptiva para cualquier otra cosa
  que el usuario esté haciendo en su propia sesión en paralelo, y no hay
  forma fiable de "oír" lo que anuncia sin una lectura fragil del panel de
  subtítulos por captura de pantalla. **Corrección de procedencia (fix round
  1)**: esta entrada decía antes que "el propio encargo de esta tarea
  autoriza expresamente esta alternativa" — falso. El fichero de encargo
  (`task-11-brief.md:68`) solo dice "Con VoiceOver en iOS (o el simulador)"
  y no lleva ninguna cláusula de reserva. La autorización para extraer el
  árbol de accesibilidad en su lugar vino del despacho del coordinador de
  esta tarea en el chat, no del encargo escrito. La limitación en sí —no se
  condujo VoiceOver— es cierta y se declaró en ambos casos; lo que estaba
  mal era a qué documento se le atribuía el permiso. Se extrajo el **árbol
  de accesibilidad completo de CDP** (`Accessibility.getFullAXTree`, más
  `childIds` para bajar por cada subárbol) para el hero, la sección de la
  rueda y el mapa — el mismo dato que cualquier lector de pantalla real
  consume, aunque no confirma pronunciación, verbosidad ni las teclas
  propias de VoiceOver.

#### Artefactos del entorno que condicionan las lecturas

1. **El `data-motion` de arranque se decide contra el viewport que había AL
   NAVEGAR, no el actual.** El script inline de `index.html` corre antes del
   primer pintado; cambiar el tamaño del panel después de una navegación ya
   hecha no lo vuelve a ejecutar. La primera pasada del recorrido de teclado
   se hizo tras un `resize_window` posterior a la navegación, y
   `data-motion` salió `null` pese a que las mismas condiciones
   (`hover:hover`, `pointer:fine`, `min-width:768px`) ya daban `true` en ese
   momento — no es un defecto de la página (falla cerrado, tal como está
   documentado en `motion.js`), es un artefacto de haber medido con el
   viewport equivocado. Recargar con el viewport ya puesto lo corrigió; el
   recorrido real que cuenta en la matriz de abajo es el de después.
2. **Los eventos de teclado sintéticos de este panel no activan ni
   `<button>` ni `<a>`.** Amplía el artefacto 2 de la entrega fase 1-2 (que
   solo declaraba los `<button>` afectados y los `<a>` funcionando): aquí,
   una `Return` real sobre el enlace de salto enfocado tampoco navegó
   (`location.hash` se quedó vacío). La activación de ambos se verificó con
   `.click()` sobre el elemento **enfocado mediante `Tab` real** — que
   recorre el mismo `onClick`/`href` que una pulsación real — nunca con
   `.focus()` puro: medido, un `.focus()` por script sin un `Tab` real
   previo SÍ deja pasar la activación pero el foco resultante en el
   siguiente elemento **no** obtiene `:focus-visible` (heurística de
   Chromium sobre qué cuenta como "modalidad de teclado"), mientras que el
   mismo `.click()` tras un `Tab` real sí lo obtiene. Declarado: la
   pulsación real de `Enter` sobre botones y enlaces **no** está verificada
   en esta entrega, igual que en la de fase 1-2.
3. **El panel oculto vuelve inútil una `scrollIntoView()` recién llamada**
   (fix round 1). Ya documentado como patrón general en
   `papertok-hidden-pane-freezes-transitions.md` y en el artefacto 3 de la
   entrega fase 1-2 ("`scrollIntoView` tampoco mueve nada mientras tanto") —
   esta entrega lo volvió a pisar de primera mano, no por lectura: con
   `document.hidden === true`, una llamada a `status.scrollIntoView(...)`
   ejecutada dentro del propio código de la página (no por este script) leyó
   como si no hubiera movido nada al comprobarla unos segundos después, y
   solo una SEGUNDA llamada, invocada a mano en ese mismo instante desde la
   consola, sí movía el elemento. Esto se descubrió persiguiendo lo que
   parecía un defecto de producto (ver corrección 5) y hay que declararlo
   aparte: la propia medición pudo estar contaminada por el panel oculto en
   más de un punto de este recorrido, no solo en el que se acabó
   identificando y corrigiendo.

### Correcciones hechas durante esta verificación

Las dos primeras (de la entrega original) se encontraron con el recorrido de
teclado en vivo, no con axe — axe-core no puede ver un movimiento de foco
dinámico ni un `tabindex` ausente en un fragmento de URL. Las tres restantes
son de esta revisión (fix round 1): una la encontró axe con la regla nueva
habilitada, dos las encontró de nuevo el recorrido de teclado en vivo.

1. **Las iniciales del avatar (el paper de LIGO, hero) no llegaban a 4.5:1.**
   axe-core midió 4,39:1 (`--text-tertiary` `#6b7280` sobre
   `--tint-neutral-bg` `#f4f4f5`) en las tres configuraciones. Son
   `aria-hidden` (decorativas, redundantes con el nombre real de al lado),
   pero 1.4.3 es sobre lo que una persona vidente con baja visión puede
   percibir, no sobre lo que un lector de pantalla anuncia, así que
   `aria-hidden` no las exime. `.lp-avatar` pasa a `--text-secondary`
   (`#5b6270`), que mide 5,58:1 sobre el mismo fondo. Reverificado: 0
   violaciones de `color-contrast` en las tres configuraciones.
2. **El enlace de salto cambiaba la URL pero nunca movía el foco.**
   `#main-content` no tenía `tabindex="-1"` (a diferencia del `#main-content`
   de la propia app, `App.jsx`). Esta página no monta `HashRouter` — no hay
   el problema que obligó a la app a interceptar el clic — pero sin
   `tabindex`, un `<main>` no es intrínsecamente enfocable, y la navegación
   de fragmento del navegador cae a `<body>`. Verificado en vivo, antes de
   corregir: tras activar el enlace de salto enfocado,
   `document.activeElement.tagName === "BODY"` con
   `location.hash === "#main-content"` — el enlace "saltaba" visualmente
   (el scroll sí se movía) pero no dejaba nada que un `Tab` o un lector de
   pantalla pudieran continuar desde ahí (WCAG 2.4.1). Corregido añadiendo
   `tabindex="-1"` en `page.js`. Eso deja un `<main>` del tamaño de toda la
   página como objetivo de foco: medido, un anillo de 2px alrededor de una
   caja más alta que el viewport dibuja el borde superior bajo la barra fija
   y el resto bajo el pliegue — invisible en la práctica, mismo
   razonamiento que ya sostiene la excepción del `#main-content` de la app.
   Se añadió `#main-content.lp-main:focus { outline: none; }` (landing.css,
   con el mismo alcance que `#main-content` en `App.jsx`) y la excepción
   correspondiente se documentó en **ambos** ficheros que vigilan la
   supresión del anillo: `src/landing/a11y.test.js` (propio de esta tarea) y
   `src/accessibilityStructure.test.js` (el de toda la app, que también
   escanea `src/landing/landing.css` y lo marcó como no reconocido hasta
   añadir la entrada).
3. **La secuencia del lector soltaba el foco a `<body>` sin ningún
   indicador visible.** `armRewrite()` (motion.js) pone `card.inert = true`
   ~140ms después de pulsar "Read in plain words" (la transición
   idle→source) — el navegador desenfoca lo que hubiera dentro de la
   tarjeta hacia `<body>` en ese instante, sin ningún evento que lo avise.
   Verificado en vivo: tras pulsar el botón y esperar a que la secuencia
   terminara (`data-phase="done"`), `document.activeElement.tagName`
   quedaba en `BODY` — una persona con teclado que acababa de abrir el
   lector habría tenido que volver a tabular desde el principio de toda la
   página para alcanzar el contenido que se acababa de abrir delante suyo.
   Corregido: `setPhase()` ahora comprueba, justo antes de que
   `card.inert` se ponga a `true`, si el foco estaba dentro de la tarjeta
   (`card.contains(document.activeElement)`), y si es así mueve el foco a
   `.lp-rewrite__status` (nuevo `tabindex="-1"` en `page.js`) — el único
   elemento del lector que nunca se oculta a lo largo de `source`→
   `reading`→`done` (a diferencia de `.lp-ghost`, que se desvanece a
   `opacity:0` en `done` pero se queda en el DOM: enfocar algo dentro
   habría cambiado un objetivo de foco invisible por otro). Verificado en
   vivo con un `Tab` real hasta el botón (no `.focus()` — ver artefacto
   2 arriba, la diferencia importa para si `:focus-visible` se pinta):
   tras activar el botón, el foco aterriza en `.lp-rewrite__status` con
   `outline: rgb(17, 19, 24) solid 2px` real y `:matches(':focus-visible')`
   cierto; un `Tab` más desde ahí llega a la pestaña de nivel de lectura
   seleccionada.
4. **(fix round 1) El botón "Read in plain words" tenía una etiqueta
   accesible que no contenía su texto visible (WCAG 2.5.3 Label in Name).**
   `page.js:288` ponía `aria-label="Read this paper in plain words"` sobre
   un botón cuyo texto visible es "Read in plain words" — "this paper" se
   inserta en medio y rompe la subcadena, así que alguien usando entrada por
   voz que diga "click Read in plain words" no tiene nada que coincida.
   Encontrado leyendo `docs/ACCESIBILIDAD.md:108` a mano y confirmado
   habilitando `label-content-name-mismatch` en axe (ver "Cómo se
   comprobó"). Corregido borrando el `aria-label`: el texto visible ya es un
   nombre accesible perfectamente bueno por sí solo. Reverificado con la
   regla habilitada en las tres configuraciones: **cero** instancias en toda
   la página (47/47/45 reglas pasadas según el ancho, una más que antes en
   cada una — la regla nueva corriendo y sin encontrar nada). Regresión:
   `src/landing/a11y.test.js`, el test de nombre accesible ahora compara la
   etiqueta contra el texto visible cuando existen ambos, no solo que exista
   uno de los dos.
5. **(fix round 1) WCAG 2.4.11 Focus Not Obscured — nunca comprobado, y al
   comprobarlo con `Tab` real a 1440×900 el foco SÍ acababa bajo la barra.**
   `.lp-bar` es `position: sticky; top: 0` opaca; sin `scroll-padding-top`
   en ningún sitio de `src/`, el navegador puede dejar el borde superior de
   un elemento recién enfocado justo en `y=0`, que sigue estando DEBAJO de
   la barra. Se añadió `html { scroll-padding-top: var(--nav-height); }` en
   `static-page.css` (compartido por landing y privacy). Con eso, las 15
   paradas normales de `Tab` (390 y 1440) ya no se obscurecen nunca — el
   propio scroll-al-enfocar nativo del navegador respeta el padding. Pero
   quedaba UN caso que no: el foco programático que la corrección 3 mueve a
   `.lp-rewrite__status` seguía apareciendo a `y=44` (12px dentro de la
   barra de 56px) pese al `scroll-padding-top` correcto. Medido: `.focus()`
   por sí solo NO usa el mismo algoritmo que `scrollIntoView()` en este
   motor — una llamada explícita a `status.scrollIntoView({ block:
   'nearest' })` justo después SÍ lo corregía, a `y=56` exacto, en la MISMA
   medición. Se cambió `motion.js` a `status.focus({ preventScroll: true
   })` seguido de `status.scrollIntoView({ block: 'nearest' })`. Eso
   tampoco bastaba por sí solo: medido de nuevo más tarde (fase `done`), la
   posición había vuelto a `y=44` sin que ningún código de este fichero
   tocara el scroll entre medias — el sospechoso es el "scroll anchoring"
   del navegador reaccionando a que la celda de grid que comparten
   `.lp-rewrite__card` y `.lp-rewrite__reader` cambia de altura efectiva
   mientras la tarjeta se desvanece y el lector/ghost/pasaje se intercambian,
   y recolocando el scroll para compensarlo por encima de lo que este
   código acababa de fijar. Se añadió una SEGUNDA corrección, en la
   transición a `phase === 'done'`: si `.lp-rewrite__status` sigue siendo
   `document.activeElement`, se vuelve a llamar
   `scrollIntoView({ block: 'nearest' })` — vuelve a `y=56` y esta vez se
   mantiene, verificado con una espera adicional tras `done` y con capturas.
   Regresión: `a11y.test.js` fija tanto el `scroll-padding-top` en la hoja
   de estilos como las dos llamadas de `scrollIntoView` en `motion.js`.

### Lo que se investigó y se dejó tal cual, con su razón

**El separador "·" del meta (`.lp-paper__dot[aria-hidden="true"]`), a
2,22:1.** axe deja esto como **"incomplete"** (no "violation") en las tres
configuraciones — 11 nodos en 390px, 39 en 1440px. Medido a mano:
`--border-strong` (`#a9aeba`) sobre el papel blanco del sheet
(`--bg-figure-plate`, `#ffffff`) da 2,22:1, muy por debajo de 4,5:1.

**Dictamen (revisado en fix round 1 — la razón correcta, no la que había
antes):**

- **1.4.11 (Non-text Contrast) no aplica.** 1.4.11 exige 3:1 para
  componentes de interfaz y gráficos que aportan información — un carácter
  "·" es *texto*, no un componente de interfaz ni un gráfico, así que 1.4.11
  no es el criterio que le corresponde en absoluto, gane o pierda el 2,22:1.
- **1.4.3 (Contrast (Minimum)) no aplica, por la excepción de texto
  incidental.** WCAG 1.4.3 exceptúa "texto incidental": el que es
  decorativo, no visible a nadie, o cuya presentación es incidental y no
  transmite información. Aquí se cumplen las dos condiciones que hacen
  válida esa excepción, no solo una: los spans de campo, categoría y año que
  separa ya llevan esa información cada uno por su cuenta, y la maquetación
  (el espaciado de `.lp-paper__meta`) ya los distingue sin depender del
  punto. El punto no transmite nada que el resto de la fila no transmita
  ya, así que 1.4.3 tampoco lo alcanza.
- **Lo que NO son argumentos de WCAG, y esta entrega los tenía antes por
  error:** que axe lo marque "incomplete" en vez de "violation" es una
  propiedad de la herramienta, no del criterio — no decide nada por sí
  sola. Que la app real use el mismo patrón (`.pc-meta-dot`,
  `PaperCard.css`) tampoco decide nada — un patrón compartido puede estar
  igual de mal en los dos sitios. Ninguna de las dos frases debía estar en
  esta entrada, y se han quitado; el resultado ("no aplicable") es el
  mismo, pero ahora está sostenido por los criterios, no por la herramienta
  ni por el precedente.
- **Qué cambiaría la respuesta**: si el punto llegara a ser alguna vez la
  ÚNICA frontera entre dos valores (sin espacio ni ningún otro separador
  visual), si empezara a llevar algún estado (por ejemplo, un color que
  significara algo), o si ganara un título o una interacción propia — en
  cualquiera de esos casos dejaría de ser texto incidental y esta entrada
  tendría que reabrirse.

No se tocó el color. Es una línea si el propietario del proyecto lo quiere
cambiado de todas formas, pero no lo pide ningún criterio de WCAG tal como
está hoy.

### Matriz

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| Landing, global | `lang` del documento y del nombre en español | 3.1.1, 3.1.2 | Cumple | `src/landing/a11y.test.js` | — | `npm test` |
| Landing, global | Nombre accesible de cada `<a>`/`<button>` | 4.1.2, 2.4.4 | Cumple | `a11y.test.js` (recorre todo `<a>`/`<button>` del HTML construido) | — | `npm test` |
| Landing, global | Cada `<svg>` decorativo o imagen con título | 1.1.1 | Cumple | `a11y.test.js` (2 svg `role="img"`, cada uno con su propio `<title>`, ids no compartidos) | — | `npm test` |
| Landing, global | Anillo de foco nunca suprimido sin justificar | 2.4.7 | Cumple | `a11y.test.js` + `accessibilityStructure.test.js` comparten el mismo criterio; una excepción documentada en ambos | `#main-content.lp-main:focus` — ver corrección 2 | `npm test` |
| Landing, móvil | Objetivos táctiles ≥44px (Skip, enlaces de barra/pie, las dos CTA, pestañas del lector) | 2.5.8 | Cumple | `a11y.test.js` | — | `npm test` |
| `lp-follow`, `lp-library`, `lp-research` | Figuras decorativas con figcaption que las describe, sin controles reales dentro | 1.1.1, 4.1.2 | Cumple | `a11y.test.js` (3 figuras; `aria-hidden` en el envoltorio inmediato tras el figcaption; ningún `<button>`/`<a>` dentro) | — | `npm test` |
| Landing, global | Jerarquía de encabezados sin saltos | 1.3.1 | Cumple | `a11y.test.js` (h1–h6, orden de documento; incluye los 11 `<h4>` de las fichas de Research que la propia plantilla del encargo no cubría) | — | `npm test` |
| Landing, 390×844, claro | axe-core (wcag2a/aa, 21aa, 22aa, best-practice + `label-content-name-mismatch` habilitada a mano) | varios, incl. 2.5.3 | Cumple **tras corrección** | `landing-axe.mjs`: 0 violaciones, **47** reglas pasadas. Dos comparaciones distintas, no una: (a) la entrega original — antes de la corrección 1 — medía 1 violación `color-contrast`/2 nodos con 46 reglas corriendo; (b) fix round 1 en concreto sube de 46 a **47** reglas corridas al habilitar `label-content-name-mismatch` (antes ni corría, tagged `experimental`), y esa regla nueva no encuentra nada tras la corrección 4 | 1 "incomplete" sin resolver, ver sección de arriba; contra un servidor muerto la sonda ahora falla en voz alta en vez de dar 0 violaciones (ver "Cómo se comprobó") | `npm run a11y:landing` |
| Landing, 390×844, oscuro | ídem | varios, incl. 2.5.3 | Cumple **tras corrección** | ídem, 0 violaciones, 46→**47** reglas pasadas con la misma regla nueva | ídem | `npm run a11y:landing` |
| Landing, 1440×900, claro (fijado) | ídem | varios, incl. 2.5.3 | Cumple **tras corrección** | ídem, 0 violaciones, 44→**45** reglas pasadas (la original: 1 violación/4 nodos — a este ancho también se ven los avatares del paper reutilizado en el lector) | ídem | `npm run a11y:landing` |
| Landing, global | Etiqueta accesible contiene el texto visible (Label in Name) | 2.5.3 | Cumple **tras corrección** | `label-content-name-mismatch` habilitada: 0 instancias en toda la página tras la corrección 4; `a11y.test.js` compara `aria-label` contra el texto visible cuando existen ambos | Antes de corregir: el botón "Read in plain words" (ver corrección 4) | `npm run a11y:landing` + `npm test` |
| Landing, 320×568 y 390×844 | Reflujo sin scroll horizontal | 1.4.10 | Cumple | `scrollWidth === innerWidth` en ambos anchos | El chequeo de texto de cuerpo ≥16px que vive en la misma escena no es evidencia de 1.4.10 ni de 1.4.4 por sí solo — ver la fila de zoom, debajo, para 1.4.4 | `npm run a11y:landing` |
| Landing, 1440 a zoom 200% (720×450, deviceScaleFactor 2) | Texto redimensionable a 200% sin pérdida de contenido ni funcionalidad; reflujo sin scroll horizontal | 1.4.4, 1.4.10 | Cumple | `scrollWidth === innerWidth === 720px` a una escena que simula honestamente 200% de zoom (720×450 es la mitad exacta de 1440×900, no 720×900 — corregido en fix round 1) | Antes de fix round 1 la escena usaba 720×900, una proporción que no era realmente "zoom 200%" de nada | `npm run a11y:landing` |
| Landing, barra→hero→deck→lector→strip→close→pie | Orden de foco de teclado completo | 2.4.3, 2.1.1 | Cumple **tras corrección** | Recorrido con `Tab` real (Chrome del panel, 1024×768): Skip → PaperTok (barra) → Source → Open the feed (barra) → Open the feed (hero) → hoja (`role=group`, carrusel) → Skip (mazo) → Read in plain words → [al activarlo] pestaña de nivel seleccionada → mugar123/papertok → Samuel Corsan → Open the feed (cierre) → PaperTok (pie) → GitHub → Privacy → vuelve a Skip. 16 paradas, ninguna repetida salvo el cierre del ciclo | El enlace de salto no funcionaba antes de esta tarea (corrección 2) | Recorrido manual |
| Landing, hoja del hero | `↓`/`↑` mueven el mazo, no la página; anillo visible al enfocar | 2.1.1, 2.4.7 | Cumple | `data-deck-count` pasa de "1 / 3" a "2 / 3" con `ArrowDown` y `window.scrollY` sin cambiar (117 antes y después); `outline: rgb(17, 19, 24) solid 2px` en la hoja enfocada | — | Recorrido manual |
| Landing, lector | Pestañas de nivel alcanzables y operables (tabindex progresivo, flechas mueven foco y panel) | 2.1.1, 4.1.2 | Cumple | `ArrowRight` desde "University" mueve el foco Y `aria-selected`/`data-active` a "Researcher" (`lp-level-panel-2`), en el mismo evento | Con `data-motion="on"` las pestañas solo se alcanzan por `Tab` una vez `data-phase="done"` (antes, están `inert` dentro del lector) — intencional: el lector está detrás de la tarjeta hasta ese momento. Sin motion (móvil, reduce-motion, o el viewport-al-navegar del artefacto 1), `armLevels()` las deja operables desde el primer pintado, sin esperar nada. Ambas rutas verificadas en vivo | Recorrido manual + `a11y.test.js` |
| Landing, lector | La secuencia no suelta el foco a `<body>` al abrirse | 2.4.3, 2.4.7 | Cumple **tras corrección** | Ver corrección 3 | — | Recorrido manual + `a11y.test.js` |
| Landing, global (`.lp-bar` fija) | El foco recién enfocado no queda bajo la barra (Focus Not Obscured) | 2.4.11 | Cumple **tras corrección** | `html { scroll-padding-top: var(--nav-height) }` (corrección 5); recorrido de teclado completo repetido a 390 y a 1440 tras la corrección — las 15/16 paradas normales de `Tab` en ambos anchos, `obscured: false` en todas (comprobado con `elementFromPoint` en el borde superior-izquierdo de cada elemento enfocado) | Un caso adicional, solo alcanzable programáticamente (el foco que la corrección 3 mueve a `.lp-rewrite__status`), necesitó una segunda corrección aparte — ver corrección 5 completa | Recorrido manual (ver informe) |
| Landing, `.lp-problem`/`.lp-follow`/`.lp-library`/`.lp-map`/`.lp-research` | Ningún foco cae en la rueda ni en las figuras decorativas | 2.1.1, 1.3.1 | Cumple | Las 16 paradas del recorrido completo no tocan ninguna de estas cinco secciones | — | Recorrido manual |
| Landing, rueda (`.lp-problem`) | Oculta a tecnología de apoyo; la lista real de al lado sí se anuncia | 1.3.1, 4.1.2 | Cumple | Árbol de accesibilidad (CDP `Accessibility.getFullAXTree`): `.lp-pile` no genera NINGÚN nodo AX (ausente del árbol); `#lp-pile-list` aparece como `list` con sus 25 `listitem`, cada uno con venue y título reales | — | `a11y.test.js` + árbol AX (ver informe) |
| Landing, mapa de citas | Se anuncia como imagen con su propio título | 1.1.1 | Cumple | Árbol de accesibilidad: `image "The citation map of the LIGO paper: five works it cites above the line, two that cite it below, placed by how many citations each received."`; lista visualmente oculta con los 7 vecinos y sus citas reales | El interior del SVG (marcas de eje, etiquetas de nodo) sigue generando nodos AX propios pese a `role="img"` en el contenedor — no es una "violation" de axe ni contradice el nombre accesible del `role="img"`, pero un lector de pantalla que deje "entrar" al usuario en la imagen podría exponerlos como paradas sueltas en vez de tratarla como una hoja atómica; comportamiento dependiente de la combinación navegador/AT, no confirmable sin VoiceOver real | VoiceOver real |
| Landing, global | Rotor de encabezados (lo que listaría un lector de pantalla) | 1.3.1, 2.4.6 | Cumple, con una discrepancia señalada | Árbol de accesibilidad: 1×h1 + 10×h2 de sección + 1×h2 (título del paper 1 del hero, `heading:'h2'` en `paper()`) + 1×h3 (el mismo paper reutilizado en el lector, nivel por defecto) = 13 encabezados alcanzables por AT, ninguno salta de nivel | El encargo de esta tarea esperaba "h1 + once h2"; hay once SECCIONES pero solo diez llevan su propio `<h2>` (la del hero es `<h1>`) — la cuenta real y correcta (13, contando los títulos de paper anidados) no coincide con esa expectativa escrita. Señalado aquí, no alterado: la estructura real no tiene ningún salto y ya la sostiene `a11y.test.js` | árbol AX (ver informe) |
| Landing, global | Lector de pantalla real | 1.3.1, 4.1.2, 4.1.3 y demás | **No verificado** | Ninguna | **No se condujo VoiceOver.** Ver "Cómo se comprobó" — el árbol de accesibilidad de CDP se usó como sustituto declarado (las cinco filas de arriba que lo citan), que es el mismo dato que cualquier lector de pantalla consume, pero no confirma pronunciación, verbosidad ni gestos propios de VoiceOver | VoiceOver real |
| Landing, separador "·" del meta (`lp-paper__dot`) | Contraste del glifo decorativo | 1.4.3, 1.4.11 | No aplicable (razonado; dictamen revisado en fix round 1) | Medido a mano: 2,22:1 (`--border-strong` sobre `--bg-figure-plate`). 1.4.11 no aplica porque un "·" es texto, no un componente de interfaz. 1.4.3 no aplica por la excepción de texto incidental: los spans de campo/categoría/año llevan la información por su cuenta y la maquetación ya los separa | Ver "Lo que se investigó y se dejó tal cual" para el dictamen completo y qué lo reabriría | — |

### Lo que esta entrega no intentó

- Ningún lector de pantalla real — declarado arriba, con su razón, no una
  omisión silenciosa.
- La pulsación real de `Enter` sobre botones y enlaces en el recorrido de
  teclado (artefacto 2) — se usó `.click()` sobre el elemento enfocado por
  `Tab` real, que recorre el mismo manejador, pero no es lo mismo que una
  tecla real llegando al navegador.
- El tema oscuro del recorrido de TECLADO (el `axe` sí cubrió oscuro; el
  paso a paso de foco/anillo se hizo solo en claro).
- Contraste de color fuera de lo que axe-core mide automáticamente y lo que
  se investigó a mano para el "incomplete" — no se auditaron a mano el resto
  de combinaciones de color de la landing más allá de lo que axe ya cubre.
- Ningún dispositivo real (iPhone/Android físico, VoiceOver/TalkBack en
  hardware); todo lo anterior es Chrome de escritorio con emulación táctil
  y de métricas por CDP.
- **(fix round 1)** `npm run a11y:landing` se añadió a `npm run check`
  (después de `npm run build`, antes de `worker:deploy:dry-run`) porque la
  sonda pasó a arrancar su propio `vite preview` cuando nadie responde en el
  puerto — ver "Cómo se comprobó". No se probó `npm run check` completo de
  principio a fin en esta tarea (incluye `worker:deploy:dry-run`, fuera de
  alcance); solo se probó `npm run a11y:landing` de forma aislada, con y sin
  un servidor ya arrancado.
- **(fix round 1)** El recorrido de 2.4.11 se hizo con el panel del
  navegador oculto la mayor parte del tiempo (ver artefacto 3) — las
  lecturas que cuentan en la matriz son las que se repitieron o confirmaron
  tras forzar el estado a mano (animaciones terminadas, `scrollIntoView()`
  repetido), no las primeras lecturas en bruto, que resultaron contaminadas
  al menos una vez. No se repitió el recorrido completo con el panel
  realmente visible en primer plano.
- **(tarea 12)** La fila de 2.4.11 de arriba («El foco recién enfocado no
  queda bajo la barra») da a entender que todo movimiento de foco
  programático quedó comprobado, pero solo se examinó uno en vivo: el que la
  corrección 3 mueve a `.lp-rewrite__status`. Hay otros dos movimientos de
  foco programáticos en `src/landing/motion.js` que **no** se midieron con
  `elementFromPoint`/`obscured` de la misma forma — se razonó sobre ellos por
  lectura de código, no se verificaron: `tabs[next].focus()` (línea 79, las
  pestañas de nivel del lector al moverse con las flechas) y
  `sheet.focus({ preventScroll: true })` (línea 639, la hoja del mazo tras
  pulsar Skip). Ninguno de los dos tiene una fila propia que declare esta
  brecha; queda declarada aquí.

## Entrega: las rutas de la app dejan de vivir en el fragmento (2026-09-18)

`/feed`, `/following` y `/research` pasan a ser URLs de primera clase. La
auditoría de la landing (2026-09) sólo cubría `/`, así que esta pasada es la
primera que audita las tres pantallas de la aplicación **como páginas**.

**Cómo.** axe-core con `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa` y
`best-practice`, con `label-content-name-mismatch` habilitada a mano (axe la
marca también `experimental`, y `runOnly` por etiquetas excluye toda regla
experimental). Seis escenas: las tres rutas a 1440 en claro y a 390 con tacto en
oscuro. `/following` y `/research` están tras `ProtectedRoute`, así que la pasada
corre contra el servidor de **modo demo** —la bandera `IS_DEMO` volteada por un
plugin de Vite desde un fichero de fuera del repo, sin tocar el árbol— con una
cuenta sembrada en `localStorage`. En ningún momento se entra en una cuenta real
ni se escribe una credencial.

**Resultado: 9 violaciones, todas anteriores a esta entrega.** Ninguna la
introduce el cambio de rutas; lo que cambia es que ahora se miran.

| Regla | Impacto | Dónde | Nodos |
|---|---|---|---|
| `button-name` | crítico | `/feed` a 390 | 15 |
| `label-content-name-mismatch` | serio | `.navbar-brand` en las tres rutas | 6 + 1 + 1 |
| `landmark-one-main` | moderado | `/following` (las dos escenas) | 1 + 1 |
| `page-has-heading-one` | moderado | `/following` (las dos escenas) | 1 + 1 |

`button-name` está diagnosticada: `components/Feed/PaperCard.jsx:1783` pinta el
botón con un icono y un `<span class="pc-action-label">`, y
`components/Feed/PaperCard.css:2826` le da `display: none` a esa clase en móvil.
`display: none` saca el texto del árbol de accesibilidad, así que el botón se
queda sin nombre: quince por pantalla. Se ve en la captura — la barra inferior
de la tarjeta en móvil son tres botones de solo icono, mientras el carril de la
derecha (Like, Comments, Save…) sí lleva sus rótulos.

**Lo que esta pasada NO cubre, y hay que decirlo:**

- `/following` se auditó en su **estado vacío**: la cuenta demo no sigue a nadie.
  Una lista poblada es otra pantalla y queda sin verificar.
- `color-contrast` sale como *incompleta* en cuatro de las seis escenas (axe no
  decide sobre texto muy corto ni sobre fondos compuestos). Sin revisar a mano.
- Sólo dos anchos y una combinación de tema por ancho. No hay pasada de reflow a
  320 ni equivalente de zoom al 200 % para estas rutas, que la landing sí tiene.
- Nada de esto corre en CI: `npm run a11y:landing` sigue cubriendo sólo `/`,
  porque auditar las rutas protegidas exige levantar el modo demo.

## Corrección: las nueve violaciones de las rutas, cerradas (2026-09-18)

Mismo arnés, mismas seis escenas, mismo modo demo. Dos tiradas antes de tocar
nada y dos después.

| Escena | Antes | Después |
|---|---|---|
| `/feed` 1440 claro | 1 regla (`label-content-name-mismatch`, 4 nodos) | **0** |
| `/feed` 390 oscuro | 2 reglas (`button-name` **15 nodos**, `label-content-name-mismatch` 4) | **0** |
| `/following` 1440 claro | 3 reglas (`label-content-name-mismatch`, `landmark-one-main`, `page-has-heading-one`) | **0** |
| `/following` 390 oscuro | 2 reglas (`landmark-one-main`, `page-has-heading-one`) | **0** |
| `/research` 1440 claro | 1 regla (`label-content-name-mismatch`) | **0** |
| `/research` 390 oscuro | 0 | **0** |

`/following` pasa de 28 reglas superadas a 32 en sus dos escenas; `/feed` a 1440
se queda en 37 y `/research` en 35, ahora sin violaciones.

**Primero, una corrección a la tabla de arriba.** Decía «`.navbar-brand` en las
tres rutas, 6 + 1 + 1». No era así: el arnés sólo imprime el `target` del PRIMER
nodo de cada violación, y quien leyó la salida tomó ese primero por todos. La
regla disparaba en tres sitios distintos, y el conteo baila entre tiradas porque
el feed no trae los mismos papers:

- `.navbar-brand` — nombre «PaperTok», visible «PT PaperTok».
- `.pc-authors-more` — nombre «Show all authors», visible «et al.».
- el botón de reescritura — nombre «Read this paper in plain words», visible
  «Read in plain words» a 1440 y «Simple» a 390. No contenía a ninguno de los
  dos. La landing ya había cerrado este mismo defecto en su copia del botón
  (`src/landing/a11y.test.js`), y se cierra aquí igual: quitándole el atributo.

**`button-name`, crítico, 15 nodos.** El botón principal de la tarjeta lleva
ahora `aria-label={primaryActionLabel}` — la MISMA expresión que dibuja el
rótulo, no una mejorada, para que las dos no puedan separarse. Lo que anuncia
Chrome, medido con `Accessibility.getPartialAXTree` sobre botones realmente
pintados:

| Botón | Dibuja a 1440 | Anuncia | Dibuja a 390 | Anuncia |
|---|---|---|---|---|
| Principal | «Source» | «Source» | sólo icono | «Source» |
| Compartir | sólo icono | «Share» | sólo icono | «Share» |
| Relacionados | sólo icono | «View related papers» | sólo icono | «View related papers» |
| Reescritura | «Read in plain words» | «Read in plain words» | «Simple» | «Simple» |
| Autores | «et al.» | «et al., show all authors» | «et al.» | «et al., show all authors» |

Los tres botones de la barra inferior que la captura enseñaba como sólo icono
estaban revisados uno a uno: compartir y relacionados ya tenían `aria-label` y
no dibujan texto en ningún ancho, así que el 2.5.3 no les aplica; el único mudo
era el principal. Donde hay texto visible, el nombre lo contiene — comprobado
comparando las dos columnas, no razonado.

**El tramo que la auditoría no mira.** El `aria-label="PaperTok"` de la marca
sobraba: el botón ya dice «PaperTok» en texto. Pero quitarlo a secas habría
abierto un agujero peor que el que cerraba. `.navbar-brand-word` era
`display: none` por debajo de 768 px y `.navbar-brand` sólo desaparece a 480,
así que **entre 481 y 768 px** el botón se habría quedado con la marca «PT»
—`aria-hidden`— y sin nombre ninguno: `button-name`, crítico, en una anchura que
ni 1440 ni 390 visitan. Por eso el rótulo ahora se recorta en vez de borrarse.
Medido a 1440, 700, 520 y 390: la marca sigue midiendo 26,0 × 26,0 px en los dos
anchos intermedios (100,2 × 26,0 a 1440), el rótulo recortado ocupa 1 × 1 en
posición absoluta y Chrome sigue calculando «PaperTok» en los tres anchos donde
el botón existe.

**`landmark-one-main` y `page-has-heading-one`.** La causa no era que
`/following` no pasara landmark: era que el landmark vivía en dos de las seis
ramas de `return` de `FeedContainer`. La cuenta de pruebas no sigue a nadie, así
que la ruta caía siempre en `SOURCE_EMPTY`, que devolvía un
`<div className="feed-empty">` pelado. Ahora lo pasa `FollowingFeedPage` —es
ella la raíz de la ruta— y lo llevan **todas** las ramas: feed, esqueleto,
error, vacío y el vacío que trae la fuente. El landmark ES el contenedor de cada
rama (`className`) en vez de un nivel más, porque `.feed-empty` y `.feed-wrapper`
traen los dos `margin-top: var(--nav-total)` y anidarlos sumaría el hueco de la
barra dos veces.

**Red de regresión.** Ocho aserciones nuevas, todas comprobadas por mutación
(se deshace el arreglo en el árbol, la prueba tiene que ponerse roja, y el
fichero se restaura): `components/Feed/paperCardActionNames.test.js` (nueva),
las dos de la marca en `components/Layout/navbarChrome.test.js` y las dos del
landmark en `accessibilityStructure.test.js`, cuya prosa sobre `/following` «sin
landmark propio» había quedado vieja y se corrige aquí.

**Lo que esta corrección sigue sin cubrir:**

- **`color-contrast`: revisado a mano, y la violación intermitente era la
  animación.** Una tirada de axe dio violación **seria con 18 nodos** en `/feed`
  a 390 oscuro (`.pc-date`, `.pc-citations`, `.pc-chip`, `.pc-category-pill`) y
  la siguiente volvió a *incompleta*. Medido después elemento a elemento,
  calculando el ratio contra el primer ancestro opaco: **346 textos del
  documento, y los únicos 30 que no llegan son el mismo elemento**, el punto
  separador `.pc-meta-dot`, a **1,99:1** sobre 11px (exige 4,5). Ninguno de los
  cuatro que axe nombró falla en reposo.

  La diferencia está en la entrada de la tarjeta: midiendo a 500 ms de la carga,
  `.pc-meta`, `.pc-chips`, `.pc-topics`, `.pc-title` y `.pc-action-bar` —que es
  donde viven esos cuatro— están a `opacity` entre 0,81 y 0,98. axe compone el
  color efectivo y ve el contraste rebajado de un texto que todavía se está
  pintando; `getComputedStyle` da el color declarado y no lo ve. Así que la
  violación es un transitorio de la animación, no un estado en el que se lea.

  **Lo que sí queda, y es una decisión de diseño, no un descuido que arreglar
  por mi cuenta:** el punto separador de la tarjeta está a 1,99:1 en oscuro. Es
  puntuación decorativa entre dos datos, así que se puede defender como
  decoración pura (1.4.3 la exime), pero a ese contraste probablemente tampoco se
  ve. Subirlo cambia el aspecto de la tarjeta y esa llamada no es mía.
- `/following` se sigue auditando en vivo sólo en su **estado vacío**. Lo que
  cambia es que ahora las ramas restantes están sujetas por prueba de fuente, no
  por haberlas visto.
- Siguen siendo **dos anchos** y una combinación de tema por ancho. El tramo
  481–768 px se midió a mano para la marca, pero no hay pasada de axe ahí, ni de
  reflow a 320, ni equivalente de zoom al 200 %.
- Sigue **fuera de CI**, por la misma razón: auditar las rutas protegidas exige
  levantar el modo demo.
- El nombre del botón de reescritura en móvil es «Simple», que es exactamente lo
  que dibuja. Cumple, pero dice menos que el `aria-label` que había: a quien usa
  lector de pantalla en un teléfono ya no le adelanta que abre el lector en
  palabras llanas. Es el precio de que un botón enseñe dos rótulos distintos
  según el ancho y ninguno contenga al otro; si alguna vez el rótulo corto pasa
  a ser parte del largo, esto se puede mejorar sin volver a romper el 2.5.3.

## Entrega: auditoría de doce fallos (verificación ejecutada el 2026-09-24)

Los arreglos de `docs/AUDITORIA-12-FALLOS-2026-09-23.md` que tocan la interfaz, en la
rama `worktree-auditoria-12-fallos`.

### Cómo se comprobó

- El Vite del worktree (`:5173`) contra datos de producción, como **invitado**, en el
  panel de navegador de la app: interfaz en español y en inglés, tema oscuro, teclado real
  (`Tab`, `Shift+Tab`, `Enter`, `Escape`). Los recorridos que necesitan sesión no se
  hicieron: la sesión la abre Nico.
- `scripts/diagnostics/guest-feed-composition-probe.mjs` contra `:5173`, con un Chrome
  headless de perfil limpio (Informática + Medicina).
- Las páginas para rastreadores (`worker/share-pages.js`), dentro de workerd con
  `workerd test` sobre el bundle de `wrangler deploy --dry-run`, contra la carcasa real y
  los proveedores reales, sin desplegar.

**Artefacto del entorno:** en esta pasada, la captura de pantalla del panel pintó dos veces
un fotograma viejo y desplazado. La geometría se leyó con `getBoundingClientRect`, y ninguna
fila se apoya en una captura.

### Matriz

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| `/feed` (invitado) | «Ver papers relacionados» → `AuthPrompt` con motivo | 2.4.3, 3.3.2, 4.1.2 | Cumple | `Enter` abre un `role="dialog"` con `aria-modal="true"`, nombre «Las conexiones necesitan una cuenta» (`aria-labelledby`) y el motivo como descripción (`aria-describedby`); no se abre el panel de relacionados ni aparece «No se pudieron cargar» | El foco se puso por script antes del `Enter` real | `authPromptCopy.test.js`, `authPromptReasonWiring.test.js` + recorrido manual |
| `/feed` (invitado) | «Leer en simple»: aviso antes de pulsar | 1.3.1, 3.3.2 | Cumple | El botón lleva el candado (`aria-hidden`) y `aria-describedby` → «Necesita una cuenta gratuita»; `Enter` abre «Leer en simple necesita una cuenta» con su motivo y no abre el lector | — | `rewriteGuestCue.test.js` + recorrido manual |
| Bienvenida | `GuestInterestsPrompt`: lo que promete | 3.3.2 | Cumple | La descripción del diálogo dice «Con una cuenta gratuita, muchos se pueden leer además explicados en claro.»; detrás no hay tarjetas cargadas (la sonda: cero peticiones de datos en 15 s con la hoja abierta) | — | `rewriteGuestCue.test.js`, `guestFeedBackdrop.test.js` + sonda |
| Explorer (invitado) | El buscador como botón que avisa | 2.1.1, 2.4.3, 2.4.7, 4.1.2 | Cumple | `<button type="button">` «Buscar en este tema · necesita cuenta»; con `Tab` real casa `:focus-visible` y pinta un anillo sólido de 2 px; `Enter` abre «Buscar y filtrar necesita una cuenta»; el foco entra, `Escape` cierra y el foco vuelve al botón | — | `explorerGuestGate.test.js` + recorrido manual |
| Explorer | Caja de Wikipedia: idioma del texto | 3.1.2 | Cumple | En `/explorer/concept/C2779256057` con la interfaz en español, el párrafo del artículo inglés («Tumor progression is the third and last phase…») lleva `lang="en"`; ya no sale Allan Balmain | — | `explorerWikiIdentity.test.js` + recorrido manual |
| Tarjeta | Chips de tema: idioma | 3.1.2 | Cumple | Los temas propios salen en el idioma de la interfaz («Visión por Computador»); el texto del proveedor lleva `lang="en"` | En vivo solo se vieron chips propios; el `lang` del texto del proveedor está fijado por test | `paperTopicTags.test.js` |
| Explorer (autor por nombre) | Aviso «Encontrado por el nombre» | 1.3.1 | No verificado | Fijado por test de fuente | No se abrió un autor sin id en vivo | `explorerAuthorIdentity.test.js` |
| Ruta desconocida | `NotFoundPage` | 1.3.1, 2.1.1, 2.4.2, 2.4.7 | Cumple | `/esto-no-existe` se queda en su dirección, con un `<main>`, un h1, título «Página no encontrada \| PaperTok» y `robots noindex`; `Tab` pasa por el enlace de salto y llega a la acción con anillo de 2 px; `Enter` lleva a `/feed` y el `noindex` se va con la página; `/` sigue llegando a `/feed` | — | `notFoundPage.test.js`, `spaRouteCoverage.test.js` + recorrido manual |
| 404 HTTP | `public/404.html` | 1.3.1, 1.4.3, 2.4.7, 3.1.2 | No verificado | Estático: un `<main>`, un h1, la parte inglesa en una sección con `lang="en"`, enlaces de 42 px de alto y ratios calculados por encima de 7:1 en los dos temas | Solo lo sirve Vercel después del despliegue | `spaRouteCoverage.test.js` |
| `/feed` (invitado) | h1 visualmente oculto | 1.3.1, 2.4.6 | Cumple | En el DOM: un `<main>` y, dentro, un h1 «PaperTok: scientific papers for you» / «PaperTok: papers científicos para ti» | — | `accessibilityStructure.test.js` + DOM en vivo |
| `/public/paper/:key` | El título como h1 | 1.3.1 | Cumple | Un `<main>`; el h1 es el título (`.pc-title`) con el mismo tamaño que tenía el h2 (25,6 px); `robots index, follow` | — | `accessibilityStructure.test.js` + DOM en vivo |
| `/public/paper/:key` (rastreador) | Semilla del Worker | 1.3.1 | Cumple | Con una semilla inyectada para `arxiv:2609.99999`, la página se pinta desde ella con el título en texto plano y sin `noindex` desde el primer render, y sigue ahí cuando la carga no encuentra nada (8 s) | Semilla inyectada a mano; el documento real del Worker solo lo recibe un rastreador a través de Vercel | `shareSeed.test.js`, `publicPaperShareSeed.test.js` + recorrido manual |
| `/search` | `<main>` y h1 | 1.3.1, 2.4.1 | No verificado | Fijado por test de fuente (`Tabs` pintado como `<main>` y un h1 oculto) | **Justificación**: `/search` exige sesión | `accessibilityStructure.test.js` + verificación con sesión |
| Explorer (error y no encontrado) | h1 | 1.3.1 | Cumple | `/public/entity/author/A9999999999`: h1 «Entity not found», con la serif que tenía el h2 | El Explorer no tiene `<main>` en ningún estado, tampoco cargado; aplazado | `accessibilityStructure.test.js` + recorrido manual |
| Páginas para rastreadores | Copia estática en `#root` | 1.3.1, 3.1.2 | Cumple (en workerd) | Un h1 con el título y, en un paper, `lang` en el artículo cuando el proveedor da el idioma; la app la sustituye al montar | La ve un rastreador que no ejecuta JavaScript; no se probó a través de Vercel | `worker/share-pages.test.js` + workerd |
| Global | Experiencia con lector de pantalla | 1.3.1, 4.1.2, 4.1.3 y demás | **No verificado** | Ninguna | **No se ha ejecutado ningún lector de pantalla real** en esta entrega | Fase 6 |

### Red de regresión

`src/accessibilityStructure.test.js` suma los cuatro h1 (feed de invitado, paper público,
`/search` y los errores del Explorer). `src/components/Layout/notFoundPage.test.js` y
`src/utils/spaRouteCoverage.test.js` cubren el «no encontrado» y el 404. Los avisos con
motivo tienen sus propios tests (tabla de arriba). `npm run check` pasa, y la suite pasa
también en Node 22.
