# Subrayar y anotar en móvil — plan de implementación

> **Para agentes:** los pasos usan casillas (`- [ ]`). Ejecutar tarea a tarea, con
> `npm test` entre tareas.

**Objetivo:** que se pueda subrayar y anotar con los dedos —hoy es imposible— y
que la parte baja de la pantalla deje de ser dos superficies apiladas que ocupan
183 px sin poder descartarse.

**Arquitectura:** la selección la sigue haciendo el sistema operativo, con sus
manejadores y su precisión; lo que cambia es dónde se decide qué hacer con ella.
`SelectionMenu.jsx` **no se toca**: se le añade un hermano para puntero grueso
que consume los mismos props y se dibuja como barra inferior. La lógica pura
(cuándo una selección está asentada, qué ruta tomar, hacia dónde va el scroll)
sale a módulos propios con tests en Node, siguiendo el patrón que ya usó
`pickThemeRoute`.

**Stack:** Vite 8 + React 19, framer-motion, `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-28-lector-movil-design.md`

## Restricciones globales

- **Escritorio no se toca.** El corte es por `(pointer: coarse)`, nunca por ancho
  de ventana: el lector ya cambia a hoja bajo 1100 px y encoger la ventana en un
  portátil no debe alterar el flujo que el usuario quiere intacto. Consecuencia
  aceptada: ventana estrecha con ratón se queda como hoy.
- `SelectionMenu.jsx` y el camino `onMouseUp` **no se modifican**. Hay un test que
  lo fija; si falla, es que alguien tocó escritorio.
- `prefers-reduced-motion` sigue significando «sin movimiento» en todo camino nuevo.
- Comentarios de código en inglés explicando el *porqué*; UI en español/inglés vía
  el objeto `copy` que ya existe en `PaperReader.jsx`.
- **Un worktree nuevo necesita `.env.local` copiado a mano** (está en gitignore).
  Sin él `worker/ai-rewrite.test.js` se cuelga para siempre, porque el runner
  corre con `--test-timeout=0`.
- Baseline: `npm test` → **1570 pass**.

## Estructura de ficheros

| Fichero | Responsabilidad |
|---|---|
| `src/utils/readerSelection.js` (nuevo) | Puro: ruta por puntero, y si una selección está asentada y es válida. |
| `src/utils/readerSelection.test.js` (nuevo) | Sus tests. |
| `src/utils/scrollDirection.js` (nuevo) | Puro: de dos posiciones y un umbral, si la barra se muestra u oculta. |
| `src/utils/scrollDirection.test.js` (nuevo) | Sus tests. |
| `src/hooks/useTouchSelection.js` (nuevo) | Cablea `selectionchange` al documento en puntero grueso y llama al mismo `handleSelection`. |
| `src/components/Reader/ReaderBar.jsx` (nuevo) | La isla: tres estados (reposo / selección / compositor de nota). |
| `src/components/Reader/ReaderBar.css` (nuevo) | Su CSS, todo bajo `(pointer: coarse)`. |
| `src/components/Reader/PaperReader.jsx` | Cablea el hook y la barra; baja el rótulo al documento en móvil. |
| `src/components/Reader/PaperReader.css` | Oculta el dock y ajusta el relleno inferior en móvil. |
| `src/components/Reader/Annotations.css` | La hoja deja de asomar: se abre desde la barra. |
| `src/components/Reader/readerMobileStyles.test.js` | Fija las reglas nuevas **y** que escritorio sigue en `onMouseUp`. |

---

### Tarea 1 · La decisión de ruta y de «selección asentada», pura y testeable

**Ficheros:**
- Crear: `src/utils/readerSelection.js`, `src/utils/readerSelection.test.js`

**Interfaces:**
- Produce: `pickSelectionRoute({ coarsePointer })` → `'bar' | 'menu'`;
  `SELECTION_SETTLE_MS` (constante, 250);
  `isUsableSelection({ isCollapsed, rangeCount, text })` → boolean.

- [ ] **Paso 1: test que falla**

```js
// src/utils/readerSelection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSelectionRoute, isUsableSelection, SELECTION_SETTLE_MS } from './readerSelection.js';

test('puntero grueso decide la barra; el fino conserva el menú de escritorio', () => {
  assert.equal(pickSelectionRoute({ coarsePointer: true }), 'bar');
  assert.equal(pickSelectionRoute({ coarsePointer: false }), 'menu');
});

test('una selección vacía, colapsada o sin rango no es utilizable', () => {
  assert.equal(isUsableSelection({ isCollapsed: true, rangeCount: 1, text: 'hola' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 0, text: 'hola' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 1, text: '   ' }), false);
  assert.equal(isUsableSelection({ isCollapsed: false, rangeCount: 1, text: 'hola' }), true);
});

test('el retardo de asentamiento es una constante con nombre, no un número suelto', () => {
  assert.equal(typeof SELECTION_SETTLE_MS, 'number');
  assert.ok(SELECTION_SETTLE_MS >= 150 && SELECTION_SETTLE_MS <= 400);
});
```

- [ ] **Paso 2:** `node --test src/utils/readerSelection.test.js` → FALLA (módulo inexistente).

- [ ] **Paso 3: implementación.**

```js
/**
 * Who decides what to do with a selection, and when it is ready to be decided.
 *
 * On a fine pointer nothing changes: `onMouseUp` still fires and the floating
 * menu still opens over the passage. On a coarse pointer that event never
 * arrives — long-pressing text hands the gesture to the OS, which shows its own
 * callout and emits no `mouseup` when the handles are released — so the reader
 * watches `selectionchange` instead and puts the actions in the bottom bar,
 * where they cannot collide with the OS callout sitting over the text.
 */

/** How long the selection must hold still before it counts as a decision.
 *  Capturing on the first `selectionchange` would freeze the first partial
 *  range and destroy the precision that dragging the handles exists to give.
 *  A starting value, to be tuned against a real phone: below this the capture
 *  can fire between two handle adjustments; above it the bar feels sluggish. */
export const SELECTION_SETTLE_MS = 250;

export function pickSelectionRoute({ coarsePointer }) {
  return coarsePointer ? 'bar' : 'menu';
}

export function isUsableSelection({ isCollapsed, rangeCount, text }) {
  if (isCollapsed) return false;
  if (!rangeCount) return false;
  return String(text || '').trim().length > 0;
}
```

- [ ] **Paso 4:** el test pasa. **Paso 5:** `npm test` (1570 + 3).
- [ ] **Paso 6: commit** — `feat(lector): la ruta de selección y su asentamiento, puros y con tests`

---

### Tarea 2 · La dirección del scroll, pura y testeable

**Ficheros:**
- Crear: `src/utils/scrollDirection.js`, `src/utils/scrollDirection.test.js`

**Interfaces:**
- Produce: `nextBarVisibility({ previousTop, currentTop, visible, threshold })` → boolean.

- [ ] **Paso 1: test que falla**

```js
// src/utils/scrollDirection.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBarVisibility } from './scrollDirection.js';

const T = 8;

test('bajar esconde la barra; subir la devuelve', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 140, visible: true, threshold: T }), false);
  assert.equal(nextBarVisibility({ previousTop: 140, currentTop: 100, visible: false, threshold: T }), true);
});

test('un movimiento por debajo del umbral no cambia nada: es temblor, no intención', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 104, visible: true, threshold: T }), true);
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 96, visible: false, threshold: T }), false);
});

test('quedarse quieto NO devuelve la barra', () => {
  assert.equal(nextBarVisibility({ previousTop: 100, currentTop: 100, visible: false, threshold: T }), false);
});

test('en el borde superior la barra vuelve', () => {
  assert.equal(nextBarVisibility({ previousTop: 4, currentTop: 0, visible: false, threshold: T }), true);
});
```

- [ ] **Paso 2:** correr → FALLA.

- [ ] **Paso 3: implementación.**

```js
/**
 * Which way the reader is going, and therefore whether the bar is in the way.
 *
 * Hides going down and comes back going up — deliberately NOT on "stopped".
 * Real reading is mostly stillness, so returning on stillness would leave the
 * bar up almost always and turn the whole behaviour into motion for nothing.
 *
 * The threshold is what separates intent from tremor: a finger resting on a
 * scrolling surface moves a few pixels either way, and without it the bar
 * would flicker on every one of them.
 */
export function nextBarVisibility({ previousTop, currentTop, visible, threshold = 8 }) {
  const delta = currentTop - previousTop;
  // The top of the document always shows the bar: a reader who has scrolled
  // back to the title is not reading, and this is the cheapest way back for
  // someone who has not worked out that scrolling up returns it.
  if (currentTop <= 0) return true;
  if (Math.abs(delta) < threshold) return visible;
  return delta < 0;
}
```

- [ ] **Paso 4:** pasa. **Paso 5:** `npm test`. **Paso 6: commit** — `feat(lector): la barra sabe hacia dónde va el dedo`

---

### Tarea 3 · El hook que hace posible seleccionar en táctil

**Ficheros:**
- Crear: `src/hooks/useTouchSelection.js`
- Modificar: `src/components/Reader/PaperReader.jsx` (cablearlo junto a `handleSelection`)

**Interfaces:**
- Consume: `pickSelectionRoute`, `isUsableSelection`, `SELECTION_SETTLE_MS` (Tarea 1).
- Produce: `useTouchSelection({ scrollRef, sections, onSelect, enabled })`, donde
  `onSelect(sectionId, paragraphIndex, paragraphText, paragraphNode)` tiene la
  **misma firma** que el `handleSelection` que ya existe.

Esta tarea es la que arregla el fallo. Al terminarla ya se puede subrayar con los
dedos, aunque el menú siga siendo el flotante de escritorio: la barra llega en la
Tarea 4. Se ordena así a propósito — separa «arreglar lo roto» de «rediseñar».

- [ ] **Paso 1:** crear el hook.

```js
import { useEffect, useRef } from 'react';
import { isUsableSelection, SELECTION_SETTLE_MS } from '../utils/readerSelection.js';

/**
 * Touch selection, which the reader could not see before.
 *
 * `onMouseUp` is the desktop path and it never fires for a touch selection
 * gesture: a long press hands the gesture to the OS, which shows its own
 * callout and emits no mouse event when the handles are released. So on a
 * coarse pointer the reader listens to `selectionchange` on the document and
 * waits for it to hold still — capturing on the first event would freeze the
 * first partial range and lose the precision the handles exist to give.
 *
 * Paragraph identity comes off the DOM rather than a per-paragraph callback:
 * every `<p class="rd-p">` already carries `data-section` and `data-paragraph`,
 * so one document listener covers the whole document. The paragraph *text*
 * comes from `sections`, never from `textContent` — KaTeX renders every formula
 * twice and the accessible copy would come along for the ride.
 */
export function useTouchSelection({ scrollRef, sections, onSelect, enabled }) {
  const timerRef = useRef(null);
  const sectionsRef = useRef(sections);
  const onSelectRef = useRef(onSelect);
  sectionsRef.current = sections;
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!enabled) return undefined;

    const capture = () => {
      const selection = window.getSelection();
      if (!selection) return;
      if (!isUsableSelection({
        isCollapsed: selection.isCollapsed,
        rangeCount: selection.rangeCount,
        text: selection.toString(),
      })) return;

      const anchorNode = selection.anchorNode;
      const element = anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
      const paragraph = element?.closest?.('p.rd-p');
      if (!paragraph) return;
      if (scrollRef.current && !scrollRef.current.contains(paragraph)) return;

      const sectionId = paragraph.dataset.section;
      const paragraphIndex = Number(paragraph.dataset.paragraph);
      const section = sectionsRef.current?.find(item => item.id === sectionId);
      const text = section?.paragraphs?.[paragraphIndex];
      if (typeof text !== 'string') return;

      onSelectRef.current(sectionId, paragraphIndex, text, paragraph);
    };

    const onSelectionChange = () => {
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(capture, SELECTION_SETTLE_MS);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      window.clearTimeout(timerRef.current);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [enabled, scrollRef]);
}
```

- [ ] **Paso 2:** en `PaperReader.jsx`, junto a `handleSelection`, calcular la
  ruta una vez y cablear el hook. Localizar por símbolo, no por número de línea.

```js
const coarsePointer = useMemo(() => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}, []);
const selectionRoute = pickSelectionRoute({ coarsePointer });

useTouchSelection({
  scrollRef,
  sections,
  onSelect: handleSelection,
  enabled: selectionRoute === 'bar',
});
```

**Aviso importante para el implementador:** `handleSelection` hace hoy
`selection.removeAllRanges()`. En el camino táctil **eso no debe ocurrir**:
borrar la selección impide reajustar los manejadores y mata la precisión que
motiva todo esto. Antes de cablear, comprueba qué hace exactamente y haz que el
borrado sea condicional a la ruta `menu`. Si al leerlo ves que ese borrado es
necesario para otra cosa, **dilo antes de cambiarlo** en vez de asumir.

- [ ] **Paso 3:** verificar el nombre real del ref del contenedor de scroll
  (`scrollRef` es la suposición; búscalo — la clase es `.rd-scroll`). Si no
  existe un ref, créalo.
- [ ] **Paso 4:** `npm run lint` y `npm test` (1570 + 3, sin regresiones).
- [ ] **Paso 5: commit** — `fix(lector): en táctil sí se puede seleccionar para subrayar y anotar`

---

### Tarea 4 · La barra: reposo y selección

**Ficheros:**
- Crear: `src/components/Reader/ReaderBar.jsx`, `src/components/Reader/ReaderBar.css`
- Modificar: `src/components/Reader/PaperReader.jsx`, `src/components/Reader/PaperReader.css`,
  `src/components/Reader/Annotations.css`

**Interfaces:**
- Consume: los mismos props que `SelectionMenu` recibe hoy en `PaperReader.jsx`
  (`anchor`, `copy`, `usesLeft`, `unlimited`, `canAsk`, `busy`, `onHighlight`,
  `onSaveNote`, `onAsk`, `onClose`), más `annotationCount`, `onOpenList`,
  `onOpenSettings`, `streaming`, `visible`.
- Produce: la clase `.rd-bar` y sus estados `data-state="rest|selection|composing"`.

- [ ] **Paso 1:** `ReaderBar.jsx`, una sola superficie con tres estados. Esta es
  la forma; las hojas del JSX (iconos, textos concretos) las eliges tú
  reutilizando el objeto `copy` que ya existe — **no inventes cadenas nuevas**
  sin añadirlas a los dos idiomas.

```jsx
import { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * The island. One surface, three states, and it morphs in place rather than
 * letting a second surface rise: with the OS callout already on screen over the
 * passage, anything else sliding up is the pile-up this redesign exists to
 * remove. In rest it is the way into your annotations; with a live selection it
 * is what to do with it.
 */
export default function ReaderBar({
  pending, copy, usesLeft, unlimited, canAsk, busy,
  onHighlight, onSaveNote, onAsk, onClose,
  annotationCount, onOpenList, onOpenSettings,
  streaming, visible,
}) {
  const prefersReducedMotion = useReducedMotion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const state = composing ? 'composing' : pending ? 'selection' : 'rest';

  // Leaving the selection collapses the composer with it: a draft that outlives
  // the passage it was about has nothing left to attach to.
  if (!pending && composing) { setComposing(false); setDraft(''); }

  return (
    <motion.div
      className="rd-bar"
      data-state={state}
      animate={{ y: visible || state !== 'rest' ? 0 : '110%' }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* rest: annotation count → onOpenList; settings button → onOpenSettings;
          streaming indicator when `streaming` is true.
          selection: highlight / note / ask over the same handlers.
          composing: the textarea, MAX_NOTE_LENGTH enforced, onSaveNote(draft). */}
    </motion.div>
  );
}
```

  El contador y el botón de ajustes son los dos únicos objetivos en reposo. El
  indicador de reescritura en curso solo aparece con `streaming`, que es el único
  momento en que ese control merece estar a la vista — hoy lo está siempre.
- [ ] **Paso 2:** `ReaderBar.css`, **todo** dentro de `@media (pointer: coarse)`.
  La barra flota (`position: fixed`), no empuja: el relleno inferior de
  `.rd-scroll` es constante, así que aparecer y desaparecer nunca reflowa el
  párrafo que se está leyendo. Usa `--inset-bottom`, que ya existe.
- [ ] **Paso 3:** en móvil, ocultar `.rd-panel-dock` y quitarle a la hoja de
  anotaciones su asomo permanente (en `Annotations.css`, la regla
  `transform: translateY(calc(100% - var(--rd-sheet-peek-total ...)))` pasa a
  ocultarla del todo; se abre desde la barra). Ajustar el relleno inferior de
  `.rd-scroll` a la altura de la barra en vez de a los ~183 px actuales.
  **No toques esas reglas fuera del bloque de puntero grueso.**
- [ ] **Paso 4:** en `PaperReader.jsx`, renderizar `ReaderBar` cuando
  `selectionRoute === 'bar'`, y seguir renderizando `SelectionMenu` cuando sea
  `'menu'`. **Ambos leen `annotations.pending`**; no dupliques estado.

- [ ] **Paso 4b — decidir dónde viven los ajustes, y es esta opción:** el botón
  de ajustes **reutiliza la hoja de anotaciones**, abriéndola en una pestaña de
  ajustes, en vez de crear una tercera superficie. El motivo es el mismo que rige
  todo el rediseño: dos superficies apiladas eran el problema, y añadir un
  popover propio para nivel y subrayados reintroduce exactamente eso un nivel más
  abajo. Si al implementarlo ves que la hoja no admite pestañas sin cirugía,
  **para y dilo** en vez de improvisar una tercera superficie.
- [ ] **Paso 5:** `npm run lint`, `npm run build`, `npm test`.
- [ ] **Paso 6: commit** — `feat(lector): una sola isla en móvil, en vez de dos superficies apiladas`

---

### Tarea 5 · El compositor de nota y el teclado

**Ficheros:**
- Modificar: `src/components/Reader/ReaderBar.jsx`, `src/components/Reader/ReaderBar.css`

Esta es la tarea con más probabilidad de dar guerra, y el spec la marca como
riesgo de primer orden. Va sola para que su revisión sea suya.

- [ ] **Paso 1:** al tocar «Nota», la barra **crece hacia arriba** hasta ser el
  campo de escritura — no se abre otra superficie. Es la filosofía que
  `SelectionMenu.jsx` ya declara en su comentario de cabecera: «crece en vez de
  ser reemplazado, porque cerrar un popover y abrir otro pierde el hilo con la
  frase que lo empezó».
- [ ] **Paso 2:** el teclado. Una barra anclada abajo queda tapada al abrirse el
  teclado del móvil. Resolver leyendo `window.visualViewport` (`height` y
  `offsetTop`) y desplazando la barra, con listeners en `resize` y `scroll` del
  `visualViewport`, y limpieza en el desmontaje. **Si `visualViewport` no existe,
  no hagas nada**: mejor una barra tapada en un navegador viejo que una barra
  saltando por una heurística.
- [ ] **Paso 3:** respetar `MAX_NOTE_LENGTH`, que ya se importa de
  `userHighlightService.js` en `SelectionMenu.jsx`.
- [ ] **Paso 4:** `npm test`. **Paso 5: commit** — `feat(lector): escribir una nota sin que el teclado tape lo que escribes`

---

### Tarea 6 · La barra se aparta al bajar

**Ficheros:**
- Modificar: `src/components/Reader/ReaderBar.jsx`, `src/components/Reader/PaperReader.jsx`

**Interfaces:** consume `nextBarVisibility` (Tarea 2).

- [ ] **Paso 1:** listener **pasivo** de `scroll` en el contenedor del lector,
  llamando a `nextBarVisibility` con la posición anterior. Sin estado nuevo por
  frame: guarda la posición en un ref y solo llama a `setState` cuando la
  visibilidad **cambia**.
- [ ] **Paso 2:** con selección viva o compositor abierto, la barra **no se
  esconde** aunque se desplace: esconder las acciones de la selección que acabas
  de hacer sería el peor momento posible.
- [ ] **Paso 3:** `prefers-reduced-motion`: aparece y desaparece sin deslizamiento.
- [ ] **Paso 4:** cleanup del listener al desmontar. **Paso 5:** `npm test`.
- [ ] **Paso 6: commit** — `feat(lector): la barra se aparta mientras bajas y vuelve al subir`

---

### Tarea 7 · El rótulo baja al documento

**Ficheros:**
- Modificar: `src/components/Reader/PaperReader.jsx`, `src/components/Reader/PaperReader.css`

Reportado por el usuario: «parece quedarse cuando voy bajando en lugar de quedarse
arriba junto al título del paper». Es literal — `.rd-status` es `position: absolute`
dentro de un overlay `fixed`, así que queda clavado en pantalla mientras el texto
pasa por debajo, y en táctil el cromo no se oculta nunca.

- [ ] **Paso 1:** en puntero grueso, el kicker («Leer en simple») sale de
  `.rd-status` y entra en el flujo del documento, encima de `rd-doc-title`, para
  que se desplace con el paper.
- [ ] **Paso 2:** lo que informa de **estado** y no de identidad se queda fijo:
  el contador de usos restantes y el indicador de caché, que son justamente lo
  que se consulta a mitad de lectura. El criterio de reparto es **identidad al
  documento, estado al cromo**.
- [ ] **Paso 3:** en escritorio no cambia nada. Verificarlo.
- [ ] **Paso 4:** `npm test`. **Paso 5: commit** — `fix(lector): el rótulo se va con el texto, no flota sobre él`

---

### Tarea 8 · Fijar en tests lo que no debe romperse

**Ficheros:**
- Modificar: `src/components/Reader/readerMobileStyles.test.js`

- [ ] **Paso 1:** una aserción que **falle si alguien toca escritorio**: que
  `PaperReader.jsx` sigue teniendo el `onMouseUp` en `p.rd-p`.

```js
test('el camino de escritorio sigue intacto: onMouseUp en el párrafo', async () => {
  const source = await readFile(new URL('./PaperReader.jsx', import.meta.url), 'utf8');
  assert.match(source, /onMouseUp=\{\(event\) => handleSelection\(/);
});
```

- [ ] **Paso 2:** fijar que **todas** las reglas nuevas de `ReaderBar.css` viven
  bajo `(pointer: coarse)` — un test que lea el fichero y falle si hay alguna
  regla fuera de ese bloque. Es la restricción dura del usuario convertida en test.
- [ ] **Paso 3:** **verificar por mutación** que cada aserción nueva falla contra
  el código sin el cambio. Esta rama hermana ya tuvo dos aserciones que pasaban
  igual con el valor viejo y el nuevo; una aserción que no puede fallar es peor
  que ninguna, porque da confianza falsa.
- [ ] **Paso 4:** `npm test`. **Paso 5: commit** — `test(lector): fijar que escritorio no se toca y que lo nuevo es solo de puntero grueso`

---

## Lo que este plan deja fuera

- **La verificación táctil real.** El panel de navegador de la sesión no alcanza
  los worktrees (comprobado durante la rama de rendimiento) y la selección con
  manejadores nativos no se reproduce con eventos sintéticos. La validación es un
  teléfono real, y el compositor con teclado es donde más se espera iterar.
- **Ventana estrecha con ratón**: se queda como hoy, por diseño.
- **Las dos funciones de IA en sí**: cambia dónde se invocan, no qué hacen.
