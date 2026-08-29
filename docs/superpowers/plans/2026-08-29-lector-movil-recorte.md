# El recorte del lector móvil, y lo que queda pendiente (29-08-2026)

## La decisión

En móvil, el lector queda reducido a **nivel + descarga**, servidos por la
isla que se esconde con el scroll y vuelve al subir. Anotaciones, subrayado
y «Que me lo explique» son **exclusivos de escritorio** (puntero fino), donde
la experiencia completa —margen de anotaciones, menú flotante sobre la
selección— sigue intacta.

Con el recorte se fue también el seleccionador táctil específico (el settle
de `selectionchange`, la congelación del scroll durante una selección, el
compositor con seguimiento de teclado por `visualViewport`, el
tap-para-desubrayar): funcionaba, pero era la pieza más frágil de la
superficie y solo daba servicio a lo que se quitó. Todo está en el historial
de git (la rama `feat/lector-movil` y los commits de ese día en `main`).

Los destacados del propio resumen (las frases que marca el modelo al
reescribir) **se quedan, siempre visibles**: son parte del documento, no
anotaciones del usuario. Su toggle desapareció con la decisión.

## Lo que se dejó vivo a propósito

El backend entero sobrevive sin uso desde móvil, para que la vuelta no exija
reconstruir nada:

- `src/services/userHighlightService.js` (guardar/listar/borrar subrayados;
  lo sigue usando escritorio).
- `src/hooks/usePassageAnnotations.js` (ídem).
- La ruta `POST /ai/annotate` del Worker.
- Los datos de subrayados de los usuarios en Firestore.
- `HighlightedScientificText.jsx` sigue pintando marks con
  `data-highlight-id` (escritorio los usa; móvil solo los muestra).

## Pendiente 1: descarga en PDF

Hoy el export es **solo LaTeX** (`ExportCard` → `downloadTex`). El objetivo
es que el mismo botón de la isla (y del dock en escritorio) ofrezca PDF.
Piezas probables: compilar el `.tex` no es viable en cliente; o se genera un
PDF directo (jsPDF/print stylesheet) o se compila en un servicio. Decisión
sin tomar.

## Pendiente 2: «Que me lo explique» en móvil, con rediseño profundo

Se quiere de vuelta, pero **no** como estaba: la ronda con un iPhone real del
29-08 demostró que la selección táctil + barra de acciones + teclado es una
superficie llena de trampas (auto-scroll de los manejadores de iOS, zoom del
teclado, callout del sistema compitiendo con la UI propia). El rediseño
tendrá que repensar la interacción desde cero — candidatos: actuar sobre
párrafos enteros (tap en un párrafo, no selección libre), o un modo de
lectura con preguntas sin anclaje a pasaje. Nada de esto está decidido.

Referencias para retomarlo:
- Diseño y plan del intento anterior:
  `docs/superpowers/specs/2026-08-28-lector-movil-design.md`,
  `docs/superpowers/plans/2026-08-29-lector-movil.md`.
- Las 25 comprobaciones de dispositivo y sus siete huecos:
  `.superpowers/sdd/2026-08-29-lector-movil/task-5-report.md` (en el worktree
  `lector-movil` si no se ha movido).
- El ledger de decisiones con su coste-si-me-equivoco:
  `.superpowers/sdd/2026-08-29-lector-movil/progress.md`.
