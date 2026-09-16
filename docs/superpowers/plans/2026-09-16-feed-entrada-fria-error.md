# Feed en frío: el error que «Try again» cura — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una carga del feed cuyas fuentes contestan después del presupuesto de primer pintado pinte cuando contesten, en vez de declararse fallida a los 4 s.

**Architecture:** El presupuesto de 4 s de `settleSourcesForFirstPaint` sigue decidiendo cuándo se puede pintar *pronto*, pero deja de decidir cuándo se ha *fallado*: `all` se asienta bajo su propio techo. En `loadPapers` las fuentes principales se piden antes que los candidatos opcionales y la búsqueda de OpenAlex del feed salta la cola FIFO del cliente. El plazo del cliente para `/arxiv` pasa por encima del plazo del Worker.

**Tech Stack:** React 19 + Vite, `node --test` (tests de fuente con `stripComments` para FeedContext), sonda CDP en el scratchpad para la verificación en vivo.

**Spec:** `docs/AUDITORIA-FEED-ENTRADA-FRIA-2026-09-16.md`

## Global Constraints

- Tests con `node --test <fichero>`; CI corre Node 22 (los tests deben terminar por sí solos, sin colgar).
- Nunca commitear `IS_DEMO = true` en `src/services/firebase.js`.
- Los tests de fuente de `FeedContext.jsx` corren sobre código sin comentarios (`stripComments`) y acotan su captura con `bounded(...)`.
- Mensajes de commit en castellano, en el estilo del historial (`fix(feed): …`), terminando con la línea de atribución de Claude.

---

### Task 1: `all` sobrevive al presupuesto de primer pintado

**Files:**
- Modify: `src/utils/asyncTiming.js:35-64`
- Test: `src/utils/asyncTiming.test.js`

**Interfaces:**
- Produces: `settleSourcesForFirstPaint(promises, timeoutMs, isReady, { allTimeoutMs = DEFAULT_SOURCE_SETTLE_TIMEOUT_MS } = {})` → `{ first, all }`; `first` igual que hoy; `all` se asienta bajo `Math.max(timeoutMs, allTimeoutMs)`. Exporta `DEFAULT_SOURCE_SETTLE_TIMEOUT_MS = 12_000`.

- [ ] **Step 1: Write the failing tests** (añadir al final de `src/utils/asyncTiming.test.js`)

```js
test('a source that answers after the first-paint budget still reaches `all`', async () => {
  const late = new Promise((resolve) => setTimeout(() => resolve([{ id: 'late' }]), 60));
  const { first, all } = settleSourcesForFirstPaint([late], 20, () => false, { allTimeoutMs: 500 });
  const early = await first;
  assert.equal(early[0].status, 'timed_out');
  const settled = await all;
  assert.equal(settled[0].status, 'fulfilled');
  assert.deepEqual(fulfilledPaperLists(settled).map((paper) => paper.id), ['late']);
});

test('`all` still has a ceiling of its own', async () => {
  const never = new Promise(() => {});
  const { all } = settleSourcesForFirstPaint([never], 5, () => false, { allTimeoutMs: 30 });
  const settled = await all;
  assert.equal(settled[0].status, 'timed_out');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/utils/asyncTiming.test.js`
Expected: FAIL — el primero porque `settled[0].status` es `'timed_out'` (hoy `all` está acotado al mismo presupuesto).

- [ ] **Step 3: Implement**

Reemplazar la función en `src/utils/asyncTiming.js`:

```js
/**
 * How long `all` below may wait for the sources after the first-paint budget
 * has passed. Above the longest client deadline any main source carries (the
 * Worker routes are read under 6–10 s), so a source that is still going to
 * answer is waited for, and a source that never answers cannot hold the feed
 * on its veil for longer than this.
 */
export const DEFAULT_SOURCE_SETTLE_TIMEOUT_MS = 12_000;

/**
 * Same per-source budget as settleWithin for `first`, but the caller can paint
 * as soon as `isReady` is true instead of waiting for the slowest source.
 *
 * `all` used to be `Promise.all` of the SAME budgeted promises, which made the
 * first-paint budget double as a failure deadline: a first paint with nothing
 * in it awaited `all`, got the same four `timed_out`, and the load was declared
 * failed while every request was still in flight and about to answer
 * (measured 2026-09-16: sources answering 300 ms past the budget produced
 * "Error loading papers", and the reader's Try again met a warm edge). `all`
 * now settles each source under its own, longer ceiling, so a first paint that
 * has nothing to show waits for the real answers, and the success path's late
 * pool receives them too.
 */
export function settleSourcesForFirstPaint(promises, timeoutMs, isReady, { allTimeoutMs = DEFAULT_SOURCE_SETTLE_TIMEOUT_MS } = {}) {
  const sources = [...promises];
  const tracked = sources.map((promise) => settleWithin(promise, timeoutMs));
  const results = Array.from({ length: tracked.length }, () => ({ status: 'pending' }));
  let resolved = false;

  const first = new Promise((resolve) => {
    const maybeFinish = () => {
      if (resolved) return;
      const papers = fulfilledPaperLists(results);
      const done = results.every((result) => result.status !== 'pending');
      if (done || (typeof isReady === 'function' && isReady(papers))) {
        resolved = true;
        resolve([...results]);
      }
    };
    if (tracked.length === 0) {
      resolved = true;
      resolve([]);
      return;
    }
    tracked.forEach((settled, index) => {
      settled.then((result) => {
        results[index] = result;
        maybeFinish();
      });
    });
  });

  const all = Promise.all(sources.map((promise) => settleWithin(promise, Math.max(timeoutMs, allTimeoutMs))));
  return { first, all };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/utils/asyncTiming.test.js`
Expected: PASS (los 6 tests, incluidos los 4 anteriores).

- [ ] **Step 5: Commit**

```bash
git add src/utils/asyncTiming.js src/utils/asyncTiming.test.js
git commit -m "fix(feed): el presupuesto de primer pintado deja de ser el plazo de fallo"
```

---

### Task 2: carril prioritario en la cola de OpenAlex

**Files:**
- Modify: `src/services/openAlexClient.js` (`fetch` ~línea 335, `enqueue` ~403, `fetchOnce` strip list ~491)
- Modify: `src/services/adapters/OpenAlexAdapter.js:25-31`
- Test: `src/services/openAlexClient.test.js`

**Interfaces:**
- Produces: `openAlexFetch(url, { priority: true })` pone la petición al frente de la cola (`enqueue(task, { priority })`). `OpenAlexAdapter.search(query, page, { priority: true })` la propaga.

- [ ] **Step 1: Write the failing test** (añadir tras `'limits concurrent OpenAlex requests'`)

```js
test('a priority request jumps the queue instead of waiting behind it', async () => {
  const started = [];
  const resolvers = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const client = new OpenAlexClient({
    maxConcurrent: 1,
    fetchImpl: (url) => new Promise(resolve => {
      started.push(new URL(url).pathname);
      resolvers.push(() => resolve(new Response('{}', { status: 200 })));
    }),
  });

  const requests = [1, 2, 3].map(id => client.json(`https://api.openalex.org/works/W${id}`));
  await tick();
  // The feed's own search arrives while three entity lookups are already
  // queued; it must be the next request out, not the fourth.
  requests.push(client.json('https://api.openalex.org/works/W4', { priority: true }));
  while (started.length < 4) {
    const next = resolvers.shift();
    if (next) next();
    await tick();
  }
  resolvers.splice(0).forEach(resolve => resolve());
  await Promise.all(requests);
  assert.deepEqual(started, ['/works/W1', '/works/W4', '/works/W2', '/works/W3']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/services/openAlexClient.test.js`
Expected: FAIL — `started` es `['/works/W1', '/works/W2', '/works/W3', '/works/W4']`.

- [ ] **Step 3: Implement**

En `openAlexClient.js`, en `fetch(rawUrl, options)`:

```js
    let sharedRequest = method === 'GET' ? this.inFlight.get(requestKey) : null;
    if (!sharedRequest) {
      sharedRequest = this.enqueue(() => this.performFetch(url, options), { priority: options.priority === true });
```

`enqueue`:

```js
  // `priority` puts the task at the head of the queue. The queue is FIFO and
  // two wide, and it is shared by everything that asks OpenAlex: the feed's
  // one search used to enter it behind every followed-entity lookup and wait
  // out their timeouts (measured 2026-09-16: 2.3 s late on a cold entry, 10 s
  // in the control run) — past the feed's own first-paint budget.
  enqueue(task, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject };
      if (priority) this.queue.unshift(item);
      else this.queue.push(item);
      this.drainQueue();
    });
  }
```

`fetchOnce`, lista de claves que no viajan al `fetch`:

```js
    ['timeoutMs', 'cacheTtlMs', 'staleIfError', 'retries', 'persistentKey', 'persistentTtlMs', 'returnMeta', 'priority']
```

En `OpenAlexAdapter.search`:

```js
      const response = await openAlexFetch(url, {
        timeoutMs: 10000,
        cacheTtlMs: 10 * 60 * 1000,
        staleIfError: true,
        signal: filters.signal,
        // The feed's main search: ahead of the entity lookups sharing the queue.
        priority: filters.priority === true,
      });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/services/openAlexClient.test.js src/services/OpenAlexAdapter.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/openAlexClient.js src/services/openAlexClient.test.js src/services/adapters/OpenAlexAdapter.js
git commit -m "feat(openalex): un carril prioritario en la cola para la búsqueda del feed"
```

---

### Task 3: las fuentes principales salen antes que los candidatos opcionales

**Files:**
- Modify: `src/context/FeedContext.jsx:1051-1066` (crear las promesas opcionales) y `:1104-1111` (la búsqueda de OpenAlex)
- Test: `src/context/feedFirstPaint.test.js`

**Interfaces:**
- Consumes: `OpenAlexAdapter.search(query, page, { internalCategories, priority: true })` de la Task 2.

- [ ] **Step 1: Write the failing SOURCE test** (añadir al final de `feedFirstPaint.test.js`)

```js
/**
 * Measured 2026-09-16: the optional candidates were created before the main
 * sources, so the feed's OpenAlex search entered the client's two-wide FIFO
 * queue behind every followed-entity lookup and left the browser 2.3 s late —
 * past its own first-paint budget. The main sources are issued first now, and
 * the feed's search takes the priority lane.
 */
test('SOURCE: the main sources are requested before the optional candidates, and the feed search has priority', async () => {
  const code = stripComments(await read('./FeedContext.jsx'));
  const block = bounded(
    code,
    "queryMode = Math.random() > 0.5 ? 'recent' : 'relevance';",
    'let sourceResults = await first;',
    'the source fan-out',
    90,
  );
  const domainAt = block.indexOf('const domainProm = fetchDomainPapers(');
  const settleAt = block.indexOf('const { first, all } = settleSourcesForFirstPaint(');
  const graphAt = block.indexOf('graphCandidatesPromise = ');
  const followedAt = block.indexOf('followedCandidatesPromise = ');
  assert.ok(domainAt >= 0 && settleAt > domainAt, 'the main sources are issued inside the block');
  assert.ok(graphAt > domainAt && graphAt < settleAt, 'the graph candidates are asked for after the main sources have been issued');
  assert.ok(followedAt > domainAt && followedAt < settleAt, 'the followed candidates are asked for after the main sources have been issued');
  assert.match(
    block,
    /\.search\(openAlexQuery, currentPage \+ 1, \{ internalCategories: openAlexCats, priority: true \}\)/,
    'the feed search takes the priority lane of the OpenAlex queue',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en `graphAt > domainAt` (hoy las opcionales se crean antes).

- [ ] **Step 3: Implement**

En `FeedContext.jsx`, sustituir el bloque de las opcionales (líneas 1051-1066) por dos declaraciones:

```js
        // Optional recommendation signals run alongside the primary sources.
        // They enrich the mix when available without extending first paint.
        // Declared here, ISSUED after the main sources below: the OpenAlex
        // client queues two at a time in arrival order, and asking for the
        // followed entities first put the feed's own search behind all of
        // them (measured 2026-09-16: 2.3 s late on a cold entry, past the
        // first-paint budget).
        let graphCandidatesPromise = Promise.resolve([]);
        let followedCandidatesPromise = Promise.resolve([]);
```

y, dentro del `try` de STEP 3, justo después de `const domainProm = fetchDomainPapers(...)` y antes de `const { first, all } = settleSourcesForFirstPaint(`:

```js
          if (relatedCandidates.current?.length > 0) {
            graphCandidatesPromise = resolveWithin(
              fetchPapersByIds([...relatedCandidates.current].sort(() => 0.5 - Math.random()).slice(0, 5)),
              OPTIONAL_SOURCE_RENDER_BUDGET_MS,
              [],
            );
          }
          if (followedEntities.length > 0) {
            followedCandidatesPromise = resolveWithin(
              fetchFollowedEntityCandidates(followedEntities, queryMode),
              OPTIONAL_SOURCE_RENDER_BUDGET_MS,
              [],
            );
          }
```

La búsqueda de OpenAlex (línea 1110):

```js
             openAlexProm = openAlexAdapter
               .search(openAlexQuery, currentPage + 1, { internalCategories: openAlexCats, priority: true })
               .then(res => res.papers);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/context/feedFirstPaint.test.js src/context/feedReRankAnchor.test.js src/context/feedFollowChange.test.js src/context/feedSkipGuest.test.js`
Expected: PASS (los tests de fuente anteriores siguen acotando sus bloques).

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/context/FeedContext.jsx`
Expected: sin errores.

```bash
git add src/context/FeedContext.jsx src/context/feedFirstPaint.test.js
git commit -m "fix(feed): las fuentes principales se piden antes que los seguidos, y la búsqueda salta la cola"
```

---

### Task 4: el plazo del cliente para `/arxiv` por encima del plazo del Worker

**Files:**
- Modify: `src/services/arxivService.js:190-212`
- Test: `src/services/arxivService.test.js`

**Interfaces:**
- Produces: `export const ARXIV_ROUTE_TIMEOUT_MS = 6_000`.

- [ ] **Step 1: Write the failing test**

Añadir `readFile` y la constante a los imports de `arxivService.test.js`:

```js
import { readFile } from 'node:fs/promises';
import {
  ARXIV_ROUTE_TIMEOUT_MS,
  assignRequestedCategories,
  buildAuthorQuery,
  buildSearchQuery,
  clearCache,
  fetchPapers,
} from './arxivService.js';
```

y el test:

```js
// The Worker gives arXiv five seconds (ARXIV_UPSTREAM_TIMEOUT_MS in
// worker/report-api.js). A client deadline under that gives up before the
// Worker can answer at all, so a slow query could never succeed — measured
// 2026-09-15/16: `sortBy=relevance` answered 502 at 5.07 s, and the client had
// left at 4 s.
test('the Worker route is given longer than the Worker gives arXiv', async () => {
  const worker = await readFile(new URL('../../worker/report-api.js', import.meta.url), 'utf8');
  const upstream = Number(worker.match(/const ARXIV_UPSTREAM_TIMEOUT_MS = (\d+);/)?.[1]);
  assert.ok(Number.isFinite(upstream) && upstream > 0, 'the Worker declares its arXiv deadline');
  assert.ok(ARXIV_ROUTE_TIMEOUT_MS > upstream, `client ${ARXIV_ROUTE_TIMEOUT_MS} ms must exceed the Worker's ${upstream} ms`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/services/arxivService.test.js`
Expected: FAIL — `ARXIV_ROUTE_TIMEOUT_MS` no existe (import undefined → `undefined > 5000` es false).

- [ ] **Step 3: Implement**

En `arxivService.js`, antes de `async function fetchArxivDataNow(url)`:

```js
// The Worker holds arXiv to ARXIV_UPSTREAM_TIMEOUT_MS (5 s, worker/report-api.js)
// and answers 502 when that passes. The client used to leave at 4 s, before the
// Worker could say anything: a `sortBy=relevance` query, which arXiv takes 5 s+
// to answer, could never succeed however healthy the route. One second above
// the Worker's own deadline, and still under the report's per-source 10 s.
export const ARXIV_ROUTE_TIMEOUT_MS = 6_000;
```

y en `fetchArxivDataNow`, sustituir el comentario y el literal:

```js
  // The Worker is the only browser-reachable route to arXiv in production:
  // export.arxiv.org answers without any access-control-allow-origin header, so a
  // direct fetch from the page is blocked however it is spelled. Measured latency
  // of the route is ~0.3s warm; the deadline is set by the Worker's own, above.
  if (PAPER_API_BASE) {
    try {
      const query = new URL(url, 'https://export.arxiv.org').search;
      // The Worker only answers 200 once it has checked the body is a real Atom feed,
      // so an empty parse here means arXiv matched nothing. That is an answer, not a
      // failure: paging past the end of a category has to return [] rather than raise.
      return parseArxivXml(await fetchXmlWithTimeout(
        `${PAPER_API_BASE}/arxiv${query}`,
        ARXIV_ROUTE_TIMEOUT_MS,
        'PaperTok arXiv API error',
      ));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/services/arxivService.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/arxivService.js src/services/arxivService.test.js
git commit -m "fix(arxiv): el cliente espera más que el Worker, no menos"
```

---

### Task 5: verificación en vivo con el mismo arnés, y registro

**Files:**
- Modify: `STATE.md` (entrada nueva arriba, si el fichero existe)
- Docs ya escritos: `docs/AUDITORIA-FEED-ENTRADA-FRIA-2026-09-16.md`, este plan.

- [ ] **Step 1: Build and serve**

Run: `npm run build` y luego el preview `papertok-preview-5174` (vite preview en el 5174). Comprobar que `curl -s localhost:5174/ | grep -o 'assets/index-[^"]*\.js'` coincide con `dist/index.html`.

- [ ] **Step 2: Rerun the control harness on the fix**

Run (scratchpad):

```bash
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 OUT_DIR="$S" \
  node "$S/cold-entry-probe.mjs" fix5000 "nosnapshot,shots,retry,hold=5000,arxivfail"
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 OUT_DIR="$S" \
  node "$S/cold-entry-probe.mjs" fix4300 "nosnapshot,shots,retry,hold=4300,arxivfail"
```

Expected: `verdict … "sheet":true,"feedErr":null` en los dos; primera tarjeta ≈ 5,5–6,5 s (la retención + la respuesta), sin «Error loading papers» en la línea de tiempo del DOM.

- [ ] **Step 3: Natural cold entry, no regression**

Run: `… node "$S/cold-entry-probe.mjs" fixcold "nosnapshot,shots"`
Expected: primera tarjeta ≤ la del control natural (4,7 s); la búsqueda `default.search` de OpenAlex sale ≤ 150 ms después de la primera petición de fuente (antes: 2,3 s).

- [ ] **Step 4: Full test run of the touched areas**

Run: `node --test src/utils/asyncTiming.test.js src/services/openAlexClient.test.js src/services/OpenAlexAdapter.test.js src/services/arxivService.test.js src/context/feedFirstPaint.test.js src/context/feedReRankAnchor.test.js src/context/feedFollowChange.test.js src/context/feedSkipGuest.test.js src/context/interactionProfileLate.test.js src/services/scientificReportService.test.js`
Expected: PASS. Después `npm run lint` (si existe) sin errores.

- [ ] **Step 5: Record and commit the docs**

```bash
git add docs/AUDITORIA-FEED-ENTRADA-FRIA-2026-09-16.md docs/superpowers/plans/2026-09-16-feed-entrada-fria-error.md STATE.md
git commit -m "docs(feed): auditoría y plan del error en frío que Try again curaba"
git push origin main
```

---

## Ejecución (2026-09-16)

Las cinco tareas ejecutadas en esta misma sesión, con el test en rojo antes de
cada cambio. Una pieza no prevista: la Task 2 saltaba la cola pero no las
plazas, y con dos consultas opcionales en vuelo la búsqueda del feed seguía
esperando 3,5 s (medido en `fix5000`). Se añadió una plaza propia para las
peticiones prioritarias (`hasRoomFor` en `openAlexClient.js`, test «a
priority request does not wait for a slot the optional lookups are
holding»). Resultado final del arnés en
`docs/AUDITORIA-FEED-ENTRADA-FRIA-2026-09-16.md` § Verificación.
