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

---

## Segunda vuelta: «va mejor, pero sigue pasando» (mismo día)

Tras desplegar lo anterior el usuario informa de mejora sin cierre. Se descartaron por medida dos
mecanismos más y apareció uno nuevo, este sí reproducible.

### Descartado: el toque mientras el feed se mueve

WebKit, iPhone emulado: tocar una pestaña 60, 150, 400 y 900 ms después de lanzar un scroll del
feed entrega `pointerdown`, `touchstart`, `touchend`, `mousedown` y `click` en el enlace, y navega,
esté el contenedor en movimiento o quieto. Una primera versión de la sonda dio «NO CLICK»: era
artefacto suyo —tocaba una tarjeta antes de tocar la pestaña, y eso abre una hoja— y es lo que
llevó al hallazgo de abajo.

### Hallazgo: más de la mitad de la tarjeta abre una hoja modal, y esa hoja se come el primer toque

Muestreo de la tarjeta a x = 195, de y = 90 a y = 620 en pasos de 38 px (14 alturas):

| Franja | Qué hay | Un toque abre |
|---|---|---|
| 90–242 | cabecera, chips, tema, título | nada |
| 280–318 | fila de autores | `pc-authors-modal-sheet` |
| 356–546 | el abstracto | `abstract-sheet` |
| 584 | pie de la tarjeta | nada |

**8 de 14 alturas abren una hoja modal.** Con una hoja abierta, el primer toque en una pestaña la
cierra y no navega; el segundo navega (verificado con 120, 250, 450 y 900 ms entre uno y otro: los
dos toques siempre acaban en `#/research`, pero hacen falta dos). Sin hoja abierta, dos toques
seguidos en pestañas distintas a 120 ms navegan a la segunda.

La franja del abstracto es de hoy (`07c68bf`, pedida por el usuario: «al pulsar en el abstract o
en read more, accederás a dicha vista expandida»). Antes de hoy ese toque desplegaba el abstracto
en la tarjeta, sin modal, y la pestaña siguiente respondía al primer toque. La fila de autores ya
era modal.

### El instrumento que falta: el propio iPhone

`src/diagnostics/tapDiagnostics.js`, detrás de `?tapdiag=1` (se recuerda en la sesión de la
pestaña; `?tapdiag=0` lo apaga). Chunk aparte que no se descarga sin la bandera. Registra en fase
de captura, antes de que nada pueda cancelarlos, cada `touch*`, `pointer*`, `mouse*` y `click` que
llega a la barra, con qué hay bajo el dedo según `elementFromPoint`; los `pushState`/`replaceState`,
`hashchange` y `popstate`; los scroll en vuelo; el viewport visual (escala, desplazamiento, alto) y
el `padding-top` real de la barra; y una foto de la ruta 300, 1.000 y 2.500 ms después de cada
clic. Un panel abajo lo enseña, con Copy y Share.

Verificado en WebKit sobre un iPhone emulado: no monta ni se descarga sin la bandera, monta con
ella, registra el toque completo con su objetivo y su push, sobrevive a una recarga y se apaga con
`?tapdiag=0`.

**Lo que hay que leer en la captura del móvil:**

- **No hay `touchstart` en la barra** → el dedo no llegó al enlace (¿la barra de Safari
  reexpandiéndose junto al borde superior? `standalone` y `vv=` en la cabecera lo dicen).
- **Hay `touchstart` y `touchend` pero no `click`** → el sistema se comió el toque (gesto,
  momentum, doble toque).
- **Hay `click` y `pushState` pero `after+300` sigue en la ruta vieja** → navegó y algo lo devolvió.
- **Hay `click`, `pushState` y `after+300` en la ruta nueva** → navegó al primer toque y lo que
  falla es lo que se ve, no lo que se toca.
- **`snap … modal=` con una hoja** → es el hallazgo de arriba: el primer toque cierra la hoja.

---

## Tercera vuelta: dejar de depender del clic

El usuario confirma que el fallo sigue. Los tres arreglos anteriores y el diagnóstico daban por
supuesto lo mismo: que el `click` llega. Todo lo medible en este Mac lo confirma —Chromium y
WebKit entregan el clic en el centro, en los bordes, en la barra muerta, con el feed en
movimiento y tras un scroll— y aun así el fallo sobrevive a tres arreglos construidos sobre esa
suposición. Así que se deja de suponer.

### El cambio

En un teléfono el `click` se SINTETIZA cuando el dedo se levanta, y el sistema es libre de no
sintetizarlo nunca: un reconocedor de gestos que decide tarde, la ventana del doble toque, un
scroll que aún se estaba asentando. El par `pointerdown`/`pointerup` llega igualmente. La
navegación pasa a montar en el `pointerup`, que es el último evento que la página tiene
garantizado.

- **Solo táctil.** Con ratón y con teclado el enlace conserva su propio clic, así que el
  escritorio no cambia.
- **Solo si el dedo se levanta donde se apoyó**, dentro de 12 px y 1,5 s: un arrastre que empieza
  en la barra no es una navegación.
- **El clic que el sistema sí sintetice se traga**, o react-router empujaría la misma ruta dos
  veces y Atrás necesitaría dos pulsaciones.

### Medido (build de producción, iPhone emulado)

| Comprobación | Táctil | Ratón |
|---|---|---|
| Un toque limpio en cada pestaña | navega, `history` +1 | navega, `history` +1 |
| Dos toques seguidos en la misma pestaña | `history` +1 (el segundo ya está en la ruta) | +1 |
| Arrastre de 40 px empezando en la barra | no navega, `history` +0 | no navega |
| Research y un solo Atrás | `#/research` → `#/` | ídem |

En WebKit, los 21 toques de la batería completa siguen en verde y el `pushState` ahora aparece
**antes** del `touchend`: 2–7 ms desde el inicio del toque, frente a los 34–87 ms que costaba
esperar al clic.

`npm test` 2.850 en verde, lint limpio, build correcto.
