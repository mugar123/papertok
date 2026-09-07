# El feed conserva el paper tras seguir o dejar de seguir — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que entrar en el proyecto (o autor, institución, tema) de un paper desde el feed, seguirlo, dejar de seguirlo y volver, devuelva al lector al mismo paper, sin que el feed se recargue solo ni el paper desaparezca.

**Architecture:** El efecto de seguimiento de `FeedContext` (`src/context/FeedContext.jsx:1632-1654`) reacciona a cualquier cambio en `followedEntities` con un `reRankFeed()` y un `loadPapers(true, null, true)` que **sustituye la lista entera** por una página aleatoria de la que el filtro de vistos excluye el paper actual. Además corre fuera de la ruta del feed y compara contra la última firma vista, no contra la última aplicada, así que un follow más un unfollow disparan dos recargas. El arreglo tiene tres piezas, cada una en su tarea: (1) un helper puro `mergeFreshFeedPage` que conserva las tarjetas hasta la visible y coloca la página fresca debajo; (2) `loadPapers` acepta `{ keepThroughVisible: true }` y usa ese helper en la rama `reset`; (3) el efecto de seguimiento se gatea con `feedRouteActive` como ya hace el de preferencias, compara la firma contra la última aplicada al feed, y pide la recarga con `keepThroughVisible`. El resultado: el cambio se aplica al volver al feed, una sola vez, anclado en la tarjeta en la que está el lector, y los candidatos del nuevo seguido entran justo debajo.

**Tech Stack:** React 18 (contexto con `useEffect`/`useRef`), `node --test` con tests SOURCE (leen el fuente, despojan comentarios y acotan la captura) para lo que no se puede montar bajo Node, tests funcionales para los helpers puros de `src/utils/`.

**Spec:** La auditoría de esta misma sesión (07-09-2026). Hechos que sustentan el plan:
- `toggleFollow` (`src/context/FollowingContext.jsx:247-260`) actualiza `followedEntities` de forma optimista; la firma del efecto es `tipo:canonicalId`, así que cada toggle la cambia.
- El efecto de seguimiento (`FeedContext.jsx:1632-1654`) no mira `feedRouteActive`; el de preferencias sí (`FeedContext.jsx:1605`), con un comentario que explica por qué. `App.jsx:206` pasa `feedRouteActive={normalizedPathname === '/'}`.
- Con `reset`, `loadPapers` hace `nextPapers = filtered` (`FeedContext.jsx:1453-1455`); `filtered` excluye `sessionSeenPapers` (`:1353`) y cada paper pintado se añade ahí (`:1447`); `randomizeStart` elige página 0-4 (`:993-995`).
- Al volver, `FeedContainer` (`:244-268`) busca el id guardado con `resumeIndex` (`src/utils/feedMountWindow.js:73-81`); no está, cae al índice numérico y aterriza en otro paper.
- `reRankFeed` ya ancla en `visiblePaperIdRef` con `splitFeedForReRank` (`src/utils/feedReRankSplit.js`); la ref no se borra al desmontar el feed, así que sigue nombrando la última tarjeta del lector mientras está en la página de la entidad.
- No hay ningún test que cubra el comportamiento del feed tras un cambio de seguimiento; `feedFirstPaint.test.js:192-206` sólo fija el precalentamiento de temas con una captura acotada a 12 líneas entre `const followingSignatureRef = useRef(null);` y `const signature = followedEntities`. Esa captura debe seguir cabiendo.

## Global Constraints

- El efecto existe desde el 16-07 (afa1af6) y la sustitución completa es de entonces; no es una regresión reciente, sino un agujero que el arreglo del resume (03-09) dejó a la vista. No revertir nada.
- `FeedContext` no se puede montar bajo Node: sus contratos se fijan con tests SOURCE al estilo de `src/context/feedReRankAnchor.test.js` (`stripComments` + `bounded` con máximo de líneas). Un test SOURCE debe fallar si se quita la línea que fija; comprobarlo por mutación antes de darlo por bueno (convención de ce139ce).
- El escáner de Tailwind lee comentarios: no citar clases CSS en comentarios nuevos (no aplica aquí, no hay CSS).
- Los helpers puros viven en `src/utils/` con test funcional al lado. `mergeFreshFeedPage` va en `src/utils/feedReRankSplit.js` porque cambia junto a `splitFeedForReRank` y comparte `RERANK_LOOKAHEAD`.
- No cambiar el comportamiento del efecto de preferencias ni del `reRankFeed` por interacción (like, guardar): sólo el efecto de seguimiento y la rama `reset` de `loadPapers` cuando se le pide `keepThroughVisible`.
- `loadPapers` lee `papers` de su clausura (ya lo hace la rama de anexado). Es aceptable aquí: el prefijo bloqueado que devuelve `splitFeedForReRank` es el mismo antes y después del `reRankFeed` que lo precede, y mientras `loading` es `true` el centinela de scroll infinito no anexa. No introducir un `papersRef` en esta tarea.
- Comandos: `npm test` corre `node --test` sobre todos los `*.test.js`; para un test concreto, `node --test src/utils/feedReRankSplit.test.js`. Antes de publicar, `npm run check`.
- Commits en español, tono del repo (`fix(feed): …`, `test(feed): …`), con el pie `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Trabajar en una rama; fusionar a `main` despliega el frontend en Vercel sin esperar a los tests, así que `npm run check` va antes del merge, no después.
- Otra sesión de Claude puede estar editando el mismo árbol: revisar el diff fichero a fichero antes de cada commit y rebasar sobre `origin/main` antes de fusionar.

---

### Task 1: `mergeFreshFeedPage` conserva las tarjetas hasta la visible y pone la página fresca debajo

**Files:**
- Modify: `src/utils/feedReRankSplit.js`
- Test: `src/utils/feedReRankSplit.test.js`

**Interfaces:**
- Consumes: `splitFeedForReRank(papers, { anchorPaperIds, lookahead })` y `RERANK_LOOKAHEAD` del mismo fichero.
- Produces: `mergeFreshFeedPage(previous, fresh, { anchorPaperIds = [], lookahead = RERANK_LOOKAHEAD } = {}) → Paper[]`. Devuelve `[...locked, ...fresh sin los ids de locked]`, donde `locked` es lo que `splitFeedForReRank(previous, …)` bloquea (hasta el ancla más profunda más `lookahead`). Con `previous` vacío devuelve `fresh` tal cual. Nunca muta sus argumentos.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir al final de `src/utils/feedReRankSplit.test.js` (el fichero ya importa `test`, `assert`, `RERANK_LOOKAHEAD` y `splitFeedForReRank`, y define `papers(n)` e `ids(list)`):

```js
import { mergeFreshFeedPage } from './feedReRankSplit.js';

const fresh = (n) => Array.from({ length: n }, (_, i) => ({ id: `q${i}` }));

test('mergeFreshFeedPage: with nothing on screen the fresh page stands alone', () => {
  const page = fresh(4);
  assert.deepEqual(ids(mergeFreshFeedPage([], page, { anchorPaperIds: ['p5'] })), ['q0', 'q1', 'q2', 'q3']);
  assert.deepEqual(ids(mergeFreshFeedPage(null, page)), ['q0', 'q1', 'q2', 'q3']);
});

test('mergeFreshFeedPage: a reader on p5 keeps 0..7 and the fresh page follows; the old queue goes', () => {
  const previous = papers(10);
  const page = fresh(3);
  const merged = mergeFreshFeedPage(previous, page, { anchorPaperIds: ['p5'] });
  assert.deepEqual(ids(merged), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'q0', 'q1', 'q2']);
  assert.ok(merged.includes(previous[5]), 'the card under the viewport survives, same object');
  assert.equal(previous.length, 10, 'the previous list is not mutated');
  assert.equal(page.length, 3, 'the fresh page is not mutated');
});

test('mergeFreshFeedPage: without an anchor the top three stay, as the re-rank does', () => {
  const merged = mergeFreshFeedPage(papers(10), fresh(2));
  assert.equal(RERANK_LOOKAHEAD, 3);
  assert.deepEqual(ids(merged), ['p0', 'p1', 'p2', 'q0', 'q1']);
});

test('mergeFreshFeedPage: an anchor that is not in the list behaves like no anchor', () => {
  const merged = mergeFreshFeedPage(papers(10), fresh(2), { anchorPaperIds: [null, 'nope'] });
  assert.deepEqual(ids(merged), ['p0', 'p1', 'p2', 'q0', 'q1']);
});

test('mergeFreshFeedPage: a fresh paper already locked is not shown twice', () => {
  const previous = papers(6);
  const page = [{ id: 'q0' }, { id: 'p1' }, { id: 'q1' }];
  const merged = mergeFreshFeedPage(previous, page, { anchorPaperIds: ['p2'] });
  assert.deepEqual(ids(merged), ['p0', 'p1', 'p2', 'p3', 'p4', 'q0', 'q1']);
  assert.equal(merged[1], previous[1], 'the locked copy wins, not the fresh one');
});
```

Nota: mover el `import { mergeFreshFeedPage }` a la cabecera junto al import existente (los imports de ES van arriba); queda `import { RERANK_LOOKAHEAD, mergeFreshFeedPage, splitFeedForReRank } from './feedReRankSplit.js';`.

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/utils/feedReRankSplit.test.js`
Expected: los cinco tests nuevos fallan con `SyntaxError: The requested module './feedReRankSplit.js' does not provide an export named 'mergeFreshFeedPage'` (o el fichero entero falla al cargar por ese motivo; los tests anteriores no llegan a correr). Ambas cosas cuentan como fallo.

- [ ] **Step 3: Implementar el helper**

Añadir al final de `src/utils/feedReRankSplit.js`:

```js
/**
 * A refresh that keeps the reader's place.
 *
 * A follow change used to replace the whole list with a fresh page, and the
 * fresh page never contains the card the reader is on: every painted paper is
 * in the session's seen set. Coming back from the entity page landed on a
 * different paper at the same index (reported 2026-09-07). The refresh now
 * keeps what the re-rank would lock — through the visible card plus the
 * lookahead — and puts the fresh page right below it; the old queue goes.
 */
export function mergeFreshFeedPage(previous, fresh, { anchorPaperIds = [], lookahead = RERANK_LOOKAHEAD } = {}) {
  const incoming = Array.isArray(fresh) ? fresh : [];
  const { locked } = splitFeedForReRank(previous, { anchorPaperIds, lookahead });
  if (locked.length === 0) return incoming;
  const lockedIds = new Set(locked.map(paper => paper?.id));
  return [...locked, ...incoming.filter(paper => !lockedIds.has(paper?.id))];
}
```

- [ ] **Step 4: Comprobar que pasan**

Run: `node --test src/utils/feedReRankSplit.test.js`
Expected: todos los tests del fichero en PASS (los anteriores más los cinco nuevos).

- [ ] **Step 5: Commit**

```bash
git add src/utils/feedReRankSplit.js src/utils/feedReRankSplit.test.js
git commit -m "feat(feed): mergeFreshFeedPage conserva las tarjetas hasta la visible y pone la página fresca debajo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `loadPapers` acepta `keepThroughVisible` y no sustituye la lista entera

**Files:**
- Modify: `src/context/FeedContext.jsx:24` (import), `:973` (firma), `:1453-1456` (rama `reset`), `:1541-1547` (reintento automático)
- Modify: `src/context/feedReRankAnchor.test.js:29` (su regex del import exige `{ splitFeedForReRank }` a secas; hay que admitir el segundo nombre)
- Test: `src/context/feedFollowChange.test.js` (nuevo)

**Interfaces:**
- Consumes: `mergeFreshFeedPage(previous, fresh, { anchorPaperIds })` de la Task 1; `visiblePaperIdRef` (ya existe en `FeedContext.jsx:528`).
- Produces: `loadPapers(reset = false, mode, randomizeStart = false, pageOverride, { keepThroughVisible = false } = {})`. Con `reset && keepThroughVisible`, la lista resultante es `mergeFreshFeedPage(papers, filtered, { anchorPaperIds: [visiblePaperIdRef.current] })`; sin la opción, el comportamiento es el de hoy (`filtered`). El reintento automático tras un fallo con `reset` conserva la opción.

- [ ] **Step 1: Escribir el test SOURCE que falla**

Crear `src/context/feedFollowChange.test.js`:

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
 * node. They pin what a follow change may do to the list on screen.
 *
 * Entering a paper's project from the feed, following it, unfollowing it and
 * coming back used to land on a different paper at the same index
 * (2026-09-07): the following effect replaced the whole list with a fresh
 * page — which never holds the card the reader is on, every painted paper
 * being in the seen set — and did so off the feed route, twice.
 */
test('SOURCE: a reset asked to keep the visible card merges the fresh page below it', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  assert.match(code, /import \{ mergeFreshFeedPage, splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
  assert.match(
    code,
    /const loadPapers = useCallback\(async \(reset = false, mode, randomizeStart = false, pageOverride, \{ keepThroughVisible = false \} = \{\}\) => \{/,
    'the option is an explicit parameter, not a ref the effect has to set',
  );
  const resetBranch = bounded(code, 'let nextPapers;', 'const nextHasMore =', 'the reset branch of loadPapers', 20);
  assert.match(
    resetBranch,
    /if \(reset\) \{\s*nextPapers = keepThroughVisible\s*\?\s*mergeFreshFeedPage\(papers, filtered, \{\s*anchorPaperIds: \[visiblePaperIdRef\.current\],?\s*\}\)\s*:\s*filtered;/,
    'through the visible card the list stays; the fresh page follows',
  );
});

test('SOURCE: the automatic retry after a failed reset keeps the option', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const retry = bounded(code, 'if (reset && !autoRetryUsedRef.current) {', '}, 2500);', 'the automatic retry', 8);
  assert.match(retry, /loadPapersRef\.current\?\.\(true, activeMode, false, undefined, \{ keepThroughVisible \}\);/);
});
```

- [ ] **Step 2: Comprobar que falla**

Run: `node --test src/context/feedFollowChange.test.js`
Expected: los dos tests en FAIL. El primero por el `import` (aún sólo importa `splitFeedForReRank`); el segundo porque el reintento llama a `loadPapersRef.current?.(true, activeMode)`.

- [ ] **Step 3: Implementar**

En `src/context/FeedContext.jsx`:

1. Línea 24, el import:

```js
import { mergeFreshFeedPage, splitFeedForReRank } from '../utils/feedReRankSplit.js';
```

2. Línea 973, la firma:

```js
  const loadPapers = useCallback(async (reset = false, mode, randomizeStart = false, pageOverride, { keepThroughVisible = false } = {}) => {
```

3. Líneas 1453-1456, la rama `reset` (dejar el `else` como está):

```js
      if (reset) {
        // A follow change refreshes the ranking but the reader keeps their
        // place: the cards through the visible one stay, the fresh page lands
        // below them (mergeFreshFeedPage). A plain reset still replaces all.
        nextPapers = keepThroughVisible
          ? mergeFreshFeedPage(papers, filtered, { anchorPaperIds: [visiblePaperIdRef.current] })
          : filtered;
        nextPage = currentPage + 1;
      } else {
```

4. Líneas 1541-1547, el reintento automático:

```js
        if (reset && !autoRetryUsedRef.current) {
          autoRetryUsedRef.current = true;
          setTimeout(() => {
            if (requestId === feedRequestId.current && feedSessionId.current === activeSessionId) {
              loadPapersRef.current?.(true, activeMode, false, undefined, { keepThroughVisible });
            }
          }, 2500);
        }
```

No tocar la llamada de `:1378` (`loadPapersRef.current(false, activeMode, false, nextPageToFetch)`): es un anexado, conserva el sitio por construcción.

5. En `src/context/feedReRankAnchor.test.js:29`, el regex del import exige hoy `{ splitFeedForReRank }` a secas y rompería con el segundo nombre. Sustituir esa línea por:

```js
  assert.match(code, /import \{ (?:mergeFreshFeedPage, )?splitFeedForReRank \} from '\.\.\/utils\/feedReRankSplit\.js';/);
```

- [ ] **Step 4: Comprobar que pasa, y que la suite del contexto sigue verde**

Run: `node --test src/context/feedFollowChange.test.js src/context/feedReRankAnchor.test.js src/context/feedFirstPaint.test.js`
Expected: todo en PASS. Si `feedReRankAnchor` falla en su primera aserción, es que el punto 5 del paso anterior no se aplicó o el orden de los nombres en el import no es alfabético (`mergeFreshFeedPage, splitFeedForReRank`).

- [ ] **Step 5: Comprobar por mutación**

Volver a poner `nextPapers = filtered;` en la rama `reset` y correr `node --test src/context/feedFollowChange.test.js`. Expected: el primer test FALLA. Restaurar el cambio y volver a correr: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/context/FeedContext.jsx src/context/feedFollowChange.test.js src/context/feedReRankAnchor.test.js
git commit -m "fix(feed): un reset con keepThroughVisible conserva las tarjetas hasta la visible

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: El efecto de seguimiento espera al feed, aplica una sola vez y conserva el sitio

**Files:**
- Modify: `src/context/FeedContext.jsx:1630-1654`
- Test: `src/context/feedFollowChange.test.js` (ampliar)

**Interfaces:**
- Consumes: `loadPapers(true, null, true, undefined, { keepThroughVisible: true })` de la Task 2; `feedRouteActive` (prop del provider, `FeedContext.jsx:224`); `reRankFeed()`.
- Produces: el efecto no registra ni aplica nada mientras `feedRouteActive` es `false`; al volver a `true` compara la firma actual con `followingSignatureRef.current` (la última **aplicada** al feed) y, sólo si difiere, re-rankea y recarga con `keepThroughVisible`.

- [ ] **Step 1: Ampliar el test SOURCE**

Añadir al final de `src/context/feedFollowChange.test.js`:

```js
test('SOURCE: the following effect records nothing off the feed route and compares against the last applied signature', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const effect = bounded(
    code,
    'const followingSignatureRef = useRef(null);',
    '}, [feedRouteActive, followedEntities, followingLoading',
    'the following effect',
    40,
  );
  const signatureAt = effect.indexOf("const signature = followedEntities");
  const gateAt = effect.indexOf('if (!feedRouteActive) return;');
  const compareAt = effect.indexOf('if (followingSignatureRef.current === signature) return;');
  const recordAt = effect.indexOf('followingSignatureRef.current = signature;');
  assert.ok(signatureAt >= 0 && gateAt >= 0 && compareAt >= 0 && recordAt >= 0, 'the four steps are there');
  assert.ok(gateAt > signatureAt, 'the signature is computed first (the topic warm-up above it stays unconditional)');
  assert.ok(gateAt < compareAt && gateAt < recordAt, 'off the feed route nothing is compared nor recorded: a follow and its undo cost nothing');
  assert.match(
    effect,
    /setTimeout\(\s*\(\) => loadPapers\(true, null, true, undefined, \{ keepThroughVisible: true \}\),\s*0,?\s*\)/,
    'the refresh keeps the reader on their card',
  );
  assert.match(effect, /reRankFeed\(\);/, 'the visible cards are still re-ranked, anchored, before the fresh page arrives');
});

test('SOURCE: the topic warm-up still runs before the gate, so the prewarm test keeps its 12-line window', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const head = bounded(code, 'const followingSignatureRef = useRef(null);', 'const signature = followedEntities', 'the head of the effect', 12);
  assert.match(head, /void loadTopicRetrieval\(\);/);
  assert.doesNotMatch(head, /feedRouteActive/, 'the gate comes after the signature, not before the warm-up');
});
```

- [ ] **Step 2: Comprobar que fallan**

Run: `node --test src/context/feedFollowChange.test.js`
Expected: el tercer test FALLA en `bounded` (no encuentra `}, [feedRouteActive, followedEntities, followingLoading`). El cuarto PASA ya (fija que no se rompa lo que hoy existe); está bien que pase antes.

- [ ] **Step 3: Implementar el efecto**

Sustituir `src/context/FeedContext.jsx:1630-1654` (desde `const followingSignatureRef = useRef(null);` hasta el cierre `}, [followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady]);`) por:

```js
  const followingSignatureRef = useRef(null);

  useEffect(() => {
    // Warm the topic table as soon as a topic follow is known, off the feed's
    // critical path, so loadPapers meets a resident module.
    if (followedEntities.some(entity => entity?.type === 'topic')) void loadTopicRetrieval();
    if (followingLoading) return;
    const signature = followedEntities
      .map(entity => `${entity.type}:${entity.canonicalId}`)
      .sort()
      .join('|');
    // Off the feed route nothing is compared nor recorded: a follow toggled
    // from an entity page is picked up on the next visit to the feed, against
    // the last signature the feed applied — so following and unfollowing on
    // the way costs nothing, and no source cascade fires for a feed nobody is
    // looking at (reported 2026-09-07, same rule as the preferences effect).
    if (!feedRouteActive) return;
    if (followingSignatureRef.current === signature) return;
    if (followingSignatureRef.current === null) {
      followingSignatureRef.current = signature;
      return;
    }
    followingSignatureRef.current = signature;
    reRankFeed();
    if (recommendationProfileReady) {
      feedCache.current = {};
      // The cards through the one the reader is on stay; the fresh ranking
      // lands below them (mergeFreshFeedPage).
      const refreshTimer = setTimeout(
        () => loadPapers(true, null, true, undefined, { keepThroughVisible: true }),
        0,
      );
      return () => clearTimeout(refreshTimer);
    }
  }, [feedRouteActive, followedEntities, followingLoading, isKnownPaper, loadPapers, reRankFeed, recommendationProfileReady]);
```

`isKnownPaper` sigue en las dependencias como hasta ahora: quitarlo es otro cambio y no es de esta tarea.

- [ ] **Step 4: Comprobar que pasan, y la suite entera del contexto**

Run: `node --test src/context/*.test.js`
Expected: todo en PASS, en particular `feedFirstPaint.test.js` («the topic table is prewarmed…», ventana de 12 líneas: la cabecera del efecto no ha crecido) y `feedReRankAnchor.test.js`.

- [ ] **Step 5: Comprobar por mutación**

Dos mutaciones, una cada vez, corriendo `node --test src/context/feedFollowChange.test.js` tras cada una y restaurando después:
1. Mover `if (!feedRouteActive) return;` debajo de `followingSignatureRef.current = signature;`. Expected: el tercer test FALLA (`gateAt < recordAt`).
2. Quitar `, undefined, { keepThroughVisible: true }` de la llamada. Expected: el tercer test FALLA (regex del `setTimeout`).

- [ ] **Step 6: Lint y suite completa**

Run: `npm run check`
Expected: lint sin errores (el `exhaustive-deps` está satisfecho: `feedRouteActive` entra en las dependencias) y `npm test` en verde.

- [ ] **Step 7: Commit**

```bash
git add src/context/FeedContext.jsx src/context/feedFollowChange.test.js
git commit -m "fix(feed): un cambio de seguimiento se aplica al volver al feed, una vez, sin mover al lector de su paper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Verificación en vivo y nota de estado

**Files:**
- Modify: `STATE.md` (sección nueva arriba del todo; el fichero va de más nuevo a más viejo)

**Interfaces:**
- Consumes: la app completa con los tres commits anteriores; la sesión la inicia el usuario en el navegador (nunca pedirle credenciales; ver `docs/DEVELOPMENT.md` y la frontera de verificación con sesión).

- [ ] **Step 1: Levantar el dev server y pedir sesión**

Abrir el preview con la configuración `papertok-main-5173` de `.claude/launch.json`. Si no hay sesión iniciada en el pane, pedir al usuario que inicie sesión él en ese pane y esperar. Sin sesión, `recommendationProfileReady` es `false` y el efecto no recarga: la prueba no vale.

- [ ] **Step 2: Reproducir el recorrido del bug**

1. En `/`, bajar hasta la cuarta o quinta tarjeta y anotar el título y el id del paper (leer `data-*` o el título con `read_page`).
2. Abrir el proyecto del paper (la píldora de proyecto de la tarjeta lleva a `/explorer/project/:id`).
3. Mientras se está en la página del proyecto, listar las peticiones de red con `read_network_requests` filtrando por `arxiv`, `pubmed`, `openalex`, `semanticscholar`: anotar la cuenta.
4. Pulsar «Seguir» y luego «Siguiendo» para dejar de seguir. Volver a listar las peticiones con los mismos filtros.
5. Volver atrás con el historial del navegador (`navigate` con `back`).
6. Leer la tarjeta bajo el viewport.

Expected:
- Paso 4: la cuenta de peticiones a fuentes del feed no crece tras los dos toggles (el efecto no corre fuera de la ruta del feed).
- Paso 6: la tarjeta es el mismo paper del paso 1, y no ha habido reemplazo de lista (las tarjetas anteriores siguen; sin `SkeletonCard` al final porque no hay recarga: la firma vuelve a ser la aplicada).

- [ ] **Step 3: Reproducir el caso con cambio neto**

Repetir el recorrido pero dejando el proyecto seguido (un solo toggle) y volver.

Expected: la tarjeta bajo el viewport sigue siendo el mismo paper; las tres siguientes también (el `lookahead`); a partir de ahí las tarjetas cambian cuando llega la página fresca, y aparece un `SkeletonCard` al final mientras carga. Deshacer el follow al terminar desde `/settings` o desde la propia página del proyecto, para dejar la cuenta del usuario como estaba.

- [ ] **Step 4: Anotar el resultado en `STATE.md`**

Añadir esta sección al principio de `STATE.md`, justo debajo de `# Estado / pendientes`, rellenando los dos huecos entre corchetes con lo medido:

```markdown
## Seguir o dejar de seguir desde la página de una entidad ya no mueve al lector de su paper (2026-09-07)

**«En papers en proyectos, al meterme en el proyecto, seguir el proyecto,
dejar de seguirlo y volver al paper original, se recarga el feed de forma
espontánea y el paper en el que estaba desaparece.»** No era de proyectos:
cualquier cambio en `followedEntities` disparaba en `FeedContext` un
`reRankFeed()` y un `loadPapers(true, null, true)` que sustituía la lista
entera por una página aleatoria de la que el filtro de vistos excluye el
paper actual (cada tarjeta pintada entra en `sessionSeenPapers`), y lo hacía
fuera de la ruta del feed y dos veces (follow y unfollow cambian la firma
`tipo:id` y se comparaba contra la última vista, no contra la última
aplicada). Al volver, `resumeIndex` no encontraba el id y caía al índice:
otro paper en el mismo sitio. Existía desde el 16-07 (afa1af6); el arreglo
del resume del 03-09 lo dejó a la vista. Ahora el efecto de seguimiento se
gatea con `feedRouteActive` como el de preferencias, compara contra la
última firma aplicada (follow y unfollow seguidos no cuestan nada) y pide
la recarga con `keepThroughVisible`: `loadPapers` conserva las tarjetas
hasta la visible más tres (`mergeFreshFeedPage`, `utils/feedReRankSplit.js`)
y coloca la página fresca debajo. Verificado en local con sesión: [cuenta de
peticiones a fuentes en la página del proyecto antes y después de los dos
toggles] y [paper bajo el viewport antes y después de volver, en los dos
recorridos]. Fijado con `context/feedFollowChange.test.js` (SOURCE) y
`utils/feedReRankSplit.test.js`.
```

- [ ] **Step 5: Commit, rebase y fusión**

```bash
git add STATE.md
git commit -m "docs(estado): un cambio de seguimiento ya no mueve al lector de su paper

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Después: `git fetch origin && git rebase origin/main`, `npm run check` de nuevo sobre el árbol rebasado, y fusionar a `main` (PR o merge, según prefiera el usuario). Fusionar despliega en Vercel; el Worker no cambia.

---

## Auto-revisión

**Cobertura del spec.** Las tres causas de la auditoría tienen tarea: sustitución total → Task 1 + Task 2; efecto sin gate de ruta → Task 3; doble disparo por comparar contra la última firma vista → Task 3 (no registrar fuera de ruta). La pérdida del id en `resumeIndex` no necesita cambio: con el paper conservado, lo encuentra. La verificación en vivo (Task 4) cubre los dos recorridos, con y sin cambio neto, y la ausencia de fan-out fuera del feed.

**Nombres.** `mergeFreshFeedPage(previous, fresh, { anchorPaperIds, lookahead })` en Task 1, usado con esa firma en Task 2 y fijado por el mismo regex; la opción se llama `keepThroughVisible` en la firma de `loadPapers` (Task 2), en el reintento (Task 2) y en la llamada del efecto (Task 3); la clausura en Task 3 empieza por `}, [feedRouteActive, followedEntities, followingLoading` y la lista completa de dependencias de la implementación coincide.

**Lo que este plan no hace, a propósito.** No introduce un `papersRef` (la clausura de `papers` es la que ya usa el anexado y el prefijo bloqueado es estable bajo el re-rank); no cambia `randomizeStart`; no deja de marcar como vistos los papers de la cola descartada (comportamiento previo de todo `reset`); no toca el efecto de preferencias ni el re-rank por interacción.
