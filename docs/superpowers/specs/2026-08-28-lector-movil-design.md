# Subrayar y anotar en móvil — diseño

Fecha: 2026-08-28. Alcance: **solo puntero grueso**. El flujo de escritorio no
se toca; ver «Aislamiento» para el mecanismo que lo garantiza.

## El problema

Dos quejas del usuario, y resultaron ser una causa y un síntoma:

1. **No se puede subrayar ni anotar en móvil.** No es una sensación: es un fallo.
2. **La isla inferior está mal diseñada** en móvil.

### Causa de (1)

`PaperReader.jsx:1228` engancha la detección de selección a `onMouseUp`, y es el
único disparador:

```jsx
onMouseUp={(event) => handleSelection(section.id, paragraphIndex, paragraph, event.currentTarget)}
```

En un teléfono ese evento no llega nunca tras un gesto de selección: al mantener
pulsado, el sistema toma el control, muestra su propio menú (Copiar / Buscar /
Compartir) y no emite `mouseup` al soltar los manejadores. El menú de subrayar /
anotar / preguntar es, por construcción, inalcanzable en táctil.

`SelectionMenu.jsx` agrava lo mismo por el otro lado: cierra escuchando
`mousedown` en captura, otro evento de ratón.

### Causa de (2)

Por debajo de 1100 px conviven **dos superficies fijas apiladas**, y son de
naturaleza distinta:

| Superficie | Qué es | Contenido |
|---|---|---|
| `.rd-panel-dock` | controles | selector de nivel de reescritura + interruptor de subrayados |
| `.rd-rail[data-surface='sheet']` | contenido | lista de anotaciones, asomando 62 px + inset |

Ninguna se puede descartar. Entre las dos obligan a `.rd-scroll` a llevar
`calc(var(--rd-sheet-peek-total) + var(--space-24) + var(--space-12))` de relleno
inferior — unos 183 px de la pantalla más pequeña, permanentemente.

## Enfoque elegido

**La isla se convierte en la barra de acciones de la selección.**

Se deja que el sistema seleccione como en cualquier otra app —pulsación larga,
manejadores nativos, precisión exacta, que es lo que el usuario pidió— y cuando
hay selección viva, la barra inferior cambia su contenido a las acciones sobre
ese fragmento.

La idea central es **separar en el espacio en vez de competir**: el menú nativo
de iOS aparece pegado al texto y no se puede suprimir mientras el texto sea
seleccionable. Poner el nuestro ahí también es garantizar el choque. Abajo no
chocan, y además el borde inferior es la zona más alcanzable con el pulgar.

### Alternativas descartadas

- **Modo de marcado propio** (`user-select: none` + arrastre con
  `caretRangeFromPoint`): control total y un solo menú, pero es un modo con
  entrada y salida, exige construir manejadores propios para ajustar extremos y
  bloquear el scroll mientras se marca. Reimplementa mal algo que el sistema
  hace bien.
- **Menú flotante sobre la selección, como escritorio**: lo más barato, y
  probablemente el origen exacto de la confusión — dos menús sobre el mismo
  texto en iOS.

## Diseño

### 1. Detección de la selección

- El camino de escritorio (`onMouseUp` → `handleSelection` → borrar selección →
  marca provisional propia) **queda intacto**.
- En puntero grueso se escucha `selectionchange` acotado al contenedor del
  lector, con retardo hasta que la selección **deja de moverse**. Capturar en el
  primer evento clavaría el primer fragmento parcial y destruiría la precisión
  que motiva todo esto. **Valor de partida: 250 ms sin cambios.** Es una cifra a
  afinar contra un teléfono real, no medida: por debajo se corre el riesgo de
  disparar entre dos ajustes de manejador, y por encima la barra se siente
  perezosa. El valor vive en una constante nombrada, no incrustado.
- La rama se elige en tiempo de ejecución con `matchMedia('(pointer: coarse)')`,
  el mismo mecanismo que `utils/themeTransition.js` usa para elegir su ruta.
- **En móvil no se borra la selección nativa.** Borrarla impide reajustar los
  manejadores. Consecuencia aceptada explícitamente por el usuario: el menú del
  sistema permanece visible junto al texto mientras se decide. La selección se
  limpia al tocar una de nuestras acciones.
- La marca provisional que escritorio pinta a mano **no se usa en móvil**: el
  resaltado nativo ya cumple esa función y el sistema lo dibuja mejor.

### 2. La isla, tres estados

Una sola superficie que **se transforma en el sitio**. Con el menú del sistema
ya en pantalla, una segunda superficie emergiendo sería el amontonamiento que
este trabajo viene a eliminar.

**Reposo** — barra fina, ~56 px + área segura (hoy: 183 px). Contiene el
contador de anotaciones (toque → abre la lista) y un único botón de ajustes de
lectura que aloja el selector de nivel y el interruptor de subrayados. Ambos son
ajustes que se tocan una vez por lectura y hoy ocupan sitio permanente.

*Excepción:* mientras la reescritura por nivel se genera, la barra lo muestra.
Es el único momento en que ese control merece estar a la vista.

**Con selección** — misma barra, misma posición, contenido «Subrayar · Nota ·
Preguntar». Al tocar «Nota» la barra **crece hacia arriba** hasta ser el campo
de escritura, que es la filosofía que `SelectionMenu.jsx` ya declara para
escritorio: «crece en vez de ser reemplazado, porque cerrar un popover y abrir
otro pierde el hilo con la frase que lo empezó».

**Desplegada** — la lista de anotaciones, la hoja actual a 72 dvh. En sustancia
no cambia; se entra desde la barra en vez de estar siempre asomando.

### 3. Comportamiento al desplazar

- Listener **pasivo** de `scroll` en el contenedor del lector, con umbral de
  ~8 px contra el temblor.
- Baja → la barra se desliza fuera. **Sube → vuelve.** No reaparece por quedarse
  quieto: en lectura real se está quieto casi siempre, y eso convertiría el
  auto-ocultado en puro movimiento sin ganancia.
- Red de seguridad: un toque en el texto también la devuelve. Un toque simple
  no produce selección —hace falta pulsación larga—, así que este gesto no
  compite con el de marcar.
- La barra **flota, no empuja**. El relleno inferior del texto es constante, así
  que aparecer y desaparecer nunca reflowa el párrafo que se está leyendo.
- `prefers-reduced-motion`: aparece y desaparece sin deslizamiento.

**Reparto honesto del valor:** los ~127 px los devuelve fundir las dos
superficies. El auto-ocultado añade 56 px más, y solo mientras te mueves.

### 4. Aislamiento de escritorio

El corte **no es por ancho de ventana, es por tipo de puntero**.

El lector ya cambia a hoja por debajo de 1100 px, así que una ventana estrecha
en un portátil recibe hoy parte del tratamiento móvil. Colgar el rediseño de ese
ancho haría que encoger la ventana en el ordenador cambiara el flujo que el
usuario quiere intacto.

Todo lo nuevo va bajo `(pointer: coarse)`; en JS, la rama se elige con
`matchMedia('(pointer: coarse)')`.

**Consecuencia deliberada:** una ventana estrecha con ratón se queda exactamente
como hoy, con su hoja y su panel. Es el precio de no tocar el flujo de escritorio.

## Riesgos

1. **El teclado del móvil contra el campo de nota anclado abajo.** Es el punto
   con más probabilidad de dar guerra, sobre todo en iOS. Se resuelve con
   `visualViewport`; se trata como riesgo de primer orden en el plan, no como
   detalle de implementación.
2. **Las anotaciones pasan de estar a la vista a estar a un toque.** El contador
   sigue presente, la lista no. Intercambio consciente.
3. **Convivencia con el menú del sistema.** Aprobado por el usuario, pero es la
   parte del diseño que solo su teléfono puede validar.

## Pruebas

- **Lógica pura a módulos propios con `node --test`**: dirección del scroll,
  criterio de «selección asentada», elección de rama. Es el patrón que ya siguió
  `pickThemeRoute`.
- **CSS fijado en `readerMobileStyles.test.js`**, que ya existe y ya comprueba
  texto CSS con expresiones regulares. Se añaden las reglas de la barra **y una
  aserción que fije que el camino de escritorio sigue enganchado a `onMouseUp`**,
  de modo que falle si alguien lo toca.
- **Lo que no se puede verificar aquí**: que la selección táctil funcione de
  verdad. El panel de navegador de la sesión no alcanza el worktree, y la
  selección con manejadores nativos no se reproduce con eventos sintéticos. La
  validación final es un teléfono real.

## Fuera de alcance

- El flujo de escritorio, en cualquiera de sus partes.
- La ventana estrecha con ratón.
- Las dos funciones de IA en sí (reescritura por nivel y preguntar sobre un
  fragmento): cambia dónde se invocan, no qué hacen.
