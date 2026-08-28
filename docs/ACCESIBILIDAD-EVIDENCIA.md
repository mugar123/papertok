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

### Dos artefactos del entorno que condicionan las lecturas

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

### Matriz

| Página o flujo | Componente | Criterio WCAG | Resultado | Evidencia | Defecto o limitación | Reprueba |
|---|---|---|---|---|---|---|
| Global | `variables.css` (tokens de foco y texto) | 1.4.3, 1.4.11 | Cumple | `src/styles/contrast.test.js` (20 aserciones, ambos temas) | — | `npm test` |
| Global, tema claro | `global.css` `:focus-visible` + anillos migrados | 2.4.7, 1.4.11 | Cumple | Recorrido `Tab` en `/`: 8 paradas seguidas (recargar, ES, tema, buscar, entrar, píldora de tema, autores ×3, «et al.», abstract, «Read article»), todas con `outline: rgb(180,83,9) 2px solid` = `--focus-ring` `#b45309`. Capturas | Solo verificado en `/`; las rutas con sesión no se recorrieron | Recorrido manual + `src/accessibilityStructure.test.js` |
| Global, tema oscuro | ídem | 2.4.7, 1.4.11 | Cumple | Con `data-theme="dark"`, los 7 controles medidos leen `rgb(255,157,0)` = `#ff9d00`; captura del anillo ámbar sobre fondo tinta | El tema se forzó por atributo, no con el conmutador de la cabecera | Recorrido manual |
| `/` (invitado) | `global.css` `.skip-link` — existencia y destino | 2.4.1 | Cumple | `Shift+Tab` desde `#main-content` enfoca el enlace (es el primer tabulable del documento); `Enter` deja `document.activeElement.id === "main-content"` | Al activarlo, la URL queda en `#main-content` (la app usa `HashRouter`). Verificado que la ruta sigue operativa y que `/login` e ida y vuelta siguen funcionando después | Recorrido manual |
| `/` (invitado) | `.skip-link` — visibilidad al recibir el foco | 2.4.7, 2.4.11 | Cumple **tras corrección** | Antes: el enlace enfocado estaba en `top: 8px` pero `elementFromPoint` sobre su centro devolvía `DIV.guest-wordmark` — pintado por encima y por tanto invisible. Después: devuelve `A.skip-link`, y la captura muestra el enlace | **Defecto encontrado y corregido en esta tarea**: `z-index: calc(var(--z-toast) + 1)` = 401 frente a `.guest-feed-header` con 900. Ahora `z-index: 1100` | Recorrido manual + captura |
| Feed | `PaperCard` — nombres de autor como botones | 2.1.1, 4.1.2 | Cumple | `Tab` alcanza los tres botones; anillo **interior** (`outline-offset: -1px`) visible y sin recorte por `.pc-author-names` (captura); al activarlo navega a `#/public/entity/author/Darby%20M.%20Kramer` y el foco aterriza en `#main-content` | Activación con `.click()`; `Enter` real no reproducible (artefacto 2) | Recorrido manual |
| Feed | `PaperCard` — separador entre autores | 4.1.2 | Cumple **tras corrección** | `textContent` de los botones: `"Darby M. Kramer"`, `"Alexander van Engelen"`, `"Frank J. Qu"`; la fila lee `Darby M. Kramer, Alexander van Engelen, Frank J. Qu et al.` | **Regresión encontrada y corregida en esta tarea**: al convertir los `<span>` en `<button>` (inline-block), el espacio final de `", "` se recortaba y se leía «Kramer,Alexander» y «Quet al.». El separador pasa fuera del botón, lo que además lo saca del nombre accesible | Recorrido manual |
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
| Global | Experiencia con lector de pantalla | 1.3.1, 4.1.2, 4.1.3 y demás | **No verificado** | Ninguna | **No se ha ejecutado ningún lector de pantalla real** (ni VoiceOver ni NVDA). La experiencia con tecnología de apoyo NO está verificada, y ningún «Cumple» de esta matriz debe presentarse a terceros como conformidad hasta que se haga | Fase 6 |
| Global | Zoom 200 %, reflujo a 320 px, espaciado de texto | 1.4.4, 1.4.10, 1.4.12 | **No verificado** | Ninguna | No se probaron. El recorrido móvil se hizo a 375 px, que no es el ancho de reflujo que exige 1.4.10, y no se alteró ni el tamaño ni el espaciado del texto | Fase 6 |

### Correcciones hechas durante esta verificación

Las dos las encontró el recorrido en vivo; ninguna la habría cazado un test
automático de los que había.

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

### Red de regresión

- `src/styles/contrast.test.js` — contraste de los tokens (fase 1).
- `src/utils/routeMetadata.test.js` — títulos y etiquetas de ruta (fase 1).
- `src/accessibilityStructure.test.js` — **nuevo en esta tarea**: skip link y su
  destino, `#main-content` con `tabIndex={-1}`, `RouteAnnouncer` montado, `<nav>`
  con nombre, `aria-current` en «Para ti», landmark del feed opt-in (para que la
  ruta de invitado no acabe con dos `<main>` anidados), ninguna supresión nueva
  del anillo de foco y ningún anillo pintado en `--brand-orange`.

Cada aserción se comprobó rompiendo a propósito lo que vigila, sobre una copia
del árbol: las siete fallan cuando deben, con su mensaje.

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
