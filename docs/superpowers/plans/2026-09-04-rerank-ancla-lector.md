# El re-ranking respeta la tarjeta del lector — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una recarga del feed deje al lector en el paper en que estaba, sin que uno o tres segundos después ese paper sea sustituido por otro.

**Architecture:** El re-ranking del feed (`reRankFeed` en `FeedContext.jsx`) bloquea las tarjetas «en pantalla o siguientes» y rebaraja el resto. Hoy, sin paper de referencia, da por hecho que el lector está en el índice 0 y bloquea solo las tres primeras tarjetas. Desde que una recarga devuelve al lector a su sitio (586b827, 2026-09-03), ese sitio suele estar más allá del índice 2, y la llamada sin referencia que dispara la carga del perfil semántico (línea 906, añadida en ade641a, 2026-09-01) rebaraja la tarjeta bajo el viewport. El arreglo tiene tres piezas: (1) una función pura que decide dónde partir la lista a partir de uno o varios paper ids de anclaje, tomando siempre el más profundo; (2) el contexto del feed recuerda en un ref qué paper está visible y lo usa como anclaje en todo re-ranking, junto con el paper de la interacción si lo hay; (3) el contenedor del feed informa de ese paper al restaurar el sitio tras una recarga y en cada scroll.

**Tech Stack:** React 19 + Vite 8, tests con `node:test` y `node:assert/strict` (los componentes React no se montan bajo node; sus contratos se fijan con tests de fuente sobre el código sin comentarios, como en `feedResume.test.js`). CI corre Node 22; en local hay Node 25.

**Spec:** Este mismo documento, sección «Diagnóstico». No hay documento de diseño aparte: el bug se diagnosticó en la sesión del 2026-09-04 y el diagnóstico cabe aquí.

## Global Constraints

- Node 22 en CI: nada de APIs solo de Node 25.
- Tests con `node --test <fichero>`; la suite completa con `npm test`. Antes del último commit, `npm run check` (secretos, lint, tests, build y `wrangler deploy --dry-run`).
- Otra sesión de Claude puede estar editando el mismo árbol: antes de cada commit, `git status --short` y `git diff <fichero>` fichero a fichero, y `git add` solo de los ficheros de la tarea.
- Mensajes de commit en español, con prefijo `fix(feed):` / `test(feed):`, y trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Comentarios de código en inglés, como el resto de cada fichero. Un comentario que cite el motivo medido (fecha y commit) vale más que uno que describa el código.
- Los tests de fuente corren sobre el código **sin comentarios** (`stripComments`) y acotan la captura con `bounded(...)`; un comentario que cite la solución no puede hacer pasar el test.
- El frontend se despliega en Vercel al hacer push a `main`, y Vercel no espera a los tests. **Hacer push es una acción hacia fuera: pedir confirmación al usuario antes.**
- No tocar el radio de bloqueo (tres tarjetas por delante del anclaje): es el comportamiento medido y documentado en el comentario de `reRankFeed`.

## Diagnóstico

Síntoma (reportado el 2026-09-04): al recargar `papertok.app`, el feed muestra el último paper que el lector había visto y, al cabo de un momento, lo cambia por otro.

Cadena de causas, verificada leyendo el código:

1. `FeedContext.jsx:1533-1553` restaura la lista desde la instantánea en localStorage (`readFeedSnapshot`). `FeedContainer.jsx:240-260` restaura el scroll al paper guardado en sessionStorage (`resumeMemory`, `resumeIndex`). Eso es lo primero que se ve, y es correcto.
2. El efecto «Load user interactions» (`FeedContext.jsx:~720-915`) carga el perfil de Firestore y programa en idle (`requestIdleCallback`, timeout 2500 ms) el perfil semántico de OpenAlex. Al terminar llama a `reRankFeedRef.current()` **sin paper de referencia** (`FeedContext.jsx:906`). Esa llamada ocurre en cada recarga, haya o no papers positivos.
3. `reRankFeed` (`FeedContext.jsx:524-549`): sin `sourcePaperId`, `splitIndex = 0`, `safeSplit = 3`. Bloquea los índices 0–2 y pasa el resto por `diversifiedWeightedShuffle`.
4. El scroll sigue en el mismo píxel, pero el paper que ocupa ese índice ya es otro.

Descartados: los tres enriquecimientos tardíos (OpenAlex, iCite, Europe PMC, `FeedContext.jsx:1460-1500`) fusionan campos sin cambiar el orden; el refresco completo `loadPapers(true, null, true)` no se dispara en montaje frío (`isColdMount`, `FeedContext.jsx:1577`). Este mismo síntoma se arregló el 2026-08-22 para el refresco de fuentes (comentario en `FeedContext.jsx:1555-1562`); el re-ranking del perfil semántico lo reintrodujo por otra vía.

La segunda llamada sin referencia, la del cambio de seguidos (`FeedContext.jsx:1615`), tiene el mismo defecto y queda cubierta por el mismo arreglo.

## Decisiones de diseño

- **El anclaje es el más profundo de los candidatos.** Un re-ranking puede llegar con el paper de la interacción (like, skip, leído) y, además, el contexto conoce el paper visible. Se bloquea hasta el índice mayor de los dos más tres tarjetas. Si ninguno está en la lista (feed recién vaciado, interacción desde la biblioteca), se parte en 0 como hasta ahora.
- **Un ref, no estado.** El paper visible cambia en cada evento de scroll; guardarlo en estado re-renderizaría el proveedor y a todos sus consumidores. `reRankFeed` lo lee dentro del `setPapers` funcional, así que un ref basta y `reRankFeed` no cambia de identidad.
- **Solo el feed For You informa.** `FeedContainer` también sirve a Siguiendo (`source` distinto de null) y al feed de invitado (`publicMode`). Esas listas no son la del contexto; sus papers no se informan.
- **Informar en la restauración, no solo en el scroll.** Asignar `scrollTop` dispara un evento de scroll, pero de forma asíncrona y no en todos los navegadores por igual. El efecto de restauración informa del paper resumido directamente, para que el anclaje exista antes de que el perfil termine de cargar.

## Fuera del alcance (y por qué)

- **La expansión por grafo** (`FeedContext.jsx:684-706`) hace su propio corte en `idx + 3` alrededor del paper interactuado. Lo dispara una interacción sobre ese paper, así que el lector está ahí; no reproduce el síntoma. Si se unifica, que sea en otro cambio.
- **El refresco tras un cambio de seguidos** (`FeedContext.jsx:1616-1621`) sustituye la lista entera a propósito; ese comportamiento ya está comentado como intencional.

## Mapa de ficheros

- Create: `src/utils/feedReRankSplit.js` — función pura `splitFeedForReRank`.
- Create: `src/utils/feedReRankSplit.test.js` — tests de comportamiento (no de fuente) de esa función.
- Modify: `src/context/FeedContext.jsx:524-549` (`reRankFeed`), imports, y el `value` del contexto en `:2230-2250`.
- Create: `src/context/feedReRankAnchor.test.js` — tests de fuente del cableado en el contexto.
- Modify: `src/components/Feed/FeedContainer.jsx:240-260` (restauración) y `:387-410` (`handleScroll`).
- Modify: `src/components/Feed/feedResume.test.js` — dos marcadores de fin de captura cambian porque cambian las dependencias de dos hooks, y se añade un test del informe.

---

### Task 1: La función pura que parte la lista alrededor del lector

**Files:**
- Create: `src/utils/feedReRankSplit.js`
- Create: `src/utils/feedReRankSplit.test.js`

**Interfaces:**
- Produces: `splitFeedForReRank(papers, { anchorPaperIds = [], lookahead = RERANK_LOOKAHEAD } = {}) → { anchorIndex: number, locked: Paper[], queue: Paper[] }` y la constante `RERANK_LOOKAHEAD = 3`. `locked` son las primeras `min(anchorIndex + lookahead, papers.length)` entradas; `queue` el resto. `anchorIndex` es el mayor índice de los ids de `anchorPaperIds` presentes en `papers`, o 0 si ninguno lo está.

- [ ] **Step 1: Escribir los tests, que fallan porque el módulo no existe**

Crear `src/utils/feedReRankSplit.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RERANK_LOOKAHEAD, splitFeedForReRank } from './feedReRankSplit.js';

const papers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
const ids = (list) => list.map(paper => paper.id);

test('without an anchor the split is at the top, three cards deep, as before', () => {
  const { anchorIndex, locked, queue } = splitFeedForReRank(papers(10));
  assert.equal(RERANK_LOOKAHEAD, 3);
  assert.equal(anchorIndex, 0);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2']);
  assert.deepEqual(ids(queue), ['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
});

test('the resumed card stays locked: a reader at index 5 keeps 0..7 in place', () => {
  const list = papers(10);
  const { anchorIndex, locked, queue } = splitFeedForReRank(list, { anchorPaperIds: ['p5'] });
  assert.equal(anchorIndex, 5);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
  assert.deepEqual(ids(queue), ['p8', 'p9']);
  assert.ok(locked.includes(list[5]), 'the card under the viewport is never in the shuffled queue');
});

test('with several anchors the deepest one wins', () => {
  const { anchorIndex } = splitFeedForReRank(papers(10), { anchorPaperIds: ['p2', 'p6', 'p4'] });
  assert.equal(anchorIndex, 6);
  const reversed = splitFeedForReRank(papers(10), { anchorPaperIds: ['p6', 'p2'] });
  assert.equal(reversed.anchorIndex, 6, 'order of the anchors does not matter');
});

test('anchors that are not in the list, null or undefined are ignored', () => {
  const { anchorIndex, locked } = splitFeedForReRank(papers(10), { anchorPaperIds: [null, undefined, 'nope', 'p1'] });
  assert.equal(anchorIndex, 1);
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2', 'p3']);
});

test('an anchor near the end locks everything and leaves an empty queue', () => {
  const { locked, queue } = splitFeedForReRank(papers(5), { anchorPaperIds: ['p4'] });
  assert.equal(locked.length, 5);
  assert.deepEqual(queue, []);
});

test('a short or empty list never throws', () => {
  assert.deepEqual(splitFeedForReRank([], { anchorPaperIds: ['p0'] }), { anchorIndex: 0, locked: [], queue: [] });
  assert.deepEqual(splitFeedForReRank(undefined), { anchorIndex: 0, locked: [], queue: [] });
  const one = splitFeedForReRank(papers(1));
  assert.deepEqual(ids(one.locked), ['p0']);
  assert.deepEqual(one.queue, []);
});

test('the lookahead is configurable', () => {
  const { locked } = splitFeedForReRank(papers(10), { anchorPaperIds: ['p2'], lookahead: 1 });
  assert.deepEqual(ids(locked), ['p0', 'p1', 'p2']);
});
```

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/utils/feedReRankSplit.test.js`
Expected: fallo de carga del módulo (`Cannot find module '.../feedReRankSplit.js'`).

- [ ] **Step 3: Implementar la función**

Crear `src/utils/feedReRankSplit.js`:

```js
/**
 * Where a re-rank may start shuffling.
 *
 * A re-rank locks the cards the reader is on or about to reach and shuffles
 * the rest. The lock used to start at the paper the interaction named, or at
 * index 0 when there was none — which assumed the reader was at the top.
 * Since a reload puts the reader back on the card they left (586b827,
 * 2026-09-03), that place is usually deeper, and the profile load's anchorless
 * re-rank (ade641a) shuffled the very card under the viewport 1–3 s after the
 * reload (reported 2026-09-04). The split now takes every anchor it is given
 * — the interacted paper, the visible paper — and locks through the deepest.
 */
export const RERANK_LOOKAHEAD = 3;

export function splitFeedForReRank(papers, { anchorPaperIds = [], lookahead = RERANK_LOOKAHEAD } = {}) {
  const list = Array.isArray(papers) ? papers : [];
  let anchorIndex = 0;
  for (const id of anchorPaperIds) {
    if (!id) continue;
    const found = list.findIndex(paper => paper?.id === id);
    if (found > anchorIndex) anchorIndex = found;
  }
  const safeSplit = Math.min(anchorIndex + lookahead, list.length);
  return {
    anchorIndex,
    locked: list.slice(0, safeSplit),
    queue: list.slice(safeSplit),
  };
}
```

- [ ] **Step 4: Comprobar que pasan**

Run: `node --test src/utils/feedReRankSplit.test.js`
Expected: 7 tests, todos `ok`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/utils/feedReRankSplit.js src/utils/feedReRankSplit.test.js
git commit -m "feat(feed): el corte del re-ranking se calcula a partir de la tarjeta más profunda entre las de anclaje

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: El contexto recuerda el paper visible y ancla en él todo re-ranking

**Files:**
- Modify: `src/context/FeedContext.jsx:524-549` (`reRankFeed`), la lista de imports al principio del fichero, y el `value` en `:2230-2250`.
- Create: `src/context/feedReRankAnchor.test.js`

**Interfaces:**
- Consumes: `splitFeedForReRank` y `RERANK_LOOKAHEAD` de `src/utils/feedReRankSplit.js` (Task 1).
- Produces: `reportVisiblePaper(paperId: string | null): void` en el valor de `useFeed()`. Guarda el id en un ref; nunca provoca render. `reRankFeed(sourcePaperId = null)` conserva su firma y ancla en `[sourcePaperId, visiblePaperIdRef.current]`.

- [ ] **Step 1: Escribir los tests de fuente, que fallan**

Crear `src/context/feedReRankAnchor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

function bounded(code, from, to, label, maxLines) {
  const start = code.indexOf(from);
  const end = code.indexOf(to, start + 1);
  assert.ok(start >= 0 && end > start, `expected to have found ${label}`);
  const block = code.slice(start, end);
  const lines = block.split('\n').length;
  assert.ok(lines <= maxLines, `${label} capture spans ${lines} lines, past what it names`);
  return block;
}

/**
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin the contract of the re-rank anchor.
 *
 * A reload puts the reader back on the card they left. The profile load then
 * re-ranks with no source paper, and the old split at index 0 shuffled that
 * very card away 1–3 s after the reload (2026-09-04). The re-rank must lock
 * through the visible card, whatever paper the interaction names.
 */
test('SOURCE: the re-rank splits through the deepest of the interacted and the visible paper', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /import \{ splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
  const rerank = bounded(code, 'const reRankFeed = useCallback(', '}, [calculateAndAttachScore]);', 'reRankFeed', 30);
  assert.match(rerank, /splitFeedForReRank\(prevPapers, \{\s*anchorPaperIds: \[sourcePaperId, visiblePaperIdRef\.current\],?\s*\}\)/,
    'both anchors go in, the split picks the deepest');
  assert.doesNotMatch(rerank, /splitIndex \+ 3|idx \+ 3/, 'the hand-rolled split at the top is gone');
  assert.match(rerank, /initialPapers: locked/, 'the shuffle diversifies against what stays locked');
  assert.match(rerank, /return \[\.\.\.locked, \.\.\.newQueue\];/);
});

test('SOURCE: the visible paper lives in a ref and is reported through the context value', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /const visiblePaperIdRef = useRef\(null\);/);
  const report = bounded(code, 'const reportVisiblePaper = useCallback(', '}, []);', 'reportVisiblePaper', 6);
  assert.match(report, /visiblePaperIdRef\.current = paperId \|\| null;/, 'a ref write, never a state update');
  const value = bounded(code, 'const value = useMemo(() => ({', '}), [', 'the context value', 16);
  assert.match(value, /reportVisiblePaper/, 'consumers can report the card they are on');
});
```

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/context/feedReRankAnchor.test.js`
Expected: 2 tests fallan; el primero en el `import` de `splitFeedForReRank`, el segundo en `visiblePaperIdRef`.

- [ ] **Step 3: Importar la función y añadir el ref y el informador**

En `src/context/FeedContext.jsx`, justo después del import de `../utils/recommendationEngine` (que cierra en la línea 23 del árbol actual):

```js
import { splitFeedForReRank } from '../utils/feedReRankSplit.js';
```

Justo antes de `const reRankFeed = useCallback(` (línea 524 en el árbol actual), añadir:

```js
  // The card the reader is on, as FeedContainer reports it (on the restore
  // after a reload and on every scroll). A ref, not state: it moves on every
  // scroll event and nothing needs to re-render for it — reRankFeed reads it
  // inside its functional setPapers.
  const visiblePaperIdRef = useRef(null);
  const reportVisiblePaper = useCallback((paperId) => {
    visiblePaperIdRef.current = paperId || null;
  }, []);
```

- [ ] **Step 4: Reescribir `reRankFeed`**

Sustituir el cuerpo completo de `reRankFeed` (`FeedContext.jsx:524-549`) por:

```js
  const reRankFeed = useCallback((sourcePaperId = null) => {
    setPapers(prevPapers => {
      if (!prevPapers || prevPapers.length <= 1) return prevPapers;
      // Lock the cards the reader is on or about to reach: the interacted
      // paper when there is one, and the visible one always — a reload puts
      // the reader deep in the list, and the profile load's anchorless
      // re-rank used to shuffle that card away (2026-09-04).
      const { locked, queue } = splitFeedForReRank(prevPapers, {
        anchorPaperIds: [sourcePaperId, visiblePaperIdRef.current],
      });
      if (queue.length === 0) return prevPapers;

      const newQueue = diversifiedWeightedShuffle(queue, {
        scorePaper: calculateAndAttachScore,
        weights: recommendationWeights.current,
        initialPapers: locked,
      });
      logRankingBatch('rerank queue', newQueue);

      return [...locked, ...newQueue];
    });
  }, [calculateAndAttachScore]);
```

- [ ] **Step 5: Exponer `reportVisiblePaper` en el valor del contexto**

En el `useMemo` de `value` (`FeedContext.jsx:2230`), añadir `reportVisiblePaper` al objeto y a la lista de dependencias. El objeto queda:

```js
  const value = useMemo(() => ({
    papers, loading, error, hasMore, isRefreshing,
    likedPaperIds, notInterestedIds, savedPaperIds, readPaperIds, personalLibrary,
    libraryPapers,
    ensurePersonalLibrary, getCuratedInteractionIds,
    interactionIdFor, libraryCopyFor,
    feedMode, setFeedMode: handleSetFeedMode,
    loadPapers, loadMore, refreshFeed,
    getRecommendationProfileSnapshot,
    reportVisiblePaper,
    toggleLike, markNotInterested, markSaved, markAsRead, unmarkAsRead,
    toggleReadLater, saveReadingMetadata,
    trackViewTime, trackPdfOpened, trackSkip, trackSkips, trackPdfBounce
  }), [
```

y en la lista de dependencias, añadir `reportVisiblePaper,` en la línea siguiente a `getRecommendationProfileSnapshot,`. Es estable (`useCallback` sin dependencias), así que no altera la identidad del valor.

- [ ] **Step 6: Comprobar que pasan, y que nada más se rompe**

Run: `node --test src/context/feedReRankAnchor.test.js && node --test src/context/feedFirstPaint.test.js src/context/interactionWrites.test.js src/context/contextIdentity.test.js`
Expected: todos `ok`. Si `bounded(..., 'the context value', 16)` falla por longitud, contar las líneas del objeto `value`: en el árbol actual son 12; con la nueva línea, 13.

Run: `npm run lint`
Expected: sin errores (en particular, sin `react-hooks/exhaustive-deps` en el `useMemo` de `value`).

- [ ] **Step 7: Commit**

```bash
git status --short
git diff src/context/FeedContext.jsx
git add src/context/FeedContext.jsx src/context/feedReRankAnchor.test.js
git commit -m "fix(feed): el re-ranking bloquea hasta la tarjeta que el lector tiene delante, no hasta la tercera

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: El contenedor informa del paper visible al restaurar y al hacer scroll

**Files:**
- Modify: `src/components/Feed/FeedContainer.jsx:240-260` (efecto de restauración) y `:387-410` (`handleScroll`).
- Modify: `src/components/Feed/feedResume.test.js` (dos marcadores de fin y un test nuevo).

**Interfaces:**
- Consumes: `feed.reportVisiblePaper(paperId)` del valor de `useFeed()` (Task 2).

- [ ] **Step 1: Actualizar los marcadores y añadir el test, que falla**

En `src/components/Feed/feedResume.test.js`, el primer test captura `handleScroll` hasta `'}, [schedulePendingSkipFlush, scrollKey]);'` y el segundo captura la restauración hasta `'}, [papers, scrollKey]);'`. Ambas listas de dependencias cambian en esta tarea. Sustituir:

```js
  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 30);
```

por

```js
  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [reportVisiblePaper, schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 32);
```

y

```js
  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, scrollKey]);', 'the restore effect', 30);
```

por

```js
  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, reportVisiblePaper, scrollKey]);', 'the restore effect', 32);
```

Y añadir al final del fichero:

```js
/**
 * The feed's re-rank locks the cards through the one the reader is on, so
 * the container has to say which one that is: on the restore after a reload
 * (before any scroll event, which the programmatic scrollTop only fires
 * asynchronously) and on every scroll. Only the For You feed reports — the
 * Following and guest surfaces render lists the context does not own.
 */
test('SOURCE: the container reports the visible paper to the feed context, on restore and on scroll', async () => {
  const code = stripComments(await read('./FeedContainer.jsx'));
  assert.match(code, /const reportVisiblePaper = source \? null : feed\.reportVisiblePaper;/,
    'a surface with its own source never reports into For You');

  const restore = bounded(code, 'const restoreAttemptedRef = useRef(false);', '}, [papers, reportVisiblePaper, scrollKey]);', 'the restore effect', 32);
  assert.match(restore, /const index = resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\);\s*reportVisiblePaper\?\.\(papers\[index\]\?\.id \?\? null\);/,
    'the resumed card is reported as soon as it is known, whether or not there is somewhere to scroll to');

  const handler = bounded(code, 'const handleScroll = useCallback(', '}, [reportVisiblePaper, schedulePendingSkipFlush, scrollKey]);', 'the scroll handler', 32);
  assert.match(handler, /const paperId = papersRef\.current\[index\]\?\.id \|\| resumeMemory\.get\(scrollKey\)\.paperId;/);
  assert.match(handler, /resumeMemory\.remember\(scrollKey, \{\s*scrollTop: container\.scrollTop,\s*index,\s*paperId,\s*\}\);\s*reportVisiblePaper\?\.\(paperId\);/,
    'the same id goes to the resume memory and to the context');
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/components/Feed/feedResume.test.js`
Expected: los dos tests existentes fallan en `bounded` (no encuentran el nuevo marcador) y el nuevo falla en `reportVisiblePaper`.

- [ ] **Step 3: Tomar el informador del contexto**

En `src/components/Feed/FeedContainer.jsx`, justo después de `const isRefreshing = source ? Boolean(source.isRefreshing) : feed.isRefreshing;` (línea 118), añadir:

```js
  // Only the For You feed owns the context's list; Following and the guest
  // feed render a `source` of their own and must not anchor For You's
  // re-rank on a card it does not have.
  const reportVisiblePaper = source ? null : feed.reportVisiblePaper;
```

- [ ] **Step 4: Informar en la restauración**

Sustituir el efecto de restauración (`FeedContainer.jsx:240-260`; empieza en `const restoreAttemptedRef = useRef(false);`) por:

```js
  const restoreAttemptedRef = useRef(false);
  useLayoutEffect(() => {
    if (restoreAttemptedRef.current || papers.length === 0) return;
    restoreAttemptedRef.current = true;
    const saved = resumeMemory.get(scrollKey);
    // The paper the reader was on, wherever it is in this order; each snap
    // item is one container height tall, so the card's index is its offset.
    // Reported to the context here, not left to the scroll event the
    // programmatic scrollTop fires later: the profile load's re-rank must
    // find the anchor already set.
    const index = resumeIndex({ papers, savedPaperId: saved.paperId, savedIndex: saved.index });
    reportVisiblePaper?.(papers[index]?.id ?? null);
    // A place restored from storage after a reload has an index and no pixel
    // offset; either says there is somewhere to go back to.
    if (feedRef.current && (saved.scrollTop > 0 || saved.index > 0)) {
      const el = feedRef.current;
      const prevBehavior = el.style.scrollBehavior;
      el.style.scrollBehavior = 'auto'; // Force instant jump
      // The raw offset only stands in when the height is unknown.
      el.scrollTop = el.clientHeight > 0 ? index * el.clientHeight : saved.scrollTop;

      requestAnimationFrame(() => {
        el.style.scrollBehavior = prevBehavior;
      });
    }
  }, [papers, reportVisiblePaper, scrollKey]);
```

El comentario que hoy precede al efecto («Restore scroll position instantly before browser paints. Must run only once per mount...») se conserva tal cual encima.

- [ ] **Step 5: Informar en el scroll**

En `handleScroll` (`FeedContainer.jsx:387-410`), sustituir:

```js
    resumeMemory.remember(scrollKey, {
      scrollTop: container.scrollTop,
      index,
      paperId: papersRef.current[index]?.id || resumeMemory.get(scrollKey).paperId,
    });
```

por

```js
    const paperId = papersRef.current[index]?.id || resumeMemory.get(scrollKey).paperId;
    resumeMemory.remember(scrollKey, {
      scrollTop: container.scrollTop,
      index,
      paperId,
    });
    reportVisiblePaper?.(paperId);
```

y la lista de dependencias del `useCallback`, de `[schedulePendingSkipFlush, scrollKey]` a `[reportVisiblePaper, schedulePendingSkipFlush, scrollKey]`.

- [ ] **Step 6: Comprobar que pasan, y el resto de tests del contenedor**

Run: `node --test src/components/Feed/feedResume.test.js src/components/Feed/feedAtomVeil.test.js src/components/Feed/paperCardArrival.test.js src/utils/feedMountWindow.test.js`
Expected: todos `ok`.

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git status --short
git diff src/components/Feed/FeedContainer.jsx
git add src/components/Feed/FeedContainer.jsx src/components/Feed/feedResume.test.js
git commit -m "fix(feed): el contenedor dice al contexto en qué tarjeta está el lector, al volver de una recarga y al hacer scroll

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Verificación en vivo y comprobación completa

**Files:** ninguno nuevo. Esta tarea produce evidencia, no código.

- [ ] **Step 1: Suite completa y comprobación de entrega**

Run: `npm run check`
Expected: secretos limpios, lint sin errores, todos los tests `ok`, build correcto y `wrangler deploy --dry-run` sin fallos. Si `npm test` deja algún caso en `cancelled`, es la trampa de Node 22 (ver memoria `papertok-node22-test-gotchas`): añadir el watchdog al test nuevo, no ignorarlo.

- [ ] **Step 2: Reproducir el síntoma en el árbol arreglado**

1. Abrir el servidor de desarrollo con el Browser pane: `preview_start` con `name: "papertok-main-5173"`.
2. El usuario inicia sesión él mismo en el pane (nunca pedirle credenciales; memoria `papertok-auth-verification-boundary`). Si no está disponible, usar el modo demo local (`IS_DEMO = true` en `src/services/firebase.js:6`, un cambio que **nunca se commitea**: revertirlo antes de `git add`).
3. Con `computer` hacer scroll hasta la sexta tarjeta o más allá (índice ≥ 5) y esperar a que el scroll se asiente (más de 120 ms, que es `SCROLL_IDLE_DELAY_MS`).
4. Con `read_page`, anotar el título del paper visible.
5. Recargar con `navigate` a la misma URL.
6. Esperar 6 s (`computer` con `action: "wait"`, `duration: 6`): cubre el timeout de 2500 ms del idle del perfil semántico más las llamadas a OpenAlex.
7. Con `read_page`, comprobar que el título visible es el mismo del paso 4.
8. Con `read_console_messages` y `pattern: "rerank queue"`, comprobar que el re-ranking sí se ejecutó. El registro solo se emite si antes de recargar se activa desde `javascript_tool`: `localStorage.setItem('DEBUG_RANKING', 'true')` (`shouldLogRanking`, `src/utils/recommendationEngine.js:616`). El rebarajado ocurre y la tarjeta no cambia: eso es el arreglo.
9. Captura de pantalla (`computer`, `action: "screenshot"`) como evidencia.

- [ ] **Step 3: Comprobar que la interacción sigue anclando bien**

En la misma sesión, en la tarjeta visible pulsar «Like» y esperar 2 s. El paper visible no cambia y la consola muestra otro `rerank queue`. Después pulsar «Skip»: el feed avanza a la siguiente tarjeta, que es la que ya estaba debajo (bloqueada), no una recién barajada.

- [ ] **Step 4: Entrega**

`git log --oneline -4` muestra los tres commits de este plan sobre `main`. Antes de `git push`: **pedir confirmación al usuario**, porque Vercel despliega el frontend en cuanto llega el push y no espera a los tests. Si confirma:

```bash
git pull --rebase && git push
```

Después, comprobar en https://papertok.app el mismo guion del Step 2 con el usuario logueado en Safari (él lo hace; tú solo miras la captura si te la pasa).

---

## Autorevisión

- **Cobertura del diagnóstico:** la llamada sin referencia de la línea 906 queda anclada por Task 2 (lee el ref) sin tocar esa línea; la de la línea 1615 también. El anclaje existe antes de que el perfil termine porque Task 3 informa en el efecto de restauración, que corre con la primera lista de papers.
- **Sin marcadores vacíos:** cada paso lleva el código o el comando.
- **Consistencia de nombres:** `splitFeedForReRank`, `RERANK_LOOKAHEAD`, `anchorPaperIds`, `visiblePaperIdRef`, `reportVisiblePaper` se usan con el mismo nombre en Task 1, 2 y 3 y en los tests. Los marcadores de fin de `bounded` en `feedResume.test.js` coinciden letra por letra con las listas de dependencias que Task 3 escribe.
