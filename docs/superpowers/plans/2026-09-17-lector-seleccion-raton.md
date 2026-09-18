# Lector: la selección con ratón — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una selección con ratón en el lector abra siempre su menú sobre la frase
seleccionada, se suelte donde se suelte; que el menú siga a cada nueva selección; y que un
subrayado propio sobre una frase subrayada por la IA conserve el subrayado de la IA debajo.

**Architecture:** Tres cambios independientes. (1) El motor de subrayados
(`utils/textHighlights.js`) deja de descartar rangos que solapan con otros de distinta fuente y
segmenta por fronteras, de modo que un tramo cubierto por dos rangos lleva el de arriba (el
lector) y sabe quién queda debajo (`under`); el renderizador añade una clase y la hoja pinta el
subrayado de tinta bajo la marca propia. (2) `SelectionMenu` entrega a Base UI el ancla como
**valor** que cambia con cada selección —latch de estado ajustado en render, que conserva el
último rectángulo durante la salida— en vez de una función estable que Base UI solo resuelve al
montar. (3) `PaperReader` resuelve la selección desde el propio `Range` con un `mouseup` de
documento: el párrafo es el que contiene el **inicio** de la selección, y el `onMouseUp` de
cada `<p>` desaparece.

**Tech Stack:** React 19, Base UI (`@base-ui/react` Popover), `node --test` (CI en Node 22),
Vite. Verificación con Chrome headless por CDP contra la build de producción con sesión real
(sondas del scratchpad; ver la auditoría).

**Spec:** `docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md` (defectos D, G, B/J, E; medidas).

## Global Constraints

- **Ninguna animación cambia de clock ni de curva.** Las medidas de la auditoría (menú 200 ms
  lineal + expo, `rdPenDown` 420 ms, `rdWriteIn` 620 ms, `FRESH_SETTLE_MS = 700`) son el estado
  correcto y los tests que las fijan (`readerAnnotationMotion.test.js`) siguen en verde.
- **La ruta de teclado no se toca:** los párrafos conservan `tabIndex`, `aria-describedby` y
  `onKeyDown` → `handleParagraphKeyDown`; `handleSelection` conserva su firma
  `(sectionId, paragraphIndex, paragraphText, paragraphNode)` (`paperReaderKeyboardAnnotation.test.js`).
- **`SelectionMenu` sigue montado con `open` siguiendo `pending`**, y el popup sigue apuntando al
  último rectángulo durante su salida (el comentario del componente lo explica; sigue siendo
  cierto con el latch).
- **Los tests SOURCE despojan comentarios antes de casar** (convención de `ce139ce`): nada de lo
  que se afirme puede vivir solo en un comentario. Helper: `source.replace(/\/\*[\s\S]*?\*\//g, '')`
  y, para JSX, también `// …` a fin de línea.
- **Sin cambios de comportamiento fuera de lo listado.** Nada de «ya que estoy».
- Comentarios en inglés (los tres ficheros van en inglés). Mensajes de commit en castellano,
  estilo del historial, con `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tests: `node --test <fichero>` para uno, `npm test` para todo `src/`. Lint: `npx eslint <ficheros>`.
- **Verificación final con la sonda de escenarios sobre la build** (`npx vite build`, `vite preview`
  en 5174, `reader-scenarios-probe.mjs` con `PROFILE_DIR` del perfil de sondas). No se da por
  bueno hasta que D abre el menú, G lo pone bajo la nueva marca, y B/J conservan el subrayado
  de la IA, con los escenarios H e I iguales que antes.

---

### Task 1: dos capas de subrayado en el mismo tramo

**Files:**
- Modify: `src/utils/textHighlights.js` (`resolveHighlightRanges`, `segmentTextChunk`, `buildHighlightPlan`)
- Modify: `src/components/Reader/HighlightedScientificText.jsx` (`markClassFor`)
- Modify: `src/components/Reader/PaperReader.css` (tras `.rd-mark--user.rd-mark--user`)
- Test: `src/utils/textHighlights.test.js`, `src/components/Reader/highlightLayers.test.js` (nuevo)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: cada segmento `mark` y cada chunk `math` del plan lleva `under: string[]` (las
  fuentes de los rangos que quedan debajo del que pinta; `[]` cuando no hay solape). La clase
  `rd-mark--over-ai` en una marca que no es de la IA cuando `under` incluye `'ai'`.

- [x] **Step 1: Escribir los tests que fallan (motor)**

Añadir al final de `src/utils/textHighlights.test.js`:

```js
test('a quote whose only mention lies under a mark of another source is kept, not dropped', () => {
  const text = 'La idea central es sencilla: quien convive más comparte más microbios, y el mapa se parece.';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'sencilla: quien convive más', kind: 'user', source: 'user' },
    { quote: 'quien convive más comparte más microbios', kind: 'finding', source: 'ai' },
  ]);
  assert.equal(ranges.length, 2, 'both survive: they belong to different sources');
  assert.deepEqual(ranges.map(range => range.source), ['user', 'ai']);
});

test('a repeated quote of the same source still moves on to the next mention, and is dropped when none is free', () => {
  const text = 'the control group improved and the control group persisted';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'the control group', source: 'ai' },
    { quote: 'the control group', source: 'ai' },
    { quote: 'the control group', source: 'ai' },
  ]);
  assert.equal(ranges.length, 2);
});

test('a pending selection may sit on top of anything, including the reader\'s own saved mark', () => {
  const text = 'quien convive más comparte más microbios, y el mapa de amistades se parece';
  const ranges = resolveHighlightRanges(text, [
    { quote: 'quien convive más comparte más', kind: 'user', source: 'user', id: 'saved' },
    { quote: 'quien convive más comparte más', kind: 'user', source: 'user', id: 'pending', pending: true },
  ]);
  assert.equal(ranges.length, 2);
});

test('overlapping marks are cut at every boundary, the reader\'s on top and the model\'s remembered underneath', () => {
  // user: 4..14, ai: 10..20 over 'abcdefghijklmnopqrstuv'
  const segments = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', [
    { start: 4, end: 14, kind: 'user', source: 'user', id: 'u' },
    { start: 10, end: 20, kind: 'finding', source: 'ai', id: 'a' },
  ]);
  assert.deepEqual(segments.map(s => [s.type, s.value, s.source || null, s.under || null]), [
    ['text', 'abcd', null, null],
    ['mark', 'efghij', 'user', []],
    ['mark', 'klmn', 'user', ['ai']],
    ['mark', 'opqrst', 'ai', []],
    ['text', 'uv', null, null],
  ]);
  // The reader's mark wins the top even when the model's range started first.
  const reversed = segmentTextChunk(0, 'abcdefghijklmnopqrstuv', [
    { start: 4, end: 14, kind: 'finding', source: 'ai', id: 'a' },
    { start: 10, end: 20, kind: 'user', source: 'user', id: 'u' },
  ]);
  assert.deepEqual(reversed.map(s => [s.value, s.source, s.under]), [
    ['abcd', undefined, undefined],
    ['efghij', 'ai', []],
    ['klmn', 'user', ['ai']],
    ['opqrst', 'user', []],
    ['uv', undefined, undefined],
  ]);
});

test('a plan with overlapping marks still concatenates back to the text and carries `under` on maths', () => {
  const text = 'usan una fórmula $S = 1$ entre pares y la comparan';
  const plan = buildHighlightPlan(text, [
    { quote: 'una fórmula $S = 1$ entre', kind: 'finding', source: 'ai' },
    { quote: 'fórmula $S = 1$ entre pares', kind: 'user', source: 'user', pending: true },
  ]);
  const rebuilt = plan.map(item => item.type === 'math' ? item.raw : item.value).join('');
  assert.equal(rebuilt, 'usan una fórmula $S = 1$ entre pares y la comparan');
  const math = plan.find(item => item.type === 'math');
  assert.equal(math.source, 'user', 'the pending selection paints the formula');
  assert.deepEqual(math.under, ['ai']);
  assert.ok(plan.every(item => item.type === 'text' || Array.isArray(item.under)));
});
```

- [x] **Step 2: Comprobar que fallan**

Run: `node --test src/utils/textHighlights.test.js`
Expected: 4 fallos (el primero espera 2 rangos y recibe 1; el de fronteras espera `under`).

- [x] **Step 3: Implementar el motor**

En `src/utils/textHighlights.js`, sustituir `resolveHighlightRanges`, `segmentTextChunk` y el
bloque de maths de `buildHighlightPlan`:

```js
/**
 * Which of two ranges covering the same characters paints them.
 *
 * The reader's own marks sit over the model's: a selection still deciding
 * what it wants to become is the topmost thing on the page, then a highlight
 * the reader made, then a passage the model proposed. Ties keep document
 * order. Whatever is underneath is not lost: the segment remembers it in
 * `under`, and the renderer keeps the model's underline running beneath the
 * reader's wash.
 */
function layerRank(range) {
  if (range.pending) return 0;
  return range.source === 'user' ? 1 : 2;
}

function byLayer(a, b) {
  return layerRank(a) - layerRank(b) || a.start - b.start;
}

export function resolveHighlightRanges(text, highlights = []) {
  const normalized = normalizeLatexText(text);
  if (!normalized) return [];

  const ranges = [];
  for (const highlight of highlights) {
    const quote = normalizeHighlightQuote(highlight?.quote);
    if (quote.length < MIN_QUOTE_LENGTH) continue;
    const source = highlight?.source || 'ai';
    const pending = Boolean(highlight?.pending);

    // Prefer the first occurrence not already marked BY THE SAME SOURCE, so
    // repeated phrasing marks each mention rather than piling onto the first.
    // A mark of the other source does not claim the text: a reader may well
    // select the sentence the model proposed, and both then have to show. A
    // pending selection sits on anything, its own saved mark included.
    const claimed = range => !pending && !range.pending && range.source === source;
    let searchFrom = 0;
    let start = -1;
    for (;;) {
      const candidate = normalized.indexOf(quote, searchFrom);
      if (candidate === -1) break;
      const end = candidate + quote.length;
      const overlaps = ranges.some(range => claimed(range) && candidate < range.end && end > range.start);
      if (!overlaps) {
        start = candidate;
        break;
      }
      searchFrom = candidate + 1;
    }
    if (start === -1) continue;

    ranges.push({
      start,
      end: start + quote.length,
      kind: highlight?.kind || 'finding',
      source,
      id: highlight?.id || null,
      fresh: Boolean(highlight?.fresh),
      pending,
      proposed: Boolean(highlight?.proposed),
    });
  }

  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Cuts one text chunk into plain and marked segments.
 * `chunkStart` is the chunk's offset within the normalized text.
 *
 * Cut at every boundary any range draws inside the chunk, so two ranges that
 * overlap yield three segments — one for each, one for the shared stretch —
 * and the shared stretch is painted by the topmost (`byLayer`) with the rest
 * remembered in `under`. Ranges spanning maths are clipped to the chunk; the
 * maths between stays intact (see `buildHighlightPlan`).
 */
export function segmentTextChunk(chunkStart, value, ranges) {
  const chunkEnd = chunkStart + value.length;
  const overlapping = ranges.filter(range => range.start < chunkEnd && range.end > chunkStart);
  if (overlapping.length === 0) {
    return [{ type: 'text', value, start: chunkStart, end: chunkEnd }];
  }

  const cuts = new Set([chunkStart, chunkEnd]);
  for (const range of overlapping) {
    cuts.add(Math.max(range.start, chunkStart));
    cuts.add(Math.min(range.end, chunkEnd));
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end <= start) continue;
    const slice = value.slice(start - chunkStart, end - chunkStart);
    const covering = overlapping.filter(range => range.start <= start && range.end >= end).sort(byLayer);
    if (covering.length === 0) {
      segments.push({ type: 'text', value: slice, start, end });
      continue;
    }
    const [top, ...rest] = covering;
    segments.push({
      type: 'mark',
      value: slice,
      start,
      end,
      kind: top.kind,
      source: top.source,
      id: top.id,
      fresh: top.fresh,
      pending: top.pending,
      proposed: top.proposed,
      under: rest.map(range => range.source),
    });
  }
  return segments;
}
```

y en `buildHighlightPlan`, el bloque de maths:

```js
    const mathEnd = offset + chunk.raw.length;
    // Whole or not at all. A formula cannot be marked in half — there is no
    // character in `x²` that corresponds to the middle of `$x^2$` — so only a
    // range that swallows the entire chunk paints it; the topmost of them does.
    const [covering, ...beneath] = ranges
      .filter(range => range.start <= offset && range.end >= mathEnd)
      .sort(byLayer);
    plan.push({
      type: 'math',
      value: chunk.value,
      raw: chunk.raw,
      display: chunk.display,
      start: offset,
      end: mathEnd,
      kind: covering?.kind || null,
      source: covering?.source || null,
      id: covering?.id || null,
      fresh: Boolean(covering?.fresh),
      pending: Boolean(covering?.pending),
      proposed: Boolean(covering?.proposed),
      under: beneath.map(range => range.source),
    });
    offset = mathEnd;
```

- [x] **Step 4: Comprobar que pasan**

Run: `node --test src/utils/textHighlights.test.js`
Expected: todos en verde, incluidos los 14 anteriores.

- [x] **Step 5: Test SOURCE del renderizador y la hoja (falla)**

Crear `src/components/Reader/highlightLayers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * A selection over a sentence the model had underlined used to take the
 * underline away: `resolveHighlightRanges` dropped whichever range came
 * second, and the reader's own marks come first. Measured 2026-09-17 (see
 * docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md): the AI mark count went
 * 1 -> 0 the frame the provisional wash painted, and stayed 0 once saved.
 * The engine now keeps both and says who is underneath; this pins the two
 * halves that make it visible.
 */
test('a mark the reader lays over a model underline keeps the underline running beneath it', async () => {
  const jsx = stripComments(await read('./HighlightedScientificText.jsx'));
  assert.match(jsx, /item\.under\?\.includes\('ai'\) && item\.source !== 'ai' \? 'rd-mark--over-ai' : ''/);
  const css = stripComments(await read('./PaperReader.css'));
  const rule = css.match(/\.rd-mark--over-ai\.rd-mark--over-ai \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /box-shadow: inset 0 -2px 0 var\(--accent-primary\);/);
  // After the rule that takes the box-shadow off the reader's own marks, or it loses.
  assert.ok(css.indexOf('.rd-mark--user.rd-mark--user {') < css.indexOf('.rd-mark--over-ai.rd-mark--over-ai {'));
});
```

Run: `node --test src/components/Reader/highlightLayers.test.js` → FAIL.

- [x] **Step 6: Renderizador y hoja**

En `src/components/Reader/HighlightedScientificText.jsx`, `markClassFor`:

```js
        const markClassFor = kind => [
          'rd-mark',
          `rd-mark--${kind}`,
          `rd-mark--${item.source}`,
          item.pending ? 'rd-mark--pending' : '',
          // The model's underline goes on running under the reader's own mark
          // (utils/textHighlights.js keeps both and says which is beneath).
          item.under?.includes('ai') && item.source !== 'ai' ? 'rd-mark--over-ai' : '',
        ].filter(Boolean).join(' ');
```

En `src/components/Reader/PaperReader.css`, justo después de `.rd-mark--user.rd-mark--user { box-shadow: none; }`:

```css
/* The reader's mark over a passage the model underlined keeps that underline:
   without it, selecting the one sentence the model found interesting — the
   likeliest sentence to select — erased the model's mark on the spot. Doubled
   for the specificity of the rule above that takes the reader's shadow off. */
.rd-mark--over-ai.rd-mark--over-ai {
  box-shadow: inset 0 -2px 0 var(--accent-primary);
}
```

- [x] **Step 7: Tests y lint**

Run: `node --test src/utils/textHighlights.test.js src/components/Reader/highlightLayers.test.js src/components/Reader/readerAnnotationMotion.test.js && npx eslint src/utils/textHighlights.js src/components/Reader/HighlightedScientificText.jsx src/utils/textHighlights.test.js src/components/Reader/highlightLayers.test.js`
Expected: verde y sin avisos.

- [x] **Step 8: Commit**

```bash
git add src/utils/textHighlights.js src/utils/textHighlights.test.js src/components/Reader/HighlightedScientificText.jsx src/components/Reader/PaperReader.css src/components/Reader/highlightLayers.test.js
git commit -m "fix(lector): un subrayado propio sobre una frase de la IA conserva el subrayado de la IA debajo"
```

---

### Task 2: el menú sigue a cada nueva selección

**Files:**
- Modify: `src/components/Reader/SelectionMenu.jsx` (el ancla y el reset del compositor)
- Test: `src/components/Reader/selectionMenuAnchor.test.js` (nuevo)

**Interfaces:**
- Consumes: la prop `anchor` (`{ left, top, right, bottom }` o `undefined`), como hoy.
- Produces: `PopoverPrimitive.Positioner` recibe `anchor={anchorElement}`, un elemento virtual
  nuevo por cada selección y el último conservado mientras `anchor` es `undefined`.

- [x] **Step 1: Test SOURCE que falla**

Crear `src/components/Reader/selectionMenuAnchor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The menu used to hand Base UI a stable FUNCTION as its anchor, and Base UI
 * resolves a function anchor when the popup mounts and not again. Select
 * another sentence while the menu is still leaving — a double-click on a
 * word, a short drag — and the popup reopened on the previous selection's
 * rectangle, 300px from the new provisional mark (measured 2026-09-17, see
 * docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md). The anchor is a VALUE now,
 * latched in render so it changes with every selection and is kept through
 * the leave; Base UI re-anchors on the change. A new selection also puts the
 * composer away: the previous one's draft is not this one's.
 */
test('the selection menu re-anchors on every new selection and keeps the last rectangle through its leave', async () => {
  const jsx = stripComments(await read('./SelectionMenu.jsx'));
  assert.match(jsx, /const \[anchorSeen, setAnchorSeen\] = useState\(anchor\);/);
  assert.match(jsx, /const \[anchorElement, setAnchorElement\] = useState\(\(\) => virtualAnchor\(anchor\)\);/);
  assert.match(jsx, /if \(anchor && anchor !== anchorSeen\) \{\s*setAnchorSeen\(anchor\);\s*setAnchorElement\(virtualAnchor\(anchor\)\);\s*setComposing\(false\);\s*setDraft\(''\);\s*\}/);
  assert.match(jsx, /anchor=\{anchorElement\}/);
  assert.doesNotMatch(jsx, /anchorRef|resolveAnchor/);
});
```

Run: `node --test src/components/Reader/selectionMenuAnchor.test.js` → FAIL.

- [x] **Step 2: Implementar**

En `src/components/Reader/SelectionMenu.jsx`, sustituir el bloque `anchorRef` / `resolveAnchor`:

```js
  // The rectangle the menu is anchored to, as a value Base UI re-reads. It
  // was a stable function returning the latest rectangle, and Base UI only
  // resolves a function anchor when the popup mounts: select another sentence
  // while the menu is still leaving — a double-click, a short drag — and it
  // reopened over the previous selection (measured 2026-09-17). Latched in
  // render, the documented way to derive state from a prop: it changes with
  // every selection, so Base UI re-anchors, and it is kept while `anchor` is
  // gone, so the leave still points at the passage it was about. A new
  // selection also puts the composer away — the draft was about the last one.
  const [anchorSeen, setAnchorSeen] = useState(anchor);
  const [anchorElement, setAnchorElement] = useState(() => virtualAnchor(anchor));
  if (anchor && anchor !== anchorSeen) {
    setAnchorSeen(anchor);
    setAnchorElement(virtualAnchor(anchor));
    setComposing(false);
    setDraft('');
  }
```

(los `useState` de `composing` y `draft` deben quedar declarados ANTES de este bloque). Quitar
`useCallback` y `useRef` de los imports si dejan de usarse (`useRef` sigue en uso por
`textareaRef` y `firstActionRef`; `useCallback` no) y en el Positioner:

```jsx
        <PopoverPrimitive.Positioner
          anchor={anchorElement}
```

Actualizar el comentario de cabecera del componente («handed over as a virtual element»): sigue
siendo cierto; añadir «re-anchored on every selection».

- [x] **Step 3: Tests y lint**

Run: `node --test src/components/Reader/selectionMenuAnchor.test.js src/components/Reader/selectionMenuAccessibility.test.js src/components/Reader/paperReaderKeyboardAnnotation.test.js src/components/Reader/readerAnnotationMotion.test.js && npx eslint src/components/Reader/SelectionMenu.jsx src/components/Reader/selectionMenuAnchor.test.js`
Expected: verde.

- [x] **Step 4: Commit**

```bash
git add src/components/Reader/SelectionMenu.jsx src/components/Reader/selectionMenuAnchor.test.js
git commit -m "fix(lector): el menú de selección sigue a cada nueva selección en vez de quedarse en la anterior"
```

---

### Task 3: la selección se resuelve desde el propio Range, se suelte donde se suelte

**Files:**
- Modify: `src/components/Reader/PaperReader.jsx` (efecto `mouseup` de documento tras
  `handleParagraphKeyDown`; el `<p>` pierde `onMouseUp`)
- Modify: `src/components/Reader/paperReaderKeyboardAnnotation.test.js:80-96` (el test de la ruta de ratón)
- Test: `src/components/Reader/readerMouseSelection.test.js` (nuevo)

**Interfaces:**
- Consumes: `handleSelection(sectionId, paragraphIndex, paragraphText, paragraphNode)` (sin cambios),
  `sections` (estado), `scrollRef`, `selectionRoute`.
- Produces: nada nuevo para otros ficheros.

- [x] **Step 1: Actualizar el test de la ruta de ratón y añadir el nuevo (fallan)**

En `src/components/Reader/paperReaderKeyboardAnnotation.test.js`, sustituir el test
`'the mouse route is unchanged: paragraphs still wire onMouseUp to handleSelection'` por:

```js
test('the mouse route is unchanged in shape: handleSelection keeps its signature and the paragraph no longer owns the mouse-up', async () => {
  const jsx = await read('./PaperReader.jsx');

  assert.doesNotMatch(
    jsx,
    /onMouseUp=\{\(event\) => handleSelection\(/,
    'the mouse-up moved to the document (readerMouseSelection.test.js); a paragraph handler would '
    + 'bring back the release-outside-the-paragraph gap.',
  );

  assert.match(
    jsx,
    /const handleSelection = useCallback\(\(sectionId, paragraphIndex, paragraphText, paragraphNode\) => \{/,
    'handleSelection changed shape; update this test alongside it',
  );
});
```

Crear `src/components/Reader/readerMouseSelection.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * The mouse-up that turns a selection into the menu lived on each paragraph,
 * so a drag released on the section title, in the margin or in the gap
 * between paragraphs — where a drag to the end of a sentence usually ends —
 * opened nothing and left the browser's blue selection on the page
 * (measured 2026-09-17, see docs/AUDITORIA-LECTOR-SELECCION-2026-09-17.md).
 * The document listens now, and the paragraph is read off the selection
 * itself: the one that holds where the selection STARTS, which also fixes a
 * selection across two paragraphs quoting from the wrong one.
 */
test('a mouse selection is resolved from the Range, from the paragraph it starts in, wherever the button is released', async () => {
  const jsx = stripComments(await read('./PaperReader.jsx'));
  assert.match(jsx, /document\.addEventListener\('mouseup', handleDocumentMouseUp\);/);
  assert.match(jsx, /return \(\) => document\.removeEventListener\('mouseup', handleDocumentMouseUp\);/);
  // The paragraph is the one the selection starts in, inside the reader's own scroller.
  assert.match(jsx, /const start = selection\.getRangeAt\(0\)\.startContainer;/);
  assert.match(jsx, /\.closest\('\.rd-p\[data-section\]'\)/);
  assert.match(jsx, /if \(!paragraph \|\| !scrollRef\.current\?\.contains\(paragraph\)\) return;/);
  // Only on the route that has a menu to open.
  assert.match(jsx, /if \(selectionRoute !== 'menu'\) return undefined;/);
  // The paragraph's source text comes from state by the ids the DOM carries.
  assert.match(jsx, /const paragraphTextFor = useCallback\(\(sectionId, paragraphIndex\) => \{/);
  assert.match(jsx, /handleSelection\(paragraph\.dataset\.section, paragraphIndex, text, paragraph\);/);
  // Keyboard route untouched.
  assert.match(jsx, /onKeyDown=\{selectionRoute === 'menu'\s*\? \(event\) => handleParagraphKeyDown\(event, section\.id, paragraphIndex, paragraph\)/);
});
```

Run: `node --test src/components/Reader/readerMouseSelection.test.js src/components/Reader/paperReaderKeyboardAnnotation.test.js` → los dos nuevos/actualizados FALLAN.

- [x] **Step 2: Implementar**

En `src/components/Reader/PaperReader.jsx`, después de `handleParagraphKeyDown` (tras su
`}, [beginAnnotation, uid]);`) añadir:

```js
  /** The source text of a paragraph, by the ids its `<p>` carries. */
  const paragraphTextFor = useCallback((sectionId, paragraphIndex) => {
    const section = sections.find(item => String(item.id) === String(sectionId));
    const text = section?.paragraphs?.[paragraphIndex];
    return typeof text === 'string' ? text : null;
  }, [sections]);

  /**
   * The mouse-up that decides a selection, on the document rather than on the
   * paragraph. It lived on each `<p>`, so a drag released on the section
   * title, in the margin or in the gap between paragraphs — where a drag to
   * the end of a sentence usually ends — reached no handler: no menu, no
   * provisional mark, and the browser's own selection left on the page
   * (measured 2026-09-17). The paragraph is read off the selection itself:
   * the one holding where it STARTS, so a selection that crosses into the
   * next paragraph quotes from where the reader began and is clipped to that
   * paragraph's end (`anchorFromSelection` only walks the paragraph it is
   * given). Releases over the menu, the rail or a text field find no
   * paragraph and do nothing, as before. Fine pointers only, like the menu.
   */
  useEffect(() => {
    if (selectionRoute !== 'menu') return undefined;
    const handleDocumentMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const start = selection.getRangeAt(0).startContainer;
      const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
      const paragraph = element?.closest('.rd-p[data-section]');
      if (!paragraph || !scrollRef.current?.contains(paragraph)) return;
      const paragraphIndex = Number(paragraph.dataset.paragraph);
      const text = paragraphTextFor(paragraph.dataset.section, paragraphIndex);
      if (text === null) return;
      handleSelection(paragraph.dataset.section, paragraphIndex, text, paragraph);
    };
    document.addEventListener('mouseup', handleDocumentMouseUp);
    return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
  }, [handleSelection, paragraphTextFor, selectionRoute]);
```

y en el `<p>` de cada párrafo quitar la línea
`onMouseUp={(event) => handleSelection(section.id, paragraphIndex, paragraph, event.currentTarget)}`.
Actualizar el comentario de `handleSelection` («mouse-up on the desktop route» sigue siendo
cierto; añadir «raised by the document listener below»).

- [x] **Step 3: Tests y lint**

Run: `node --test src/components/Reader/readerMouseSelection.test.js src/components/Reader/paperReaderKeyboardAnnotation.test.js src/components/Reader/readerOverlays.test.js src/components/Reader/readerAnnotationMotion.test.js && npx eslint src/components/Reader/PaperReader.jsx src/components/Reader/readerMouseSelection.test.js src/components/Reader/paperReaderKeyboardAnnotation.test.js`
Expected: verde. Si eslint pide `Node` como global, usar `start.nodeType === 1`.

- [x] **Step 4: Commit**

```bash
git add src/components/Reader/PaperReader.jsx src/components/Reader/paperReaderKeyboardAnnotation.test.js src/components/Reader/readerMouseSelection.test.js
git commit -m "fix(lector): la selección con ratón abre el menú se suelte donde se suelte, desde el párrafo donde empieza"
```

---

### Task 4: verificación sobre la build con la sesión real

**Files:**
- Ninguno del repo. Sondas del scratchpad: `reader-scenarios-probe.mjs`.

- [x] **Step 1: Build y servidor**

Run: `npx vite build` y `preview_start` con `papertok-preview-5174` (o `npx vite preview --port 5174 --strictPort`).

- [x] **Step 2: Escenarios**

Run: `PROFILE_DIR=~/.papertok-probe-profile ORIGIN=http://localhost:5174 PORT=9243 node reader-scenarios-probe.mjs fix`
Expected, por escenario:
- `A-plain`: menú abierto, 1 marca provisional (control, igual que antes).
- `B-overlap-ai`: **aiMarks 1 → 1**; la marca provisional existe; el tramo compartido lleva `rd-mark--over-ai` (ampliar la sonda para leer `className` de las marcas provisionales).
- `C-across-math`: igual que antes (tres marcas provisionales).
- `D-release-outside`: **menú abierto**, marca provisional en el párrafo 2, selección nativa retirada.
- `E-cross-paragraph`: marca provisional en el **párrafo 0** desde donde empezó el arrastre hasta su final.
- `F` y `F2`: igual que antes.
- `J-escapes`: aiMarks 2 → 2; la marca provisional empieza en «frente».
- `G-reselect`: `menu.rect.top` ≈ `pending.rect.bottom + 8` (el `sideOffset`), no el rectángulo anterior.
- `H-highlight`: `rdPenDown` corre; la marca guardada sobre la frase de la IA (repetir H sobre el párrafo 0 solapando el subrayado de la IA) conserva `aiMarks`.
- `I-ask`: igual que antes (tarjeta pensando, `rdWriteIn`, marca de la IA).
- Limpieza: `notesLeft 0`.

- [x] **Step 3: Suite completa y lint**

Run: `npm test` → 0 fallos. `npx eslint src/components/Reader src/utils/textHighlights.js`.

- [x] **Step 4: Memoria y cierre**

Anotar en la memoria del proyecto el mecanismo de Base UI (ancla-función solo se resuelve al
montar) y el arnés de escenarios; informar con las medidas antes/después.

---

## Resultado (17-09-2026, ejecutado en la misma sesión)

Sonda de escenarios sobre la build de producción, sesión real, reescritura y explicación
contestadas en local (ningún uso de IA gastado; los subrayados escritos se quitaron desde el raíl,
`notesLeft 0`):

| Escenario | Antes | Después |
|---|---|---|
| D · soltar en el hueco bajo el párrafo | sin menú, selección nativa viva | menú abierto, marca desde el inicio del arrastre hasta el fin del párrafo |
| D2 · soltar en el hueco sobre el párrafo | — | menú abierto, marca desde el inicio del párrafo hasta donde acabó el arrastre |
| E · cruzar dos párrafos | cita desde el INICIO del párrafo de llegada | cita desde donde empezó el ratón, recortada al fin de su párrafo |
| G · seleccionar otra frase con el menú aún en pantalla | menú en el rectángulo anterior (300 px de la marca) | `menu.top = pending.bottom + 8` |
| B · seleccionar sobre una frase subrayada por la IA | subrayado de la IA desaparece (1 → 0) | dos tramos provisionales; el compartido lleva `rd-mark--over-ai` y el subrayado de tinta |
| H2 · guardar un subrayado sobre esa frase | subrayado de la IA perdido para siempre | marca guardada con el subrayado de la IA debajo (`underline: true`) |
| H · trazo del rotulador | `rdPenDown` 0 → 420 ms | igual (26 fotogramas, 0 → 417 ms) |
| I · explicar | tarjeta pensando, `rdWriteIn` 0 → 620 ms | igual (38 fotogramas, 0 → 617 ms) |

Tests: `node --test` de los ficheros tocados en verde; suite completa en verde (ver el informe de
la sesión); eslint limpio.
