# Rediseño de la landing — diseño

**Fecha:** 2026-09-17 · **Estado:** aprobado por secciones en conversación; pendiente de plan
**Lienzo:** https://claude.ai/artifact/LMHhtB46VtsUy8t66eZiye (página 1 = la landing B; página *Motion* = los cuatro prototipos funcionando; página *Descartadas* = las direcciones A y C)

## 1. Por qué se rehace y no se reforma

La landing del worktree `landing-papertok` (12-09-2026, sin fusionar) se rechaza por cuatro
cosas a la vez, todas confirmadas por Nico: **no parece el producto** (un documento maquetado;
ninguna pantalla enseña la app), **el scroll a pantallazos** (snap obligatorio y tres pantallas
que capturan la rueda; quejas reales: «parece que no se completa», «tarda mucho desde que haces
scroll»), **vacía y monótona** (la misma plantilla siete veces, el tercio central de cada pantalla
de 900 px, tarjetas idénticas al final) y **sin identidad** (el amarillo, que es la marca, dos
veces en diez pantallas; eyebrows en mono mayúsculas, puntos medios, líneas de pelo).

**Se recicla:** el titular «Research you weren't looking for.»; la idea de marcar/subrayar
como *motivo* de la página; la voz (llano, verbos, sin *seamless/unlock*) y las trampas de hecho
ya cazadas (*Attention* no es preprint; la firma de LIGO incluye Virgo; «seis fuentes» es
afirmación de más); papers reales congelados en el build; el mazo del hero como idea; la rueda,
la secuencia del rewrite y la plancha del mapa como *objetos*; el cierre oscuro con botón
amarillo; la entrega prerenderizada y las sondas.

**Se tira:** el snap y toda captura de rueda (`graphHold.js`, el handoff), el anclaje de
Research (`researchAnchor.js`), las secciones de tarjetas, los eyebrows mono como sistema, la
plantilla h2-izquierda/demo-derecha. `page.js` y `landing.css` se reescriben.

## 2. Decisiones que siguen vigentes del 12-09

Inglés; `papertok.app/` es la landing y con sesión `/` redirige a `/feed` (**corregido tras la
ejecución: esta migración sí entra en el alcance de esta tarea y está hecha** — la marca
`papertok_signed_in` que escribe la app, la puerta en `index.html` resuelta antes del primer
pintado, `/feed` como segunda entrada de Rollup/`vercel.json`, y un deep link `#/…` que conserva
su hash; ver §9 y la tarea 12. Lo que sigue aparte, fuera de este alcance, es pasar las RUTAS
DE LA APP del fragmento a caminos reales — `/following`, `/research` — que es el trabajo de las
tareas 13 a 17 del plan, una PR distinta); primera persona para el origen y Samuel nombrado con
enlace; prueba social sin números; marcado real prerenderizado, entrada de Vite aparte
(`landing.html`), sin framer-motion; la clave `index` del input de Rollup no se toca.

**Nuevas:** sin figuras en ninguna parte (pedido dos veces); scroll normal; once tramos; el
amarillo con presupuesto; sin deslizar en táctil; el subrayado sobre tinta es un filete.

## 3. Estructura: once tramos

Una columna, scroll normal, `width: min(1200px, calc(100% - 40px))`. Cada tramo mide lo que
pide su contenido (≈ 7.200 px a 1440 medidos en el lienzo; ~9.000 px ≈ once pantallas a 390).

| # | Tramo | Contenido | Suelo |
|---|---|---|---|
| 0 | Barra | wordmark real (`Paper<span>Tok</span>`, banda `inset 0 -0.32em` amarilla), *Source* → repo, *Open the feed* → `/feed` | amarillo sobre el hero, papel después |
| 1 | **Hero** | h1 «Research you weren't looking for.» 92 px; lede «A feed of scientific papers from open, public sources. Scroll it the way you scroll anything else.»; botón *Open the feed* + «No account needed to look.» en frase; la **hoja** blanca (560 px, sombra `0 24px 60px rgba(17,19,24,.18)`) con el mazo de tres | amarillo `--brand-yellow` |
| 2 | **Search works when you already know what you're looking for.** | dos párrafos en primera persona («…so I built one.»), un subrayado en «the research you didn't know to search for»; a la derecha **la rueda** (13 huecos, barril, velo; 25 papers famosos) | papel |
| 3 | **One paper at a time.** | «A paper arrives full screen. Skip it, save it, or open it, and the next one gets closer to what you care about. It is not trying to find the most popular paper. It is trying to leave room for the unexpected.» + rejilla 3×2 de señales: nombre en Inter 500 15 px (*What you picked · What you did · Who you follow · How recent it is · Its record · A detour*) y frase en Newsreader 18 px | papel |
| 4 | **Read it in plain words.** | texto (tres niveles; lee el PDF entero; dice cuándo no puede; subrayar, anotar, preguntar; `.tex`) + **el lector** con la secuencia, un subrayado real dentro del texto y una nota en el carril | papel; el lector con marco |
| 5 | **Every card says what it is.** | cinco chips reales con una frase de 20 px en Newsreader: Verified · Preprint · Open access · Open version · Subscription | papel |
| 6 | **Follow the thread.** | «Authors, topics, institutions and projects. Following any of them opens a second feed made only of what they publish, next to the one made for you.» + tres filas del Explorer (un autor, un tema, una institución: Universidad de Salamanca) con *Follow* | papel |
| 7 | **Keep what matters.** | una línea sobre los ocho colores + las cuatro tarjetas de listas de la app tal cual (Favorites, Read later, Reading history, una pública con chip *Public*) y los ocho swatches `--list-*` | papel |
| 8 | **Every paper, on the map of what it came from.** | la plancha a todo el ancho: **cinco** nodos arriba (lo que cita), **dos** abajo (lo que le cita), eje log 1–10K, `THIS PAPER · 2016` a la **izquierda** del círculo con la regla cortada alrededor del par | papel |
| 9 | **Research: the week, set like a front page.** | la edición como **ventana estática** de ~880 px: cabecera, periodos, lead story, carril (cifras + *Growing topics* con **+69 % y +47 %**, corregidos), la forma de destacados cortada con fundido al 78 %; sin anclaje | papel; ventana con marco |
| 10 | Franja | tres párrafos en Newsreader 19 px: fuentes (las seis y «others fill in…», sin «six sources») · código abierto (`mugar123/papertok`, MIT) · «I started it in June 2026… Samuel Corsan joined in August and shaped how it looks.» | papel |
| 11 | Cierre + pie | «Start with a paper you didn't expect.» 64 px con filete amarillo bajo «you didn't expect.», botón amarillo, «No account needed to look.»; pie: wordmark, GitHub, Privacy, Español and English, Version 0.2 | tinta |

Los títulos de 6 y 7 salen del guion del vídeo de Samuel (`video/src/script.ts`).

## 4. Sistema visual

- **Materiales de la app, importados:** `variables.css` (tinta `#111318`, papel, `#f7f7f8`,
  hairline `#e6e7ea`, las doce tintas de campo, los chips con sus tintas), Newsreader para
  titulares y abstracts, Inter para cuerpo y UI, Plex Mono **solo dentro de la tarjeta y de las
  ventanas de la app** (meta, chips, rótulos del mapa y de la edición). Cero eyebrows en
  mayúsculas fuera de ellas; las etiquetas se escriben como frases.
- **Escala:** h1 92/0.98 a 1440 (44 a 390); h2 44/1.08 Newsreader **regular**; cuerpo 17/1.6;
  hoja 34/1.16; abstract 17/1.6 con capitular 2.9em en la tinta del campo; franja 19/1.5.
- **Amarillo, presupuesto cerrado:** suelo del hero (una vez); subrayado tres veces (tramo 2,
  dentro del lector en el 4, cierre); donde la app lo use dentro de una ventana (*Lead story*,
  botón de IA `#fff4c9`). Nada más.
- **El subrayado:** en claro, banda `box-shadow: inset 0 -0.42em 0 var(--brand-yellow)` con
  `box-decoration-break: clone`; **sobre tinta** (cierre y todo el tema oscuro) filete
  `text-decoration` 0,08 em, `text-underline-offset` 0,14 em, `skip-ink`. La banda al 42 %
  bajo letras blancas tapa media letra: rechazada tras verla.
- **Suelo blanco en todo** menos hero y cierre; las ventanas de la app (lector, edición) llevan
  marco de pelo sobre papel; el resto se separa con espacio, no con bandas grises.
- **Estructura como información:** líneas de pelo solo entre filas de listas (chips, Explorer);
  ninguna sección va en tarjeta. Las tarjetas de listas del tramo 7 son la UI del producto.
- **Enlaces** en tinta con subrayado `--border-strong`, `text-underline-offset: 3px`.

## 5. Contratos por pieza

**Mazo del hero.** Tres papers de `papers.js` (`HERO_PAPERS`): LIGO (Physics; Verified · Open
access), tardígrado (Biology; Verified · Open access), Card & Krueger (Economics; Verified ·
**Subscription**, sin open access). Abre con LIGO. Un carrete dentro de un hueco fijo (la altura
del paper más alto, medida en el build; 572 px a 34 px de título) con `overflow: hidden`.
Controles: botón **Skip** (icono `ban` + palabra, la acción de la app) al pie de la hoja con
indicador `1 / 3` en mono; con la hoja enfocada, ↓/↑ y j/k. **Sin deslizar en táctil.** Da la
vuelta (clon del primero al final; salto sin transición al terminar). Sin JS: primer paper y
Skip `hidden`. **Corregido tras la ejecución:** `createDeck` no se reutiliza de
`heroDeck.js` — ese módulo del prototipo era una máquina de gestos de rueda, ajena a este
contrato. `createDeck` es un módulo **nuevo y puro** (`src/landing/deck.js`: solo el índice, sin
DOM), con su propio `deck.test.js`; el driver del DOM (transición, teclado, foco) vive aparte en
`armDeck` (`motion.js`).

**Rueda.** Geometría y física del worktree (13 huecos, paso 9°, radio 330, `REACHES [14,16,18]`,
`TAU 380`, nunca el mismo alcance dos veces, semilla aleatoria). Gira una vez al entrar ≥ 50 %
en pantalla (IntersectionObserver, no geometría de pantallas: ya no hay snap) y otra al
pulsarla; los impulsos suman. Sin desenfoque. En móvil y con *reduced motion*: lista plana.

**Lector.** La secuencia existente (`motion.js`/`motion.css`): en reposo el texto terminado;
con movimiento, la tarjeta con el botón de IA y su coste, y al pulsar *Downloading the paper* →
*The model is reading the paper* → texto escribiéndose en *Beginner*, pestañas funcionando.
Nuevo: un subrayado dentro del texto («felt the same tiny stretch of space at the same moment»)
y una nota «Your note» con regla amarilla. La invitación del botón sigue apagada en oscuro.

**Mapa.** Plancha SVG de 1200×520 generada en el build desde datos congelados en `papers.js`,
y **congelados de una consulta real, no compuestos**: los primeros cinco de arriba y los dos de
abajo que esta spec listaba eran plausibles e inventados, y la página entera discute que
PaperTok no se inventa posiciones — se sustituyeron el 18-09 por lo que devuelve OpenAlex para
W2252795400. Cada lado se elige como lo elige la app, que **no es la misma regla dos veces**:
arriba, los cinco más **citados** de las 99 que cita (Acernese ’14 · Advanced Virgo, Kerr ’63,
Aasi ’15 · Advanced LIGO, Blanchet ’14, Abramovici ’92); abajo, los dos más **recientes** de las
14 526 que la citan, que el día de la consulta tenían cero citas propias (Eiroa ’26, Makihara
’26) — `worker/report-api.js` pide las citantes por `desc(creation)` y `publication_date:desc`,
y `RelatedPapersSheet.jsx` rotula las dos bandas exactamente así. Que los nodos nuevos caigan a
la izquierda del eje no es un hueco en los datos: es para lo que está el eje.
`x = min(1150, 300 + log10(c)·220)`; centro en `x=220` con el rótulo a la izquierda y la regla
cortada 16 px a cada lado del par; rótulos de esquina en mono («BEFORE · WHAT IT CITES»,
«5 MOST CITED OF 99», «AFTER · WHAT CITES IT», «2 MOST RECENT OF 14,526»). Bajo 700 px, una
segunda plancha compuesta en el build con menos nodos y eje de tres marcas, no un SVG escalado.

**Research.** Marcado de la edición reutilizado (`RESEARCH` de `papers.js`) dentro de una
ventana de 880 px con `overflow: hidden` y máscara al 78 %; porcentajes recalculados a partir
de los recuentos (882/523 → +69 %, 641/436 → +47 %); la suma de citas de la selección es la real.

## 6. Movimiento

Decidido con la skill `animate` (puerta → propósito → herramienta → propiedades → curva →
interrupción → *reduced motion*). Curva única: `--ease-out-cubic` (0.33, 1, 0.68, 1), el token
de la app; nada se inventa.

| Pieza | Puerta · propósito | Ingredientes |
|---|---|---|
| Mazo | ocasional · continuidad espacial | transición CSS de `transform` en el carrete, 400 ms, sin opacidad; retarget si se pulsa dos veces; *reduced motion*: cambio instantáneo |
| Rueda | rara · explicación | rAF con la fórmula real; solo rota el barril y se reescriben 13 rótulos al cruzar cada muesca; `will-change: rotate` solo mientras gira |
| Mapa | rara · explicación | animaciones CSS al añadir `is-in`: radios `stroke-dashoffset` 1→0 (`pathLength=1`), nodos `opacity` 0→1 + `scale(.6→1)` (`transform-box: fill-box`), rótulos solo opacidad; 320 ms, escalonado 70 ms por `--i` en el propio elemento; orden: centro, citados de viejo a nuevo, citantes; ~1,1 s |
| Subrayado | rara · el recurso de la página | `background-size` 0→100 % en 480 ms (pintado, no layout); en oscuro filete estático |
| Botón de IA | existente | la respiración de 2,8 s, apagada en oscuro (`keyframeContrast.test.js`) |
| Hover | tens/día · casi imperceptible | color 150 ms, solo `(hover: hover) and (pointer: fine)` |

**Rechazado:** entradas por sección (fade + slide-up): la página se lee entera desde el primer
pintado. **Puerta de movimiento:** como hoy, decidida antes de pintar (`data-motion` si hay
IntersectionObserver, sin *reduced motion*, ≥ 768 px, puntero fino); el mazo y el lector
responden al usuario y solo dependen de JS, no del puntero.

## 7. Móvil (390)

Barra amarilla; h1 44; lede; botón a todo el ancho; la hoja a todo el ancho con Skip. La rueda
se anula (lista plana de siete con el del centro entre dos reglas). Señales a dos columnas. El
lector sin secuencia. Chip encima de su frase. Explorer en filas. Listas 2×2, swatches bajo el
texto. La plancha de móvil del mapa. Research apilada con el mismo corte. Franja en tres
párrafos. Cierre. Objetivo ≈ 9.000 px; Research es lo primero que se recortaría.

## 8. Tema oscuro

La landing sigue el tema del visitante con el mismo espejo `data-theme` de `index.html`,
resuelto antes de pintar. Hero y cierre idénticos en ambos temas. Los tramos blancos toman los
tokens oscuros de `variables.css`. Chips con placa tintada oscura (ya en la app). El subrayado
es filete. La invitación del botón apagada. Test de contraste en los dos temas para el
subrayado y la invitación.

## 9. Construcción

- **Worktree `landing-rediseno`, desde main.** Del worktree viejo (`landing-papertok`, base
  `c87be1f`, sin commitear) se **copia**: el plugin `papertok-landing-prerender` y el input de
  `vite.config.js`; la cabeza de `landing.html` (espejo de tema y puerta de movimiento);
  `papers.js` como datos (+ vecinos del mapa, señales, entidades del Explorer, listas); la
  secuencia del rewrite con `rewriteMotion.test.js` y `keyframeContrast.test.js`; el driver de
  la rueda (`armPile`, `WHEEL`) + `landing-wheel-audit.mjs`; `citationPlate` de `graphMap.js` +
  `graphMap.test.js`. Se **tira**: `graphHold.js`, `handoff.test.js`, `researchAnchor.js` y su
  test, el scroller, y `heroDeck.js` — el mazo del prototipo era una máquina de gestos de
  rueda; nada de él sobrevive (ver **Corregido**, abajo, y §5).
- **Reutiliza** `src/legal/privacy.css` (PR #38) para barra, botones y pie: una sola hoja de
  página estática compartida, no dos.
- **Nuevo:** `page.js` (once tramos), `landing.css` (sin scroller ni capturas), `deck.js`
  (`createDeck`, el índice del mazo, puro y sin DOM — **no** es el `heroDeck.js` del prototipo,
  pese a lo que decía una versión anterior de este documento) con su driver del DOM en
  `motion.js` (`armDeck`: clic/teclado/vuelta), dibujado del mapa (`is-in` por
  IntersectionObserver), plancha de móvil, subrayado con trazado.
- **Corregido tras la ejecución (tarea 12):** este documento decía que `createDeck` se
  reutilizaba de `heroDeck.js`. Falso — se escribió desde cero como módulo puro; ver §5 y la
  entrada de «Nuevo» arriba.
- **Tests (`node --test`):** estructura (once tramos en orden; cero `scroll-snap`; el amarillo
  solo en hero, tres subrayados y ventanas; ningún `.lp-eyebrow` fuera de tarjeta; sin figuras);
  mazo (vuelta, teclado, *reduced motion*, hueco ≥ paper más alto); contraste de subrayado e
  invitación en los dos temas; porcentajes de Research = recuentos; nodos del mapa dentro de
  la plancha (`x ≤ 1150`).
- **Sondas:** `scripts/diagnostics/landing-shots.mjs` (rebanadas por CDP a 1440/1280/390, claro
  y oscuro — el `shots.mjs` del scratchpad), `landing-invite-contrast.mjs`,
  `landing-wheel-audit.mjs`. Verificar siempre a más de un viewport.
- **Presupuesto:** prerenderizado; ≤ 30 KB gz (hoy 16).
- **Fuera de alcance:** el vídeo; figuras; y, **distinto de lo que decía una versión anterior de
  este documento**, pasar `/` a la landing y la redirección con sesión a `/feed` **sí entraron**
  (ver §2 y la tarea 12) — lo que de verdad queda fuera es la migración de las RUTAS DE LA APP
  del fragmento a caminos reales (`/following`, `/research`, …), que son las tareas 13 a 17 del
  plan y una pull request distinta a la de esta landing.

## 10. Criterios de aceptación

1. `landing.html` construido: 0 apariciones de `scroll-snap`; 11 `<section>` en el orden del §3.
2. Amarillo: `--brand-yellow` como fondo solo en `.lp-hero` y el botón del cierre; `.lp-hl`
   exactamente tres veces; ningún otro uso fuera de `.lp-reader`/`.lp-research`.
3. Sin `<img>` ni placas de figura. **Enmendado en la tarea 8:** sí hay tres `<figure>`, que son ventanas de la app con su `<figcaption>` — la decisión de Nico fue «quita las imágenes», y un `<figure>` sin imagen es marcado, no una imagen.
4. Mazo: tres slides + clon; Skip avanza y da la vuelta; ↓/↑ con foco; `hidden` sin JS.
5. Rueda: gira al entrar y al pulsar; nunca `preventDefault` sobre `wheel`.
6. Mapa: 5 + 2 nodos, rótulo del centro a la izquierda, regla cortada; dibujado una vez.
7. Contraste ≥ 4,5:1 en el subrayado y en el pico de la invitación, en claro y en oscuro.
8. Sin `text-transform: uppercase` fuera de la lista blanca de `page.test.js`, que nació con tres nombres (`.lp-paper`, `.lp-plate`, `.lp-research`) y terminó con ocho: cada añadido queda razonado en el comentario del propio test, y la comprobación cubre las tres hojas.
9. ≤ 30 KB gz; 0 peticiones a hosts externos. Lo mide `npm run budget:landing`, dentro de `npm run check`: medido a mano una vez, el siguiente retoque de texto se lo come sin que nada se ponga rojo.
10. Capturas a 1440, 1280 y 390 en los dos temas revisadas antes de dar nada por bueno.
