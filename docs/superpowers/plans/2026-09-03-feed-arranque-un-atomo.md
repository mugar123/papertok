# Un solo átomo del arranque a la primera tarjeta (2026-09-03)

Objetivo: que el relevo entre la animación de carga del átomo y el feed
principal sea continuo, en móvil y en escritorio.

## Auditoría

Medido con `scripts/diagnostics/explorer-loading-probe.mjs bootload` (Chrome
sin cabeza por CDP, un muestreo por frame del DOM y de las opacidades
calculadas), en local (`localhost:5173`) y en producción (`papertok.app`),
antes de tocar nada:

1. **Dos átomos, un corte.** La puerta de auth (`ProtectedRoute`) pintaba un
   átomo propio (`InitialFeedLoading`, «PaperTok») y, al resolverse la
   sesión, React lo sustituía en un solo frame por el árbol del feed. El
   veil del feed (`1c01d24`) es otro SVG: los electrones vuelven al inicio
   de la órbita, el texto cambia y, al ser más alto, el átomo sube un
   escalón. En local el corte fue a los 249→278 ms; en producción, 679→770.
2. **Nada tapaba el corte.** `AnimatePresence initial={false}` (App.jsx)
   anula la entrada de `PageTransition` en el primer render: medido,
   opacidad 1,00 y `transform: none` en el primer frame del feed.
3. **Con snapshot, un átomo fantasma.** Los papers restaurados llegan un
   tick después de montar, así que el veil aparecía un frame y salía en
   0,42 s: un átomo tenue justo después del sólido que acababa de cortarse.
4. **La barra aparecía de golpe** en el mismo frame que resolvía la sesión.

## Plan

1. `ProtectedRoute` en `/` entrega sus hijos mientras carga la sesión: el
   veil de `FeedContainer` es la pantalla de arranque desde el primer
   pintado y sale, como ya hacía, sobre la primera tarjeta. Sin riesgo
   debajo: `loadPapers` no arranca sin preferencias ni perfil.
2. La barra se funde en 0,24 s solo en su primer montaje de la sesión
   (bandera de módulo en `Navbar.jsx`; los remontajes desde rutas sin barra
   llegan con la página).
3. Sin cambios en la coreografía de salida del veil ni en `PageTransition`.

## Verificación

Modo demo (`IS_DEMO` volteado en local, cuenta sembrada en localStorage
por la sonda con el flag `demo`) contra el servidor del worktree en 5174,
escritorio 1280×900 y móvil 390×844 con táctil, con y sin retener las
fuentes 3,5 s:

| Caso | veil desde | barra 0→1 | tarjeta | veil 1→0 | título 0→1 | frames sin veil ni tarjeta |
|---|---|---|---|---|---|---|
| escritorio | 256 ms | 289–515 ms | 5524 ms | 5541–5963 ms | →5796 ms | 0 |
| escritorio, retenido | 273 ms | 303–545 ms | 3634 ms | 3645–4078 ms | →3896 ms | 0 |
| móvil | 179 ms | 205–445 ms | 2053 ms | 2066–2495 ms | →2311 ms | 0 |
| móvil, retenido | 230 ms | 255–488 ms | 3689 ms | 3718–4140 ms | →3940 ms | 0 |

No hay puerta previa ni sustitución de elementos: el mismo `.feed-empty--veil`
está en pantalla desde el primer pintado hasta que recede (escala del átomo
1 → 0,67, opacidad del suelo 1 → 0) mientras el título compone debajo.
Capturas del arranque, el relevo y el reposo en ambos tamaños tomadas con
el flag `shots`.

El camino de invitado no cambia de naturaleza: durante la puerta ve ahora el
veil del feed en vez del átomo «PaperTok», y después el esqueleto del feed
de invitado, como antes.

Suite completa, lint y build en verde antes de fusionar.
