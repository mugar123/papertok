# Corrección de las regresiones del primer pintado — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los hallazgos A1–A5 de `docs/AUDITORIA-PRIMER-PINTADO-2026-09-02.md` sin devolver al feed la latencia que los commits `ade641a` y `ef82a42` quitaron: el feed con sesión vuelve a aprovechar las fuentes lentas, los papers de PubMed recuperan Europe PMC, la muestra semántica se toma por recencia, los temas seguidos vuelven a orientar la consulta principal con un presupuesto acotado, y los helpers muertos se van.

**Architecture:** Todo ocurre DESPUÉS del primer pintado o dentro de un presupuesto de milisegundos, nunca delante de él. (A1) Lo que las fuentes lentas devuelven tras `first` se guarda en un ref y entra en el pool de candidatos de la SIGUIENTE página, en vez de anexarse a la visible: así ni se reordena lo que el lector mira ni se pierde. (A2) Europe PMC se pide por los `pmid` de la página ya pintada, con el mismo patrón de fusión tardía que iCite (`setPapers` + `paperFieldsEqual`), desde `FeedContext` y desde `useGuestFeed`. (A3) `selectSemanticProfilePositiveIds` recibe las listas del agregado en su orden de recencia (`curatedIds`, que hace `unshift`), no los `Set` ordenados por id. (A4) Los ids de categoría de los temas seguidos vuelven a `rankedPreferences`, pero el módulo de temas se precalienta cuando se conocen los seguimientos y en `loadPapers` se espera con `resolveWithin(…, 300 ms, [])`. (A5) Se borran `loadItalicSerifFont` y `waitForInitialEnrichment`.

**Tech Stack:** React 19 + Vite 8, tests con `node:test` y `node:assert/strict` (`node --test <fichero>`; suite con `npm test`). `FeedContext.jsx` no se puede montar en Node: sus contratos se fijan con tests de FUENTE (`readFile` + `assert.match`), como hace `src/context/libraryPrefetch.test.js`.

**Spec:** `docs/AUDITORIA-PRIMER-PINTADO-2026-09-02.md` — hallazgos A1–A5, con los descartados al final para no reabrirlos.

## Global Constraints

- Base: `origin/main` tras `git fetch` (es lo desplegado en Vercel). Trabajar en un worktree propio: `git worktree add -b fix/primer-pintado ../papertok-wt-pintado origin/main`, enlazar `node_modules` (`ln -s "$PWD/node_modules" ../papertok-wt-pintado/node_modules`) y **copiar `.env.local`** (sin él `npm test` se cuelga en `worker/ai-rewrite.test.js`).
- Node 22 en CI, 25 en local: nada de APIs solo de Node 25.
- Ningún cambio puede volver a poner una espera de red delante de `setPapers` en el primer pintado. La única espera nueva permitida es la de A4, acotada a `FOLLOWED_TOPIC_RANK_BUDGET_MS = 300`.
- `src/services/PubmedAdapter.test.js` exige que `fetchSearch` no haga NINGÚN fetch extra desde el navegador: el enriquecimiento de Europe PMC va en el feed, después de pintar, nunca dentro del adaptador.
- Comentarios de código en inglés. Mensajes de commit en español con prefijo `fix(feed):` / `chore(feed):`, y trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Otra sesión de Claude puede editar el árbol principal: en el worktree, `git status --short` antes de cada commit y `git add` solo de los ficheros de la tarea.
- Antes del último commit: `npm run check` (secretos, lint, tests, build, dry-run del Worker). Desplegar es acción hacia fuera: **no desplegar sin confirmación del usuario**.

## Decisión abierta (A4)

Restaurar el peso de los temas seguidos en la consulta principal es un cambio de producto que el colaborador deshizo a propósito para ganar latencia. La Task 4 lo devuelve con un presupuesto de 300 ms y precalentamiento, de modo que en la práctica no cuesta nada. Si el usuario prefiere el comportamiento actual (los temas solo llegan por `fetchFollowedEntityCandidates`), **saltar la Task 4** y anotarlo en el informe; el resto del plan no depende de ella.

---

### Task 1: Las fuentes lentas alimentan la página siguiente (A1)

**Files:**
- Create: `src/utils/feedLateCandidates.js`
- Create: `src/utils/feedLateCandidates.test.js`
- Create: `src/context/feedFirstPaint.test.js` (tests de fuente sobre `FeedContext.jsx`)
- Modify: `src/context/FeedContext.jsx` (imports ~L55-62; refs junto a `openAlexEnrichmentAttempts`; `loadPapers` L888-900; bloque `settleSourcesForFirstPaint` L1005-1017; STEP 7 `allFetched` L1225)

**Interfaces:**
- Consumes: `settleSourcesForFirstPaint(promises, timeoutMs, isReady) → { first, all }` y `fulfilledPaperLists(results)` de `src/utils/asyncTiming.js`; `PaperBuilder.deduplicate(papers)`.
- Produces: `lateSourceCandidates(shownPapers, settledResults) → Paper[]` (puro) en `src/utils/feedLateCandidates.js`.

- [ ] **Step 1: Escribir el test del helper puro (RED)**

```js
// src/utils/feedLateCandidates.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { lateSourceCandidates } from './feedLateCandidates.js';

const paper = (id) => ({ id, title: id, sources: { primary: 'test', enrichedBy: [] } });

test('keeps only the papers the first paint did not already show', () => {
  const shown = [paper('a'), paper('b')];
  const settled = [
    { status: 'fulfilled', value: [paper('a'), paper('b')] },
    { status: 'fulfilled', value: [paper('c'), paper('a')] },
    { status: 'timed_out' },
    { status: 'rejected', reason: new Error('down') },
  ];
  assert.deepEqual(lateSourceCandidates(shown, settled).map(p => p.id), ['c']);
});

test('is empty when nothing new arrived', () => {
  assert.deepEqual(lateSourceCandidates([paper('a')], [{ status: 'fulfilled', value: [paper('a')] }]), []);
  assert.deepEqual(lateSourceCandidates([], []), []);
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/utils/feedLateCandidates.test.js`
Expected: FAIL con `Cannot find module '.../feedLateCandidates.js'`.

- [ ] **Step 3: Implementar el helper**

```js
// src/utils/feedLateCandidates.js
import { PaperBuilder } from '../services/PaperBuilder.js';
import { fulfilledPaperLists } from './asyncTiming.js';

/**
 * What the slower sources returned after the page had already painted.
 *
 * `settleSourcesForFirstPaint` resolves `first` as soon as one source has a
 * page's worth of papers; the others keep running and their answers used to
 * be thrown away (measured 2026-09-02: with arXiv answering first, PubMed,
 * OpenAlex and the domain sources of that page never reached a card). These
 * are kept for the NEXT page's candidate pool instead of being appended under
 * the reader — nothing on screen moves, nothing fetched is wasted.
 */
export function lateSourceCandidates(shownPapers, settledResults) {
  const shown = new Set((shownPapers || []).map(paper => paper?.id).filter(Boolean));
  return PaperBuilder.deduplicate(fulfilledPaperLists(settledResults))
    .filter(paper => paper?.id && !shown.has(paper.id));
}
```

- [ ] **Step 4: Verlo pasar**

Run: `node --test src/utils/feedLateCandidates.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Escribir el test de fuente del contrato en FeedContext (RED)**

```js
// src/context/feedFirstPaint.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/**
 * SOURCE tests: FeedContext is a React context this repo cannot mount under
 * node. They pin the contract, not the implementation.
 *
 * ef82a42 painted as soon as one source had a page, and dropped what the
 * others returned afterwards. The late answers must be kept and consumed.
 */
test('the feed keeps what the slower sources return after the first paint', async () => {
  const source = await read('./FeedContext.jsx');
  const block = source.slice(
    source.indexOf('const { first, all } = settleSourcesForFirstPaint('),
    source.indexOf('mainSourceResults = sourceResults;'),
  );
  assert.ok(block.length > 0, 'expected to have found the first-paint block');
  assert.match(block, /all\.then\(/, '`all` must be consumed, not only awaited when nothing painted');
  assert.match(block, /lateSourceCandidates\(painted, settled\)/, 'the late papers are filtered against what painted');
  assert.match(block, /lateSourceCandidatesRef\.current = /, 'and stored for the next page');
});

test('the next page pools the late candidates and then forgets them', async () => {
  const source = await read('./FeedContext.jsx');
  const pool = source.slice(
    source.indexOf('const allFetched = ['),
    source.indexOf('const uniqueMap = new Map();'),
  );
  assert.match(pool, /lateSourceCandidatesRef\.current\.splice\(0\)/,
    'consumed once: a candidate must not be offered on every page');
  const reset = source.slice(
    source.indexOf('const activeSessionId = feedSessionId.current;'),
    source.indexOf('setLoading(true);'),
  );
  assert.match(reset, /lateSourceCandidatesRef\.current = \[\];/,
    'a reset (new session, preference change) starts with an empty pool');
});
```

- [ ] **Step 6: Verlo fallar**

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en `all.then(` ("`all` must be consumed").

- [ ] **Step 7: Cablear FeedContext**

Import (junto a los de `asyncTiming`, ~L59):

```js
import { lateSourceCandidates } from '../utils/feedLateCandidates';
```

Ref, al lado de `openAlexEnrichmentAttempts` (buscar `const openAlexEnrichmentAttempts = useRef`):

```js
  // Papers the slower sources returned after the page painted (see
  // utils/feedLateCandidates.js). Offered to the next page's pool, once.
  const lateSourceCandidatesRef = useRef([]);
```

En `loadPapers`, dentro del `if (reset) {` que ya vacía los mapas de enriquecimiento (~L897):

```js
    if (reset) {
      openAlexEnrichmentAttempts.current.clear();
      openAlexEnrichmentRequests.current.clear();
      lateSourceCandidatesRef.current = [];
    }
```

Bloque de primer pintado (~L1005-1017) — sustituir por:

```js
          const { first, all } = settleSourcesForFirstPaint(
            [arxivProm, pubmedProm, openAlexProm, domainProm],
            FEED_SOURCE_RENDER_BUDGET_MS,
            (papers) => PaperBuilder.deduplicate(papers).length >= PAGE_SIZE,
          );
          let sourceResults = await first;
          mainPapers = PaperBuilder.deduplicate(fulfilledPaperLists(sourceResults));
          if (mainPapers.length === 0) {
            sourceResults = await all;
            mainPapers = PaperBuilder.deduplicate(fulfilledPaperLists(sourceResults));
          } else {
            // The sources still running answer into the next page's pool.
            // Guarded by session, not request: a later page of the same
            // session is exactly who should receive them.
            const painted = mainPapers;
            all.then((settled) => {
              if (feedSessionId.current !== activeSessionId) return;
              lateSourceCandidatesRef.current = lateSourceCandidates(painted, settled);
            });
          }
          mainSourceResults = sourceResults;
```

STEP 7 (~L1225) — sustituir la línea de `allFetched`:

```js
        // ─── STEP 7: Merge, deduplicate, score, and shuffle ───
        const lateMain = lateSourceCandidatesRef.current.splice(0);
        lateMain.forEach(p => { p._type = 'exploit'; });
        const allFetched = [...mainPapers, ...lateMain, ...graphPapers, ...followedPapers, ...explorationPapers];
```

- [ ] **Step 8: Verlo pasar y correr los vecinos**

Run: `node --test src/context/feedFirstPaint.test.js src/utils/feedLateCandidates.test.js src/utils/asyncTiming.test.js src/context/libraryPrefetch.test.js`
Expected: PASS todos. Después `npx eslint src/context/FeedContext.jsx src/utils/feedLateCandidates.js` sin avisos.

- [ ] **Step 9: Commit**

```bash
git add src/utils/feedLateCandidates.js src/utils/feedLateCandidates.test.js src/context/feedFirstPaint.test.js src/context/FeedContext.jsx
git commit -m "fix(feed): las fuentes que llegan tras el primer pintado alimentan la página siguiente

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Europe PMC vuelve a los papers de PubMed, después de pintar (A2)

**Files:**
- Modify: `src/services/europePmcService.js` (añadir `mergeEuropePmcEnrichment`)
- Modify: `src/services/europePmcService.test.js` (añadir tests)
- Modify: `src/context/FeedContext.jsx` (import; junto al bloque iCite L1318-1320 y a la fusión tardía L1395-1408)
- Modify: `src/hooks/useGuestFeed.js` (import; `enrichVisible` L84-91)
- Modify: `src/context/feedFirstPaint.test.js` (añadir tests de fuente)

**Interfaces:**
- Consumes: `enrichPubmedIds(pmids) → Promise<Map<pmid, record>>` (ya existe; `record` es lo que devuelve `mapEuropePmcResult`: `abstract`, `concepts`, `citationCount`, `openAccess`, `openAccessPdfUrl`, `pmcid`, `europePmcUrl`, `license`, `accessSource`, `biomedicalTerms`, `hasReferences`, `hasData`, `hasSupplement`). `PaperBuilder.merge(paper, enrichment, sourceName)`. `paperFieldsEqual` de `src/utils/feedEnrichment.js`.
- Produces: `mergeEuropePmcEnrichment(papers, recordsByPmid: Map|object) → Paper[]`.

- [ ] **Step 1: Test del merge (RED)** — añadir al final de `src/services/europePmcService.test.js` (el fichero ya importa `test` y `assert`; añadir el import de la función nueva a su cabecera):

```js
import { mergeEuropePmcEnrichment } from './europePmcService.js';

const pubmedPaper = (pmid, extra = {}) => ({
  id: `pmid:${pmid}`,
  pmid,
  title: `Paper ${pmid}`,
  abstract: '',
  categories: ['Neoplasms'],
  keywords: ['Neoplasms'],
  openAccess: false,
  sources: { primary: 'pubmed', enrichedBy: [] },
  ...extra,
});

test('merges a Europe PMC record into the PubMed paper that owns the pmid', () => {
  const papers = [pubmedPaper('111'), pubmedPaper('222')];
  const records = new Map([['111', {
    pmid: '111',
    pmcid: 'PMC1',
    abstract: 'A real abstract of more than a few words about cancer.',
    biomedicalTerms: ['Breast Neoplasms'],
    concepts: [{ id: 'epmc:111:0', display_name: 'Breast Neoplasms', level: 2 }],
    citationCount: 12,
    openAccess: true,
    openAccessPdfUrl: 'https://europepmc.org/articles/PMC1?pdf=render',
    europePmcUrl: 'https://europepmc.org/article/MED/111',
    accessSource: 'europepmc',
    hasReferences: true,
    hasData: false,
    hasSupplement: true,
  }]]);

  const [merged, untouched] = mergeEuropePmcEnrichment(papers, records);
  assert.equal(merged.openAccess, true);
  assert.equal(merged.openAccessPdfUrl, 'https://europepmc.org/articles/PMC1?pdf=render');
  assert.equal(merged.pmcid, 'PMC1');
  assert.equal(merged.citationCount, 12);
  assert.deepEqual(merged.biomedicalTerms, ['Breast Neoplasms']);
  assert.deepEqual(merged.keywords, ['Neoplasms', 'Breast Neoplasms']);
  assert.deepEqual(merged.categories, ['Neoplasms', 'Breast Neoplasms']);
  assert.equal(merged.hasSupplement, true);
  assert.ok(merged.sources.enrichedBy.includes('europepmc'));
  assert.ok(Object.is(untouched, papers[1]), 'a paper without a record keeps its identity');
});

test('a record that changes nothing hands back the same object', () => {
  const paper = pubmedPaper('333', { sources: { primary: 'pubmed', enrichedBy: ['europepmc'] } });
  const [result] = mergeEuropePmcEnrichment([paper], new Map([['333', { pmid: '333' }]]));
  assert.ok(Object.is(result, paper));
});

test('accepts a plain object keyed by pmid and tolerates a pmid: prefix', () => {
  const [result] = mergeEuropePmcEnrichment(
    [pubmedPaper('444', { pmid: 'pmid:444' })],
    { 444: { pmid: '444', citationCount: 3 } },
  );
  assert.equal(result.citationCount, 3);
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/services/europePmcService.test.js`
Expected: FAIL con `mergeEuropePmcEnrichment is not a function` (o export ausente).

- [ ] **Step 3: Implementar el merge** — al final de `src/services/europePmcService.js`, con el import arriba:

```js
import { PaperBuilder } from './PaperBuilder.js';
import { paperFieldsEqual } from '../utils/feedEnrichment.js';
```

```js
const normalizePmid = value => String(value || '').trim().replace(/^pmid:/i, '');

function unionStrings(base, extra) {
  return [...new Set([...(base || []), ...(extra || [])].filter(Boolean))];
}

/**
 * Late merge of Europe PMC records into an already painted page.
 *
 * ade641a took this enrichment out of PubmedAdapter.fetchSearch so PubMed
 * would stop losing the first-page race, and nothing picked it up again:
 * PubMed cards lost open access, the PMC PDF, citations and the biomedical
 * terms (audit 2026-09-02, A2). Same identity discipline as
 * mergeICiteEnrichment: a record that changes nothing returns the same
 * object, so memo(PaperCard) keeps its observer.
 */
export function mergeEuropePmcEnrichment(papers, recordsByPmid) {
  const lookup = recordsByPmid instanceof Map
    ? recordsByPmid
    : new Map(Object.entries(recordsByPmid || {}));
  if (lookup.size === 0) return papers;

  return papers.map((paper) => {
    const pmid = normalizePmid(paper?.pmid);
    const record = pmid ? lookup.get(pmid) : null;
    if (!record) return paper;

    const merged = PaperBuilder.merge(paper, record, 'europepmc');
    if (record.biomedicalTerms?.length > 0) {
      merged.biomedicalTerms = record.biomedicalTerms;
      merged.categories = unionStrings(merged.categories, record.biomedicalTerms);
      merged.keywords = unionStrings(merged.keywords, record.biomedicalTerms);
    }
    for (const flag of ['hasReferences', 'hasData', 'hasSupplement']) {
      if (record[flag] !== undefined && merged[flag] === undefined) merged[flag] = record[flag];
    }
    if (record.openAccess && !merged.landingPageUrl && record.landingPageUrl) {
      merged.landingPageUrl = record.landingPageUrl;
    }
    return paperFieldsEqual(merged, paper) ? paper : merged;
  });
}
```

- [ ] **Step 4: Verlo pasar**

Run: `node --test src/services/europePmcService.test.js src/utils/feedEnrichment.test.js`
Expected: PASS. Si el test de identidad falla porque `PaperBuilder.merge` añade `europepmc` a `enrichedBy`, es correcto: el test lo prevé partiendo de un paper ya marcado.

- [ ] **Step 5: Test de fuente para el cableado (RED)** — añadir a `src/context/feedFirstPaint.test.js`:

```js
test('PubMed cards get Europe PMC after paint, next to iCite', async () => {
  const feed = await read('./FeedContext.jsx');
  assert.match(feed, /const europePmcPromise = enrichPubmedIds\(iCitePmids\)/,
    'asked for the painted page\'s pmids, never before setPapers');
  assert.match(feed, /mergeEuropePmcEnrichment\(current, lateRecords\)/,
    'merged into state with the identity-preserving helper');
  const guest = await read('../hooks/useGuestFeed.js');
  assert.match(guest, /enrichPubmedIds\(/, 'the guest feed enriches its PubMed cards too');
  assert.match(guest, /mergeEuropePmcEnrichment\(current, /);
});

test('the PubMed adapter itself stays free of browser-side enrichment', async () => {
  const adapter = await read('../services/adapters/PubmedAdapter.js');
  assert.doesNotMatch(adapter, /enrichPubmedIds|openAlexJson/,
    'PubmedAdapter.test.js forbids extra fetches inside fetchSearch');
});
```

- [ ] **Step 6: Verlo fallar**

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en `europePmcPromise`.

- [ ] **Step 7: Cablear FeedContext** — import junto al de iCite (~L62):

```js
import { enrichPubmedIds, mergeEuropePmcEnrichment } from '../services/europePmcService';
```

Junto a `const iCitePromise = fetchICiteMetrics(iCitePmids);` (~L1319):

```js
      const iCitePromise = fetchICiteMetrics(iCitePmids);
      // Same pmids, same moment: after the page is on screen. A failure is a
      // page without Europe PMC data, never a page that fails to paint.
      // (`enrichPubmedIds([])` answers an empty Map without a request.)
      const europePmcPromise = enrichPubmedIds(iCitePmids).catch((err) => {
        console.warn('Europe PMC feed enrichment failed', err);
        return new Map();
      });
```

Después del bloque `if (iCitePmids.length > 0) { iCitePromise.then(...) }` (~L1408):

```js
      if (iCitePmids.length > 0) {
        europePmcPromise.then((lateRecords) => {
          if (feedSessionId.current !== activeSessionId || !lateRecords || lateRecords.size === 0) return;
          setPapers(current => {
            const enriched = mergeEuropePmcEnrichment(current, lateRecords);
            const cachedMode = feedCache.current[activeMode];
            if (cachedMode) {
              feedCache.current[activeMode] = { ...cachedMode, papers: enriched };
              scheduleFeedSnapshotWrite(activeUserId.current, preferenceSignature, feedCache.current[activeMode]);
            }
            return enriched;
          });
        });
      }
```

- [ ] **Step 8: Cablear useGuestFeed** — import:

```js
import { enrichPubmedIds, mergeEuropePmcEnrichment } from '../services/europePmcService.js';
```

Dentro de `enrichVisible` (L84-91), después del bloque de OpenAlex y ANTES de cerrar la función:

```js
        const pmids = [...new Set(batch.map(paper => paper?.pmid).filter(Boolean))];
        if (pmids.length > 0) {
          enrichPubmedIds(pmids).catch(() => new Map()).then((lateRecords) => {
            if (requestId !== requestIdRef.current || !lateRecords || lateRecords.size === 0) return;
            setPapers((current) => mergeEuropePmcEnrichment(current, lateRecords));
          });
        }
```

Nota: el `return` temprano `if (ids.length === 0) return;` de OpenAlex debe dejar de cortar la función antes del bloque de pmids. Reescribir `enrichVisible` así:

```js
      const enrichVisible = (batch) => {
        const ids = batch.map(getOpenAlexEnrichmentId).filter(Boolean);
        if (ids.length > 0) {
          enrichPapersBatch(ids, { timeoutMs: 6_500 }).catch(() => ({})).then((lateEnrichment) => {
            if (requestId !== requestIdRef.current || !lateEnrichment || !Object.keys(lateEnrichment).length) return;
            setPapers((current) => mergeOpenAlexEnrichment(current, lateEnrichment));
          });
        }
        const pmids = [...new Set(batch.map(paper => paper?.pmid).filter(Boolean))];
        if (pmids.length > 0) {
          enrichPubmedIds(pmids).catch(() => new Map()).then((lateRecords) => {
            if (requestId !== requestIdRef.current || !lateRecords || lateRecords.size === 0) return;
            setPapers((current) => mergeEuropePmcEnrichment(current, lateRecords));
          });
        }
      };
```

- [ ] **Step 9: Verlo pasar**

Run: `node --test src/context/feedFirstPaint.test.js src/services/europePmcService.test.js src/services/PubmedAdapter.test.js`
Expected: PASS. `npx eslint src/context/FeedContext.jsx src/hooks/useGuestFeed.js src/services/europePmcService.js` limpio.

- [ ] **Step 10: Commit**

```bash
git add src/services/europePmcService.js src/services/europePmcService.test.js src/context/FeedContext.jsx src/hooks/useGuestFeed.js src/context/feedFirstPaint.test.js
git commit -m "fix(feed): los papers de PubMed recuperan Europe PMC, fusionado después de pintar

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: La muestra semántica se toma por recencia (A3)

**Files:**
- Modify: `src/context/FeedContext.jsx` (~L819: `selectSemanticProfilePositiveIds(liked, saved)`)
- Modify: `src/context/feedFirstPaint.test.js` (añadir test de fuente)

**Interfaces:**
- Consumes: `curatedIds(profile, name) → string[]` de `src/utils/interactionProfile.js`, que devuelve el orden del agregado — el más reciente PRIMERO (`addCurated` hace `unshift`). `selectSemanticProfilePositiveIds(liked, saved, cap)` conserva el orden de entrada y corta a 24.

- [ ] **Step 1: Test de fuente (RED)**

```js
test('the semantic sample is the 24 most recent likes, not the 24 lowest ids', async () => {
  const feed = await read('./FeedContext.jsx');
  assert.match(feed, /selectSemanticProfilePositiveIds\(\s*curatedIds\(profile, 'liked'\),\s*curatedIds\(profile, 'saved'\),?\s*\)/,
    'the aggregate order (newest first) must feed the cap, never the id-sorted Sets');
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en "the aggregate order".

- [ ] **Step 3: Cambiar la llamada** (~L819):

```js
        // OpenAlex concept weights are a ranking overlay, not a gate. Cap the
        // sample and run it after the first source wave has the network, so a
        // large liked library cannot stall the first cards. The sample comes
        // from the aggregate's own order (newest first): `liked`/`saved` above
        // are Sets sorted by id for the lists, and cutting those to 24 kept
        // the alphabetically-first likes forever (audit 2026-09-02, A3).
        const positiveIds = selectSemanticProfilePositiveIds(
          curatedIds(profile, 'liked'),
          curatedIds(profile, 'saved'),
        );
```

- [ ] **Step 4: Verlo pasar**

Run: `node --test src/context/feedFirstPaint.test.js src/utils/feedInteractions.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context/FeedContext.jsx src/context/feedFirstPaint.test.js
git commit -m "fix(feed): el perfil semántico muestrea los últimos me gusta, no los primeros por id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Los temas seguidos vuelven a orientar la consulta, con presupuesto (A4 — ver «Decisión abierta»)

**Files:**
- Modify: `src/context/FeedContext.jsx` (constantes ~L75; `rankedPreferences` L913-921; efecto de seguimientos L1499-1519)
- Modify: `src/context/feedFirstPaint.test.js`

**Interfaces:**
- Consumes: `loadTopicRetrieval() → Promise<module>` (import dinámico ya definido en L66); `getFollowedTopicCategoryIds(followedEntities) → string[]` del módulo; `resolveWithin(promise, timeoutMs, fallback)` de `asyncTiming`.

- [ ] **Step 1: Test de fuente (RED)**

```js
test('followed topics rank the main query again, inside a budget and prewarmed', async () => {
  const feed = await read('./FeedContext.jsx');
  assert.match(feed, /const FOLLOWED_TOPIC_RANK_BUDGET_MS = 300;/);
  const ranked = feed.slice(
    feed.indexOf('const followedTopicIds = '),
    feed.indexOf('const rankedPreferences = '),
  );
  assert.ok(ranked.length > 0, 'expected to have found the followed-topic lookup');
  assert.match(ranked, /resolveWithin\(/, 'never unbounded on the critical path again');
  assert.match(ranked, /FOLLOWED_TOPIC_RANK_BUDGET_MS,\s*\[\],?\s*\)/, 'the fallback is "no topic ids", not a throw');
  assert.match(feed, /const rankedPreferences = \[\.\.\.new Set\(\[\.\.\.userPreferences, \.\.\.followedTopicIds\]\)\]/);
  const prewarm = feed.slice(feed.indexOf('const followingSignatureRef = useRef(null);'));
  assert.match(prewarm, /void loadTopicRetrieval\(\);/,
    'the 32 KB topic table loads when follows are known, so loadPapers finds it resident');
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/context/feedFirstPaint.test.js`
Expected: FAIL en `FOLLOWED_TOPIC_RANK_BUDGET_MS`.

- [ ] **Step 3: Constante** — junto a `OPTIONAL_SOURCE_RENDER_BUDGET_MS` (~L76):

```js
// How long the main query may wait for the followed-topic category ids. The
// topic module is prewarmed the moment follows are known (see the following
// effect), so this is normally 0 ms and the budget only covers a cold chunk.
const FOLLOWED_TOPIC_RANK_BUDGET_MS = 300;
```

- [ ] **Step 4: `rankedPreferences`** — sustituir L913-921 por:

```js
        // Followed topics widen the main query. The lookup used to be an
        // unbounded `await loadTopicRetrieval()` in front of every source;
        // it is now budgeted and normally served from the prewarmed module.
        const followedTopicIds = followedEntities.some(entity => entity?.type === 'topic')
          ? await resolveWithin(
            loadTopicRetrieval().then(module => module.getFollowedTopicCategoryIds(followedEntities)),
            FOLLOWED_TOPIC_RANK_BUDGET_MS,
            [],
          )
          : [];
        const rankedPreferences = [...new Set([...userPreferences, ...followedTopicIds])].sort((a, b) => {
          const affA = categoryAffinities.current[a] || 0;
          const affB = categoryAffinities.current[b] || 0;
          return affB - affA;
        });
```

- [ ] **Step 5: Precalentar** — al principio del efecto que sigue a `const followingSignatureRef = useRef(null);` (~L1500), antes de `if (followingLoading) return;`:

```js
  useEffect(() => {
    // Warm the topic table as soon as a topic follow is known, off the feed's
    // critical path, so loadPapers meets a resident module.
    if (followedEntities.some(entity => entity?.type === 'topic')) void loadTopicRetrieval();
    if (followingLoading) return;
```

- [ ] **Step 6: Verlo pasar**

Run: `node --test src/context/feedFirstPaint.test.js && npx eslint src/context/FeedContext.jsx`
Expected: PASS y lint limpio. Comprobar que `loadPapers` sigue listando `followedEntities` en sus dependencias (ya lo hace, L1426).

- [ ] **Step 7: Commit**

```bash
git add src/context/FeedContext.jsx src/context/feedFirstPaint.test.js
git commit -m "fix(feed): los temas seguidos vuelven a la consulta principal con un presupuesto de 300 ms

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Borrar los helpers muertos (A5)

**Files:**
- Modify: `src/utils/loadDisplayFonts.js` (quitar `loadItalicSerifFont` y su `italicSerifPromise`)
- Modify: `src/utils/feedEnrichment.js` (quitar `waitForInitialEnrichment`, L80-92)
- Modify: `src/utils/feedEnrichment.test.js` (quitar el import L8 y el test «stops waiting when initial enrichment exceeds its budget», L112-115)

- [ ] **Step 1: Comprobar que nadie los usa**

Run: `grep -rn "loadItalicSerifFont\|waitForInitialEnrichment" src worker proxy`
Expected: solo sus definiciones y el test de `feedEnrichment.test.js`.

- [ ] **Step 2: Borrar** — `loadDisplayFonts.js` queda así:

```js
let profileFontsPromise = null;

/**
 * Nunito is the one warm line on a public profile (the bio). Loading it from
 * main.jsx put a variable font on every first paint, including the feed.
 * Newsreader italic is not loaded anywhere on purpose: no stylesheet sets an
 * italic serif (audit 2026-09-02, A5), and a helper nobody calls is a promise
 * nobody keeps.
 */
export function loadProfileFonts() {
  if (!profileFontsPromise) {
    profileFontsPromise = import('@fontsource-variable/nunito/wght.css');
  }
  return profileFontsPromise;
}
```

En `feedEnrichment.js` eliminar la función `waitForInitialEnrichment` entera (L80-92). En `feedEnrichment.test.js` quitar `waitForInitialEnrichment,` del import y el test de L112-115.

- [ ] **Step 3: Verificar**

Run: `node --test src/utils/feedEnrichment.test.js && npx eslint src/utils/loadDisplayFonts.js src/utils/feedEnrichment.js src/utils/feedEnrichment.test.js`
Expected: PASS, lint limpio.

- [ ] **Step 4: Commit**

```bash
git add src/utils/loadDisplayFonts.js src/utils/feedEnrichment.js src/utils/feedEnrichment.test.js
git commit -m "chore(feed): quitar loadItalicSerifFont y waitForInitialEnrichment, sin llamadores

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Verificación de conjunto y cierre del informe

**Files:**
- Modify: `docs/AUDITORIA-PRIMER-PINTADO-2026-09-02.md` (añadir sección «Corregido»)

- [ ] **Step 1: Suite y build completos**

Run: `npm run check`
Expected: sin secretos, lint limpio, `fail 0` en tests, build sin avisos nuevos, dry-run del Worker OK.

- [ ] **Step 2: Verificación en vivo del feed (sin sesión)** — con el servidor del worktree en un puerto que el Worker admita (5174; 5181 devuelve CORS), abrir `http://localhost:5174/` como invitado y confirmar en consola que, tras pintar, aparecen peticiones a `europepmc.org` con `EXT_ID:` y que ninguna tarjeta salta de sitio al llegar. Con sesión es el usuario quien lo comprueba: un feed con categorías de medicina debe mostrar en las tarjetas de PubMed el PDF de PMC o la marca de acceso abierto al cabo de uno o dos segundos.

- [ ] **Step 3: Anotar en el informe** — añadir al final de `docs/AUDITORIA-PRIMER-PINTADO-2026-09-02.md`:

```markdown
## Corregido (fecha y commits)

- A1 — `fix(feed): las fuentes que llegan tras el primer pintado alimentan la página siguiente` (`<hash>`).
- A2 — `fix(feed): los papers de PubMed recuperan Europe PMC, fusionado después de pintar` (`<hash>`). OpenAlex por pmid no se restaura: Europe PMC cubre abstract y términos.
- A3 — `fix(feed): el perfil semántico muestrea los últimos me gusta` (`<hash>`).
- A4 — `<hecho con presupuesto de 300 ms (hash) | descartado a propósito: se mantiene el comportamiento de ade641a>`.
- A5 — `chore(feed): quitar helpers sin llamadores` (`<hash>`).
```

- [ ] **Step 4: Commit del informe y entrega**

```bash
git add docs/AUDITORIA-PRIMER-PINTADO-2026-09-02.md
git commit -m "docs(feed): cerrar en el informe de primer pintado lo corregido

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Después: `git push -u origin fix/primer-pintado` y abrir el PR contra `main`. No desplegar nada desde aquí; Vercel construye al fusionar.
