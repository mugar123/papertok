# Auditoría del lector «Leer en simple»: la selección con ratón — 2026-09-17

Reportado por el usuario: «dentro de la función de explicar con IA veo errores, principalmente
cuando selecciono texto con el ratón», y la sospecha de que hay animaciones que no se muestran.

## Cómo se midió

Chrome headless por CDP (`--headless=new`, 1440×900) con el perfil de sondas que tiene la
sesión real, sobre la build de producción servida en `localhost:5174`. La reescritura
(`POST /ai/rewrite`), la cuota (`GET /ai/quota`) y la explicación (`POST /ai/annotate`) se
contestan localmente con `Fetch.fulfillRequest`, así que **no se gastó ningún uso de IA** y el
texto es determinista: tres secciones, una fórmula KaTeX, un subrayado propuesto por la IA y un
párrafo con escapes LaTeX (`\%`, `\&`, `---`, ``` ``…'' ```). Los subrayados que sí se escribieron
en Firestore (escenarios H e I) se quitaron después desde el propio raíl; la cuenta quedó como
estaba.

La selección se hace con eventos de ratón reales (`Input.dispatchMouseEvent`: pulsar, seis
movimientos, soltar) sobre rectángulos calculados con `Range.getClientRects()`. Cada escenario
registra por fotograma (`requestAnimationFrame`) el menú (`data-starting-style` /
`data-ending-style`, opacidad, `scale`, `translate`, rectángulo), las marcas provisionales
(`.rd-mark--pending`), las marcas de la IA, la selección nativa, y toda excepción o
`console.error`. Sondas: `reader-selection-probe.mjs` y `reader-scenarios-probe.mjs` (scratchpad
de la sesión; derivadas de `scripts/diagnostics/page-transition-frames.mjs`).

## Lo que funciona (medido)

| Pieza | Medida |
|---|---|
| Menú al soltar | `data-starting-style` a los 22 ms; opacidad 0 → 1 en 200 ms lineal; `scale` 0,96 → 1 y `translate` −6 px → 0 en la curva expo; asentado a los 213 ms; foco en el primer botón |
| Marca provisional | Pintada en el mismo fotograma en que el menú monta; la selección nativa se retira a la vez |
| Escape | `data-ending-style` en 17 ms; opacidad 1 → 0 en 200 ms; desmontado a los 300 ms; la marca provisional se va en el primer fotograma |
| Subrayar (escritura real) | La marca `data-fresh` aparece a los ~320 ms (la escritura de Firestore) con `rdPenDown` corriendo de 0 a 420 ms; la tarjeta del raíl llega; el flag se retira a los ~1,1 s |
| Explicar (respuesta local con 900 ms de retardo) | Tarjeta «pensando» en el raíl a los 88 ms; la nota llega con `rdWriteIn` corriendo 0 → 620 ms; el pasaje recibe el subrayado de tinta de la IA |
| Selección sobre la fórmula | Tres marcas provisionales: el texto antes, la fórmula entera y el texto después |
| Escapes LaTeX en el párrafo | La marca empieza exactamente donde empezó el ratón («frente al 25% …») |
| Doble y triple clic | Abren el menú sobre la palabra y sobre el párrafo |

Ninguna animación de la ruta de selección está muerta. Las únicas excepciones de consola durante
las tiradas son ajenas al lector: `ArxivQueueError` del feed, un 400 de OpenAIRE, un
`RunAggregationQuery` transitorio de Firestore y, en local, `/_vercel/insights/script.js`
devolviendo HTML (solo existe en Vercel).

## Los tres defectos, reproducidos

### D. Soltar el botón fuera del párrafo no abre nada

El manejador de `mouseup` vive en cada `<p>` (`onMouseUp` del párrafo). Si el arrastre acaba en
el título de sección, en el margen o en el hueco entre párrafos —lo habitual al llegar al final
de una frase que termina en el borde— el evento no toca ningún párrafo: **no hay menú, no hay
marca provisional y la selección azul del navegador se queda puesta**. Medido: menú `none`,
`pending 0`, selección viva `"\nReco"`.

Es la forma más probable de «selecciono y no pasa nada».

### G. Seleccionar otra frase con el menú aún en pantalla deja el menú donde estaba

El menú está anclado a un rectángulo virtual que `SelectionMenu` resuelve con una **función
estable** (`useCallback(() => virtualAnchor(anchorRef.current), [])`). Base UI
(`useAnchorPositioning`) solo vuelve a resolver una función-ancla cuando el popup **monta**: la
dependencia es la propia función. Al pulsar sobre otra frase, el «outside press» cierra el menú
(salida de 200 ms); si el `mouseup` de la nueva selección llega antes de que la salida termine
—un doble clic en otra palabra, un arrastre corto— el menú **vuelve a abrirse en el rectángulo
de la selección anterior**, a 300 px de la nueva marca provisional. Medido: menú en
`[261,332]` con la marca provisional en `y=626`; segunda tirada, menú en `[261,148]` con la
marca en `y=442`.

### B / J. Seleccionar sobre un subrayado de la IA lo hace desaparecer

`resolveHighlightRanges` salta toda ocurrencia que solape con un rango ya colocado y, si no queda
otra, **descarta el subrayado**. Los rangos se resuelven en orden `[...propios, ...IA]`, así que
una selección (o un subrayado guardado) que toque una frase subrayada por la IA elimina el
subrayado de tinta de la IA: durante la decisión, y para siempre una vez guardado. Medido:
`aiMarks 1 → 0` en B, `2 → 1` en J. Es la forma más probable de «el subrayado de la IA se ha
ido», y como la IA subraya justo las frases interesantes, es la selección más frecuente.

### E (menor). Una selección que cruza dos párrafos se ancla al párrafo donde se suelta

La cita empieza al principio del párrafo de llegada en vez de donde empezó el ratón. Se corrige
de paso con D: el párrafo se toma del **inicio** de la selección y la cita se recorta a su final.

## Lo que no es un defecto

- El foco salta al primer botón del menú al abrirse: es la ruta de teclado (WCAG 2.1.1) y no
  pinta nada para el ratón.
- La marca provisional aparece sin transición: es deliberado (la selección nativa desaparece en
  ese mismo fotograma y algo tiene que ocupar su sitio).
- El `\%` de los párrafos se mapea bien (`proseSourceOffset`); `displayProse` no transforma
  nada más, así que `---` y las comillas no desplazan las posiciones.

## Plan

`docs/superpowers/plans/2026-09-17-lector-seleccion-raton.md`.
