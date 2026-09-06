# Transición tarjeta → página de entidad — diseño

**Fecha:** 2026-09-06
**Estado:** aprobado en conversación; pendiente de plan
**Alcance:** `PageTransition` (todas las rutas la usan), la barra en `/explorer/*`, y la maquetación de la página de entidad bajo la barra. Nada dentro de la coreografía propia del Explorer (héroe, esqueleto, paneles) cambia: eso quedó cerrado en `docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md`, cuyo hallazgo A12 es exactamente este trabajo.

## 1. Qué pasa hoy

Medido con sesión (semilla demo, `IS_DEMO` local), chunk del Explorer ya caliente, un fotograma cada ~16 ms, en móvil (390×844) y escritorio (1280×900), con el guion de screencast por CDP (`Page.startScreencast`, hoja de contactos en el scratchpad de la sesión: `demo-mobile-author-sheet.png`, `demo-desktop-author-sheet.png`, `demo-desktop-topic-sheet.png`).

| Qué se ve | Causa en el código |
| --- | --- |
| La barra de navegación desaparece en el fotograma siguiente al toque y deja una franja vacía sobre la tarjeta | `showNavbar` en `App.jsx` no incluye `/explorer/*`; la barra vive fuera de `AnimatePresence`, así que se desmonta en el mismo commit que la navegación |
| Dos fotogramas sin ninguna página pintada (208–248 ms) y un fotograma perdido en el traspaso (237→270 ms) | `AnimatePresence mode="wait"`: el feed tiene que terminar de irse antes de que la entidad empiece a existir |
| El feed se disuelve en el sitio mientras la entidad entra deslizando 18 px desde la derecha, a página completa y desde el borde superior | Dos geometrías distintas para un solo movimiento; la entidad no sabe que hay barra porque no la hay |
| La salida acelera al final | `EASE_LEAVING = [0.4, 0, 1, 1]` es un ease-in, puesto para tapar el hueco del modo `wait` |
| Unos 500 ms de toque a página quieta | 200 ms de salida + hueco + 300 ms de entrada, en serie |
| El aviso de consentimiento de analítica sigue a su ritmo por encima de todo | Está fuera de la transición; **fuera de alcance**, ver §8 |
| El modal «What are you into?» del invitado se queda sobre la página nueva | Defecto aparte; **fuera de alcance**, ver §8 |

Además, el desplazamiento usa el atajo `x` de framer, que no va por compositor, y la entrada de la página y la subida del héroe corren en ejes distintos.

## 2. Decisiones tomadas

1. **La barra se conserva** en las páginas de autor, tema, institución y proyecto para el usuario con sesión, como ya hacen paper, perfil y lista («no sentir que sales de la app»). El invitado sigue viendo la página sin barra. El botón de volver del héroe se queda.
2. **Superposición bajo la barra fija.** Las dos páginas conviven durante la transición. Descartados el empuje tipo iOS (carrusel en escritorio, mueve toda la capa del feed, promete un gesto que no existe) y el elemento compartido chip→título (proyecciones `layout` sobre una página de 1300 px, aterrizaje sobre esqueleto).

## 3. Puerta de `/animate`

- **Frecuencia:** ocasional (abrir una entidad desde una tarjeta, unas pocas veces por sesión). Se anima.
- **Propósito:** evitar un cambio brusco, y hacer legible la jerarquía (entras en algo, y al volver sales de ello).
- **Herramienta:** animación CSS (`@keyframes`) para todo el movimiento: es predeterminado y tiene que seguir fluido mientras la página nueva monta 1300 px de contenido. framer-motion se queda solo como contable de presencia (`AnimatePresence`, `usePresence`, `usePresenceData`).
- **Propiedades:** `opacity` y `transform` (`translateY`, `translateX`). Nada más.
- **Curva:** `cubic-bezier(0.16, 1, 0.3, 1)`, la expo-out que ya usa toda la app (`pcArrive`, `slideUpFade`, `.explorer-error`). Pasa a ser un token, `--ease-out-expo`, en `src/styles/variables.css`; los literales existentes no se tocan. Ninguna salida usa ease-in.
- **Duraciones:** dentro de la banda de 300 ms (§5).
- **Interrupción y salida:** cada página sale por donde entró (la entidad sube al llegar y baja al irse). Una navegación durante una transición no rompe nada: cada página saliente se gestiona sola (§6).
- **Movimiento reducido:** solo opacidad, 120 ms. Nunca cero.

## 4. La barra y la página de entidad debajo

**`src/App.jsx`.** `showNavbar` añade `normalizedPathname.startsWith('/explorer/')` a la lista de rutas con barra, con las mismas guardas que hoy (`user`, `!authLoading`, `onboardingComplete`, `!profileLoadError`). La ruta `/explorer/:type/:id` pasa `appChrome={showNavbar}` a `EntityExplorer`. La ruta `/public/entity/:type/:id` no pasa nada (sin barra, como hoy).

**`src/components/Explorer/EntityExplorer.jsx`.** Nueva prop `appChrome` (booleana, por defecto `false`). Las tres raíces que el componente puede devolver — el esqueleto (`explorer-container explorer-skeleton…`), el error (`explorer-error`) y la página viva (`explorer-container`) — añaden la clase `explorer--app` cuando `appChrome` es verdadero. Una prop desde App, y no una copia de la condición como hace `PublicListPage`, para que solo haya una fuente.

**`src/components/Explorer/EntityExplorer.css`.** Reglas nuevas, todas bajo `.explorer--app`:

```css
.explorer--app { padding-top: var(--nav-total); }           /* border-box global: min-height 100dvh sigue valiendo */
.explorer--app .explorer-hero { padding-top: var(--space-5); } /* la barra ya cubre la muesca */
.explorer--app .explorer-toolbar-wrapper { top: var(--nav-total); }
@media (max-width: 768px) { .explorer--app .explorer-hero { padding-top: var(--space-4); } }
```

`.explorer-error.explorer--app` conserva `height: 100dvh`: con `box-sizing: border-box` y el `padding-top`, el centrado queda en el área bajo la barra. Sin barra nada cambia.

## 5. La coreografía

Una regla: **la página más profunda va encima; la otra se queda debajo, quieta y opaca.** Nunca se disuelven las dos a la vez, así que no hay bajón de brillo ni fotograma sin página.

| Navegación (`direction`, `lateral`) | Página que llega | Página que se va |
| --- | --- | --- |
| Push a más profundidad (`1`, `false`): tarjeta → entidad, entidad → entidad, lista → entidad | **`enter`**, encima. Opacidad 0→1 y `translateY(10px)`→0, **220 ms**, `--ease-out-expo` | **`hold`**, debajo. Retenida opaca y quieta 220 ms |
| Vuelta (`-1`) | **`rest`**, debajo. Sin animación; las tarjetas del feed en reposo (`[data-nav-direction="-1"]` en `PaperCard.css`, sin cambios) | **`leave`**, encima. Opacidad 1→0 y 0→`translateY(10px)`, **180 ms**, `--ease-out-expo` |
| Pestaña a pestaña (`±1`, `true`) | **`enter-lateral`**, encima. Opacidad 0→1 y `translateX(direction × 10px)`→0, **180 ms** | **`hold`**, debajo, 220 ms |
| Replace o primera entrada (`0`) | **`rest`** | **`fade`**, encima. Solo opacidad, **150 ms** |
| `prefers-reduced-motion: reduce` | `enter` y `enter-lateral`: solo opacidad, **120 ms** | `leave` y `fade`: solo opacidad, 120 ms; `hold`: 120 ms |

Las duraciones viven como propiedades personalizadas en la raíz de la transición (`--page-enter-ms: 220ms`, `--page-leave-ms: 180ms`, `--page-lateral-ms: 180ms`, `--page-fade-ms: 150ms`, `--page-hold-ms: 220ms`, `--page-reduced-ms: 120ms`) y solo ahí. `hold` dura lo que la entrada más larga: la página retenida no sabe cuál corre encima, y un desmontaje 40 ms tarde bajo una página ya opaca es invisible.

Lo que desaparece: `TRAVEL_PX`, `ENTER_MS`, `EXIT_MS`, `LATERAL_*`, `EASE`, `EASE_LEAVING`, `routeVariants`, `reducedMotionVariants`, el `motion.div`, el atajo `x`, `useReducedMotion` en este componente.

## 6. La mecánica de `PageTransition`

**`src/App.jsx`.** `<AnimatePresence mode="sync" initial={false} custom={pageTransitionCustom}>`. `initial={false}` se queda: es lo que hace que los `motion` internos de la primera página no reproduzcan su `initial` en el arranque. `custom` se queda: es el canal oficial (`usePresenceData`) por el que el hijo que sale lee la navegación que lo echa. El comentario de cabecera de `App.jsx` que explica el modo `wait` y el `Suspense` se reescribe con lo de abajo.

**`src/components/Layout/PageTransition.jsx`** deja de ser un `motion.div` y pasa a ser un `div` con atributos:

- `data-nav-direction={direction}` — se mantiene tal cual; `PaperCard.css` y `explorerEntrance.test.js` lo leen.
- `data-page-motion` — una de `enter`, `enter-lateral`, `rest`, `hold`, `leave`, `fade`, calculada por un módulo puro (§7) a partir de `direction`, `lateral` y `present`.
- La dirección se lee de `usePresenceData()` (lo que `AnimatePresence` entrega al hijo que sale) y, si no hay contexto de presencia, del proveedor `usePageTransitionCustomValue()` que ya existe. El componente sigue sin calcular nada por sí mismo.
- `present` viene de `usePresence()`; `safeToRemove` se llama cuando termina la animación de salida.

**Geometría, desde el render.** La página que se va se saca del flujo en el mismo render en que `present` pasa a falso, sin fotograma intermedio: `position: fixed; left: 0; right: 0; z-index: 1` desde el CSS, y `top` en línea igual a menos el scroll de la ventana que tenía. Ese scroll se lleva en una ref alimentada por un oyente `scroll` pasivo que solo está suscrito mientras `present` es verdadero: se retira en la limpieza del efecto, en el mismo commit en que la página deja de estar presente, antes de que el reset de scroll de la página entrante dispare su propio evento. (Leer `window.scrollY` en el render de salida no vale: en un `popstate` ya puede ser el valor que el navegador acaba de restaurar.) Así, volver desde una entidad a media página no la hace saltar a su cabecera mientras se desvanece. La página que entra con animación lleva `position: relative; z-index: 2` solo mientras anima; al terminar pasa a `rest` y pierde posición y z, para no dejar un contexto de apilamiento que capture al lector fijo de paper (`.rd`) o a cualquier otro fijo interno. Ambos índices quedan por debajo de `--z-nav` (100).

**Scroll de la ventana.** En el montaje, si `direction !== 0`, `window.scrollTo({ top: 0, behavior: 'instant' })` en un layout effect. Hoy toda página nueva aparece arriba porque el documento se vacía entre salida y entrada; con las dos conviviendo, el documento nunca se vacía y el scroll de una entidad pasaría a la siguiente. `'instant'`, porque `html { scroll-behavior: smooth }` convertiría el reset en un desplazamiento visible. El feed no se ve afectado: su scroll es interno y lo restaura `feedResumeMemory`.

**Fin de la animación.** Un solo `onAnimationEnd` en la raíz, que ignora todo evento cuyo `target` no sea la raíz (las tarjetas y el héroe emiten los suyos, y suben). Página entrante: `data-page-motion` pasa a `rest`. Página saliente: `safeToRemove()`. Reloj de seguridad de `EXIT_SAFETY_MS = 700` ms desde que `present` es falso, que llama a `safeToRemove` si el `animationend` no llegó (pestaña en segundo plano, animación cancelada). El reloj se limpia si `present` vuelve a verdadero (navegar de vuelta a la misma clave mientras salía): entonces la página vuelve a calcular su movimiento y sigue.

**Chunk frío.** Cada `PageTransition` envuelve a sus hijos en su propio `<Suspense fallback={<RouteFallback />}>`. Un chunk que no está en caché suspende solo a la página que llega, dentro de su raíz, y la retenida sigue en pantalla; `RouteFallback` conserva su retraso de 320 ms. El `Suspense` exterior de `App.jsx` se queda como red. El Explorer está precargado en reposo (`EntityExplorer.preload()`), así que el caso frío es el toque en los primeros segundos o una conexión que pide ahorro de datos.

**`src/components/Layout/PageTransition.css`** (nuevo, importado por el componente): las propiedades de duración, las reglas por `data-page-motion`, los `@keyframes` (`pageEnter`, `pageEnterFromRight`, `pageEnterFromLeft`, `pageLeave`, `pageFade`, `pageHold`, `pageFadeIn`, `pageFadeOut`) y el bloque de movimiento reducido. Todas las animaciones con `animation-fill-mode: both`, para que una página cuya animación arranca un fotograma tarde no parpadee opaca antes de su fundido. Los keyframes terminan en `transform: none`, y el atributo se retira al terminar, así que ninguna transformación sobrevive a la transición.

## 7. Módulo puro

`src/components/Layout/pageMotion.js`:

```js
/** 'enter' | 'enter-lateral' | 'rest' | 'hold' | 'leave' | 'fade' */
export function pageMotionFor({ direction, lateral, present }) { … }
export const EXIT_SAFETY_MS = 700;
```

Tabla de verdad, que es también su test de comportamiento (`pageMotion.test.js`):

| `present` | `lateral` | `direction` | Resultado |
| --- | --- | --- | --- |
| true | false | 1 | `enter` |
| true | true | 1 o -1 | `enter-lateral` |
| true | false | -1 | `rest` |
| true | cualquiera | 0 | `rest` |
| false | true | 1 o -1 | `hold` |
| false | false | 1 | `hold` |
| false | false | -1 | `leave` |
| false | cualquiera | 0 | `fade` |

Entradas fuera de rango (`direction` no numérica, `lateral` no booleana) se tratan como `0` y `false`. Precedencia: primero `present`, después `direction === 0` (gana `rest` o `fade` aunque `lateral` sea verdadero), después `lateral`, y por último el signo de `direction`.

## 8. Fuera de alcance

- **El aviso de consentimiento de analítica** (`AnalyticsConsentBanner`, fuera de `AnimatePresence`) y **el modal de intereses del invitado**, que persiste sobre la página nueva. Ambos son defectos propios con su reloj; se anotan, no se tocan.
- **Restauración del scroll al volver a Listas** o a cualquier documento largo: hoy no funciona (el documento se vacía antes de que el navegador pueda restaurar) y este diseño mantiene la paridad (toda página nueva arriba).
- **Elemento compartido chip → título del héroe**: capa de deleite futura, sobre esta base.
- **La pestaña entre feeds** hereda la mecánica (`enter-lateral` + `hold`) y pierde el hueco de 184 ms medido en su día. Se mide para confirmar que no empeora; no se rediseña.

## 9. Pruebas

**Comportamiento.** `pageMotion.test.js`: la tabla de §7 entera, más las entradas fuera de rango, más `EXIT_SAFETY_MS` mayor que cada `--page-*-ms` leído de `PageTransition.css` (parseando `--page-([a-z-]+)-ms: (\d+)ms`).

**Fuente** (convención de `ce139ce`: despojar comentarios, capturas acotadas, asertos que un cambio equivocado haría fallar):

- `pageTransition.test.js` se reescribe: `App.jsx` monta `<AnimatePresence mode="sync" initial={false} custom={pageTransitionCustom}>` y sigue siendo el único llamador de `usePageTransitionCustom()`; `PageTransition.jsx` no importa `motion` ni `useReducedMotion`, no contiene `variants`, `x:` ni `ease-in`; lleva `data-nav-direction={direction}` y `data-page-motion=`; llama a `safeToRemove` desde `onAnimationEnd` con la guarda `event.target !== rootRef.current`; envuelve a los hijos en `Suspense` con `RouteFallback`; el reset de scroll usa `behavior: 'instant'`. `PageTransition.css`: cada `--page-*-ms` ≤ 300; ningún `cubic-bezier` con primer par `(0.4, 0` ni la palabra `ease-in`; bloque `prefers-reduced-motion` que redefine las seis; ningún keyframe anima `width`, `height`, `top`, `left`, `margin` ni `padding`.
- `explorerEntrance.test.js` sigue pasando sin cambios (el atributo `data-nav-direction` sobrevive).
- Nuevo aserto en un test del Explorer: `App.jsx` pasa `appChrome={showNavbar}` a `EntityExplorer` en `/explorer/:type/:id` y `showNavbar` incluye `startsWith('/explorer/')`; `EntityExplorer.css` tiene las cuatro reglas `.explorer--app` de §4.

**Medida.** Antes y después con el guion de screencast, con sesión, en móvil y escritorio, tarjeta → autor, tarjeta → tema, autor → volver, y pestaña For you → Research. Criterios de aceptación:

| Criterio | Hoy | Objetivo |
| --- | --- | --- |
| Fotogramas sin barra durante la transición | todos menos el primero | 0 |
| Fotogramas sin ninguna página pintada | 2 | 0 |
| Toque → entidad quieta, chunk caliente | ≈500 ms | ≤ 260 ms |
| Movimiento del feed durante la ida | se disuelve en el sitio | ninguno: retenido opaco |
| Vuelta: tarjetas del feed | en reposo | en reposo |
| Pestaña: hueco entre páginas | hasta 184 ms (medido antes) | 0 |

Las cifras medidas se añaden a este documento en una sección «Después».

## 10. Riesgos conocidos

- **Entidad → entidad → volver.** Si el navegador despacha el `scroll` de su propia restauración antes del render de salida, la página que se va se desplaza durante sus 180 ms. La ref alimentada por `scroll` es la mejor lectura disponible; se comprueba en la medida.
- **Doble subida en el héroe.** La página sube 10 px en 220 ms y el héroe vivo sigue con su `slideUpFade` de 420 ms (solo opacidad, desde 0.35). No se solapan en eje; si en la medida se lee como un escalón, es una decisión aparte sobre el Explorer, no sobre esta transición.
- **`mode="sync"` con navegaciones rápidas.** Pueden convivir tres raíces (dos saliendo, una entrando); cada una se limpia sola y el reloj de seguridad cubre el evento perdido.

## 11. Después (medido el 2026-09-06)

Con `scripts/diagnostics/page-transition-frames.mjs`, build de demo local, chunk caliente, muestreo por `requestAnimationFrame` y screencast por CDP. Las hojas de contactos y las muestras quedan en `.superpowers/measure-transicion/` de la sesión que lo midió (ignorado, no se commitea).

| Escenario | Fotogramas con barra | Fotogramas vacíos | Fotogramas con dos páginas | Quieta a los |
| --- | --- | --- | --- | --- |
| Tarjeta → autor, escritorio | 84/84 | 0 | 16 | 293 ms |
| Tarjeta → autor, móvil | 83/83 | 0 | 16 | 305 ms |
| Tarjeta → tema, escritorio | 83/83 | 0 | 15 | 299 ms |
| Autor → volver, escritorio | 85/85 | 0 | 13 | 226 ms |
| Autor → volver, móvil | 85/85 | 0 | 13 | 229 ms |
| Autor a 600 px → volver, escritorio | 85/85 | 0 | 13 | 221 ms |
| For you → Research, escritorio | 84/84 | 0 | 16 | 294 ms |

Frente a los criterios de §9: barra en todos los fotogramas, cumplido en los siete (0 fotogramas sin barra, frente a «todos menos el primero» de hoy); cero fotogramas vacíos, cumplido en los siete (frente a 2 de hoy); entidad quieta antes de 260 ms, cumplido solo en las tres vueltas (226, 229, 221 ms) y no en las tres entradas ni en la pestaña (293–305 ms, 33–45 ms por encima del objetivo: la página retenida —`hold`— no se retira del DOM hasta que su propia animación de 220 ms termina y dispara `safeToRemove`, así que el fotograma de una sola página con `data-page-motion` en `rest` llega uno o dos `requestAnimationFrame` después de que opacidad y transform de la que entra ya están en su valor final; en la vuelta no hay ese paso porque la página retenida nunca animó y ya estaba en reposo); feed retenido sin moverse durante la ida, cumplido (opacidad 1 y `transform: none` constantes en las cuatro hojas de ida, sin un solo fotograma en que la que se queda cambie); tarjetas en reposo al volver, cumplido (`motion: rest`, opacidad 1 y `transform: none` constantes en las tres vueltas); pestaña sin hueco, cumplido (16 fotogramas con las dos páginas y 0 vacíos, frente a los ≈184 ms medidos antes).

Lo que las hojas enseñan y las cifras no: las siete `-sheet.png` salieron con `ERR_INVALID_URL` porque el guion navega a `file://` con la ruta de `OUT` tal cual, y con el `OUT` relativo que pide este mismo paso Chrome no resuelve esa URL; la revisión se hizo igual, abriendo cada `-sheet.html` (intacto) por un servidor estático efímero y los fotogramas sueltos de `<label>-frames/`. Con eso a la vista: el héroe de autor no muestra un escalón perceptible entre el fotograma recién asentado (296 ms, con el esqueleto) y uno con datos ya cargados (1546 ms) — título y chips ocupan la misma posición, así que el riesgo de la doble subida (§10) no se manifestó en esta pasada. En la vuelta con scroll, la página saliente mantiene `top: "-600px"` en los 13 fotogramas en que aún existe, sin saltar nunca a su cabecera antes de desvanecerse, así que tampoco se vio el riesgo de la restauración de scroll (§10). El aviso «Ayúdanos a mejorar PaperTok» sigue apareciendo sobre la página nueva en las siete capturas, como ya anota §8.
