# Las pestañas del feed en el móvil «necesitan varios toques» — 2026-09-18

Reportado por el usuario: «para cambiar en el navbar de feeds (For you → Research → Following)
tienes que pulsar varias veces en los respectivos botones del navbar para que cambie. En ordenador
no pasa, solo en móvil». Ya se reportó el 05-09 (entonces solo Following → For you) y aquel arreglo
(las tres pestañas son `NavLink`) lo dejó «más o menos solucionado».

## Qué se comprobó

**El código de la barra.** Ningún oyente de hover/mousemove en la cadena de la barra, ningún
`:hover` fuera de `(hover: hover) and (pointer: fine)`, ningún `touchstart`/`touchmove` con
`preventDefault` que la alcance (los del feed cuelgan de `.feed-container`, que no la contiene),
nada con `z-index` por encima de `--z-nav` (100), la página que se va lleva `pointer-events: none`
e `inert` y está por debajo. `useOverlayHistory` solo llama a `history.back()` si el estado actual
lleva su marca, y una pestaña la reemplaza al empujar. Nada en la barra cambió desde el 05-09 salvo
el sistema de transiciones a su alrededor.

**Chromium con toques reales** (`scripts/diagnostics/explorer-loading-probe.mjs tap`, 390×844,
emulación táctil, perfil con sesión, build de producción): ocho toques a CPU ×1 y ocho a ×6, todos
con `click` en el enlace y `pushState` a los 77–143 ms del inicio del toque; hash cambiado en todos.

**WebKit con toques reales** (Playwright WebKit 1.63, `devices['iPhone 13']`, build de producción
con `IS_DEMO` volteado en el scratchpad, usuario demo con cuatro seguimientos): For you → Research
→ Following → For you, dos ciclos, en el centro, en los bordes del enlace y tras un scroll del
feed y del documento: `click` y `pushState` a los 2–15 ms en todos los toques. El invitado no
tiene barra (`showNavbar` exige sesión) y la sesión real no se copia a otro motor: de ahí el demo.

**Lo que ninguna sonda reproduce:** el fallo. Lo que sí se midió es lo que un toque tiene por
respuesta. A ×6, tras levantar el dedo, la barra se quedaba exactamente igual ~200 ms (el manejador
del clic monta la página siguiente en una tarea de 159 ms: 47 tarjetas de Following calientes) y
solo entonces empezaba el filete su recorrido de 240 ms; el hundido `:active` dura lo que el dedo
está abajo. Y el enlace mide 30 px de alto en una barra de 52 (55×30, 66×30, 67×30 en y 11–41):
11 px de barra muerta encima y debajo de cada palabra, por debajo de los 44 pt de Apple.

## Tres candidatos que solo un dedo en un iPhone distingue

1. **El pulgar cae en la barra, no en la palabra** (30 px de objetivo): no hay `click`.
2. **El segundo toque cae dentro de la ventana de doble toque de iOS** (~300 ms tras el primero,
   que no ha mostrado nada todavía): iOS lo toma por un gesto de zoom, no por un clic.
3. **El toque llega y la página tarda**: en un iPhone lento la espera sin respuesta pasa de los
   200 ms medidos a ×6 y el usuario vuelve a tocar.

## Qué se hizo (Navbar.css, Navbar.jsx; `navbarTabs.test.js` fija las tres cosas)

- `touch-action: manipulation` en `.navbar`: sin doble toque para hacer zoom, un segundo toque es
  un segundo clic.
- Bajo `(pointer: coarse)`, `.navbar-link::before` absoluto con `top/bottom: -11px`: el área
  táctil de cada pestaña es la barra entera (52 px), sin mover un píxel.
- El filete se mueve en el `pointerdown`, no cuando el router lo dice. El toque se recuerda junto
  con la pestaña en la que se hizo y deja de contar en cuanto la ruta se mueve (derivado, sin
  efecto); `pointercancel` lo suelta y un toque que nunca es clic caduca a los 1,5 s. `aria-current`,
  la clase `active` y la seminegrita siguen siendo del router.

## Resultado medido

| | Antes | Después |
|---|---|---|
| Chromium ×6, For you → Following: el filete empieza a moverse | 315 ms tras el inicio del toque (tras el `pushState` a 114 y la primera pantalla nueva a 265) | ≤ 91 ms (antes del `pushState` a 114 y de la primera pantalla nueva a 178) |
| WebKit, toque 7 px por encima o por debajo de la palabra | `elementFromPoint` = barra; sin clic | `a.navbar-link`; clic y `pushState` a los 3–15 ms |
| WebKit y Chromium, todos los toques anteriores | OK | OK (8 + 8 + 21) |

`npm test` y eslint en verde. **Sin verificar en un iPhone**: si vuelve a pasar, lo que distingue
los candidatos es si el filete amarillo salta a la pestaña en el primer toque (ahora debería) y si
ocurre justo después de deslizar el feed.
