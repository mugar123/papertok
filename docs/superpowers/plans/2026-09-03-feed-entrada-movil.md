# La entrada del feed en móvil, igual que en escritorio (2026-09-03)

Objetivo: que entrar en Para ti y en Siguiendo desde el móvil se sienta como
en escritorio. El usuario describe la entrada de móvil como poco fluida.

## Examen

Medido con `explorer-loading-probe.mjs tabswitch` (Chrome sin cabeza por CDP,
un muestreo por frame) contra el **build de producción**, en 1280×900 y en
390×844 con táctil, con la cadena de tarjetas ya caliente. La sonda muestrea,
por frame, la opacidad y la caja de cada pieza de la primera tarjeta y de los
hijos directos de `.pc-body`.

La coreografía es la misma en los dos tamaños: `cardSlideUp` en la hoja
(10 px, 0,36 s) y `pcArrive` por pieza (8 px + opacidad, 0,32 s, escalón de
45 ms). Lo que no era igual es sobre qué se juega:

| | recorrido total del título | mayor salto en un frame |
|---|---|---|
| Escritorio | 14–16 px | 5 px |
| Móvil | 40 px | **28 px** |

## Diagnóstico

El salto de 28 px cae en el segundo o tercer frame de la llegada, con el
título todavía a 0,5 de opacidad. Muestreando los hijos de `.pc-body` se ve
la causa exacta: `pc-abstract-toggle` («Leer el abstract completo», 25 px de
alto) **no está en los dos primeros frames y aparece después**.

Es una consecuencia de dos decisiones correctas por separado:

1. El botón solo se monta cuando se sabe que el panel esconde texto, y eso es
   una medida (`scrollHeight − clientHeight`). El panel se dimensiona con el
   hueco que le dejan sus hermanos, así que en el commit que lo monta no
   tiene altura que medir: la respuesta llega dos frames más tarde.
2. Bajo 900 px la columna de la hoja está anclada abajo
   (`justify-content: flex-end`). Un elemento que entra en el flujo no
   aparece «debajo»: empuja hacia arriba todo lo que tiene encima.

En escritorio casi no se ve porque la columna es más ancha y el tope del
abstract más alto, así que el abstract suele caber, el botón no existe y no
hay nada que empujar.

## Plan

Reservar la caja del botón desde el primer frame: se renderiza siempre que
haya abstract, y el veredicto solo decide si su etiqueta está encendida
(`pc-abstract-toggle--reserved`: `opacity: 0; visibility: hidden`, con un
fundido de 0,2 s al encenderse y sin transición bajo `prefers-reduced-motion`).
`visibility` y no solo `opacity`, para que un botón invisible quede fuera del
orden de tabulación y del árbol de accesibilidad.

Efecto de regalo: el hueco del abstract deja de depender de la respuesta, así
que el veredicto es estable desde el principio en vez de realimentarse.

### Alternativa descartada, y por qué

Medir antes de pintar (`useLayoutEffect` + lectura síncrona guardada por
`clientHeight > 0`) también quita el salto — verificado: recorrido de 17 px y
veredicto correcto en el primer frame en ambos sentidos. Pero fuerza un
`layout` síncrono en cada tarjeta que monta la ventana de montaje, y eso se
paga al volver a Para ti: con CPU ×4, **tres tareas de 50–56 ms** donde antes
no había ninguna. Cambiar un salto visible por trabajo en el hilo principal
no es más fluidez.

## Verificación

Build de producción, sesión demo, y en los dos sentidos de la barra:

| | recorrido | mayor salto en un frame | botón desde el frame 0 | cambia a mitad |
|---|---|---|---|---|
| Móvil, Para ti → Siguiendo | 17 px | 5 px | sí | no |
| Móvil, Siguiendo → Para ti | 17 px | 5 px | sí | no |
| Escritorio, ambos sentidos | 18–19 px | 5 px | sí | no |

Con CPU ×4, nueve medidas: ocho con cero tareas largas y una con una de
67 ms fuera de la entrada — el mismo perfil que antes del cambio. El arranque
en móvil sigue componiendo la primera tarjeta bajo el velo (título 0 → 1) y el
carril lateral sigue quieto (288–296 px).

Suite completa, lint y build en verde antes de fusionar.
