# Deuda diferida de Semantic Scholar — plan de arreglo

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los diez hallazgos que las revisiones del endurecimiento de Semantic Scholar dejaron diferidos: cuatro trampas en tests, dos duplicaciones, una unidad de cuota que se pierde, y tres pulidos.

**Architecture:** Casi todo es test o una línea. El único cambio de forma está en el Worker: `cacheResponse` resuelve el techo una vez y se lo pasa a las dos puertas, `reserveSharedMinuteQuota` devuelve el asiento que reservó, y `awaitSharedPace` lo devuelve al ledger cuando el compás rechaza — con `releaseRequestQuota`, que ya existe y ya se usa así en `ai-explanation.js`. La cabecera `retry-after` del compás pasa a derivarse de su propia ventana de espera en vez de ser un literal.

**Tech Stack:** Cloudflare Worker (`worker/report-api.js`, `worker/upstream-pace.js`, Durable Object `RequestQuotaLedger`), React + Vite en `src/`, `node --test`.

**Spec:** Los hallazgos vienen de las revisiones por tarea y de la revisión final de `docs/superpowers/plans/2026-09-03-semantic-scholar-endurecimiento.md` (fusionado en `080ea98`, desplegado el 03-09). Se listan aquí porque el libro de a bordo de aquella ejecución ya no existe; este documento es su registro.

## Global Constraints

- Comentarios de código, mensajes de commit y documentación técnica **en inglés** (`worker/AGENTS.md`); prosa de `STATE.md` en español.
- **Cada test nuevo o reescrito muere por mutación**: se aplica la mutación indicada, se ejecuta, tiene que estar en rojo, se restaura. La mutación se **ejecuta**, no se razona — tres tareas del plan anterior volvieron por esto. Convención de `ce139ce`.
- **Ningún test puede colgarse.** Un test que espera una promesa que puede no asentarse nunca es un test que, bajo `node --test` sin timeout, deja la suite parada. Toda espera sobre una promesa que podría no resolverse se observa con una bandera y se comprueba tras drenar microtareas, nunca con `await` directo.
- **No sondear producción.** Ni `api.papertok.app` ni `api.semanticscholar.org`: cada sonda gasta el segundo de un lector, y la sesión que desplegó esto ya degradó la fuente sondeándola. Nada de este plan necesita la red.
- Baseline: `npm test` en un checkout limpio de `1cee525` (= `origin/main`) da **1962/1962**. El árbol principal tiene ahora mismo trabajo de CSS sin commitear de otra sesión (`src/styles/contrast.test.js`, `variables.css`, `ProfilePage.css`, `button-variants.js`) que rompe **un** test de contraste; **no es de este plan** y no se toca. Ejecutar en un worktree desde `1cee525` y copiar `.env.local` a mano (sin él un test del Worker se cuelga en vez de fallar).
- `wrangler.toml`, `worker/request-quota-ledger.js` y `src/components/Feed/RelatedPapersSheet.jsx` no se tocan.
- `S2_GLOBAL_MINUTE_LIMIT = 60` y `DEFAULT_MAX_WAIT_MS = 2_500` se quedan como están.
- **Un cambio de comportamiento visible**, declarado: la cabecera `retry-after` que devuelve el compás al rechazar pasa de `2` a `3` (Task 5). Es la consecuencia de derivarla de la ventana real de 2,5 s en vez de inventarla; ningún cliente la obedece hoy.
- Si esto se despliega, **el Worker antes que el frontend**, como siempre desde el 03-09.
- Trailer de commit exacto: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`

---

## Mapa de ficheros

| Fichero | Tareas | Qué cambia |
|---|---|---|
| `src/services/relatedPapersService.test.js` | 1, 3 | el test del presupuesto no puede colgarse; test de deduplicación con dos `limit`; el `import` de mitad de fichero sube arriba |
| `src/services/semanticScholarService.test.js` | 2 | el paper reenviado es *el* paper, por referencia |
| `worker/report-api.test.js` | 4, 5, 6 | `upstreamStatus` ausente en el cuelgue de `/related`; la cabecera del compás contra la constante; el asiento de minuto se devuelve |
| `worker/upstream-pace.js` | 5 | exporta `DEFAULT_MAX_WAIT_MS` y `PACE_RETRY_AFTER_SECONDS` |
| `worker/upstream-pace.test.js` | 5 | la cabecera cubre la ventana |
| `worker/report-api.js` | 5, 6 | `awaitSharedPace` usa la constante; el techo se resuelve una vez; la reserva de minuto se devuelve al rechazar |
| `STATE.md`, `worker/README.md` | 7 | atribución `@mugar`; entrada de esta pasada; la cabecera nueva |

**Para quien ejecute con subagentes:** las tareas 1–4 son ediciones de test del mismo corte, pequeñas e independientes; un solo despacho con las cuatro es lo razonable. Las tareas 5 y 6 tocan `report-api.js` y van en orden. La 7 es solo documentación.

---

### Task 1: El test del presupuesto del cliente falla en vez de colgarse

**Files:**
- Modify: `src/services/relatedPapersService.test.js:81-114`

**Interfaces:** ninguna nueva.

**Por qué.** `relatedPapersService.test.js:113` hace `await assert.rejects(() => pending, /aborted/)` después de avanzar el reloj falso exactamente hasta 11 000 ms. Si alguien alarga el presupuesto de `relatedPapersService.js:60` a 12 000, el abort no dispara, `pending` nunca se asienta, y `assert.rejects` espera para siempre: `node --test` no tiene timeout por defecto, así que la suite entera se queda parada sin ningún fallo que leer. El test muere bien con un presupuesto más corto y **se cuelga** con uno más largo. Tiene que morir con los dos.

- [ ] **Step 1: Reescribir el tramo final del test**

Sustituir desde `let settled = false;` (línea 103) hasta el cierre del test (línea 114) por:

```js
  // Observed through a flag and a microtask drain, never awaited directly: a
  // budget longer than the ticks below would leave `pending` unsettled for
  // ever, and `await assert.rejects(pending)` would then hang the whole suite
  // under `node --test`'s default of no timeout, rather than fail this test.
  let outcome = null;
  const pending = getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER });
  pending.then(value => { outcome = { value }; }, error => { outcome = { error }; });

  await flush();
  t.mock.timers.tick(10_999);
  await flush();
  assert.equal(outcome, null, 'must still be waiting just under eleven seconds in');

  t.mock.timers.tick(1);
  await flush();
  assert.ok(outcome, 'must have settled once eleven seconds are up -- a longer budget would leave this null');
  assert.match(String(outcome.error), /aborted/, 'must abort, not resolve');
});
```

- [ ] **Step 2: Verde**

Run: `node --test src/services/relatedPapersService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 5`, `fail 0`.

- [ ] **Step 3: Mutación en las dos direcciones**

En `src/services/relatedPapersService.js:60`, cambiar `11000` por `12000`, correr el fichero: el test tiene que **fallar** (`outcome` sigue `null`), **no colgarse** — si el comando no devuelve en unos segundos, el arreglo no vale. Restaurar. Cambiar `11000` por `8000`, correr: falla en `outcome === null` a los 10 999 ms. Restaurar.

- [ ] **Step 4: Commit**

```bash
git add src/services/relatedPapersService.test.js
git commit -m "test(related): the client-budget test fails on a longer budget instead of hanging the suite

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: El paper que llega a `fetchRelated` es el paper, no una copia

**Files:**
- Modify: `src/services/semanticScholarService.test.js:34-46`

**Interfaces:** ninguna nueva.

**Por qué.** Un mutante concreto sobrevive a toda la suite: en `semanticScholarService.js:46`, reenviar `{ doi: paper.doi, arxivId: paper.arxivId }` en vez de `paper` pasa todos los tests, y rompe el autofiltrado de `fetchRelatedFromWorker` (`relatedPapersService.js:66`), que lee `paper.id` para no devolver el propio paper entre sus relacionados. El test del DOI (`:45`) hace `deepEqual(asked, [{ doi: '10.1000/xyz' }])` con un paper que solo tiene `doi`, así que una reconstrucción de un campo da igual que el original.

- [ ] **Step 1: Reescribir el test del DOI**

Sustituir el test `asks for a paper that has a DOI and no arXiv id, instead of skipping it` (líneas 34-46) por:

```js
test('asks for a paper that has a DOI and no arXiv id, and hands over the paper itself', async () => {
  clearRecommendationCache();
  const asked = [];
  const fetchRelated = async paper => { asked.push(paper); return [{ arxivId: '2601.00001' }]; };

  // A PubMed or OpenAlex paper used to be `getPaperRecommendations(undefined)`:
  // no recommendation, no log, and nobody knew the feed only expanded from
  // arXiv. `/related` takes a DOI and so does this.
  const paper = { id: 'pubmed:31000001', doi: '10.1000/xyz', title: 'One' };
  const ids = await getPaperRecommendations(paper, { fetchRelated });

  assert.deepEqual(ids, ['2601.00001']);
  // By reference, not by shape: `fetchRelatedFromWorker` filters the paper out
  // of its own related list by `paper.id`, so a forwarded copy that carried only
  // the identifiers would pass a `deepEqual` on `{ doi }` and still lose the id.
  assert.equal(asked.length, 1);
  assert.equal(asked[0], paper, 'the paper must be forwarded as-is, not rebuilt from its identifiers');
});
```

- [ ] **Step 2: Verde**

Run: `node --test src/services/semanticScholarService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 7`, `fail 0`.

- [ ] **Step 3: Mutación**

En `src/services/semanticScholarService.js:46`, cambiar `fetchRelated(paper, RECOMMENDATION_LIMIT)` por `fetchRelated({ doi: paper.doi, arxivId: paper.arxivId }, RECOMMENDATION_LIMIT)`. Correr: el test nuevo en rojo (`asked[0] !== paper`). Comprobar que el test de identidad (`asks under the same identity…`) **sigue en verde** bajo esta mutación — ese es exactamente el motivo de que hiciera falta otro. Restaurar.

- [ ] **Step 4: Commit**

```bash
git add src/services/semanticScholarService.test.js
git commit -m "test(feed): the recommender forwards the paper itself, not a copy of its identifiers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Dos `limit` distintos en el mismo tick comparten la petición, y el `import` sube arriba

**Files:**
- Modify: `src/services/relatedPapersService.test.js:1-13` (imports) y añadir un test tras `shares one request between two callers…` (:62)

**Interfaces:** ninguna nueva.

**Por qué.** El test de deduplicación concurrente usa `limit=8` en las dos llamadas. El caso real que motivó el mapa en vuelo es el feed pidiendo 20 mientras la hoja pide 8 por el mismo paper, y esa combinación nunca se ejercita junta. Es amplitud, no un agujero — `IN_FLIGHT` va por `paperId` y `slice()` no muta — pero el test que existe no dice lo que el comentario de encima cuenta. De paso, el `import` de la línea 11 sube junto al de la 3: ESM lo iza igual, pero un lector no.

- [ ] **Step 1: Fusionar los imports**

Las líneas 1-3 y 11 pasan a ser:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { clearRelatedPapersCache, getRelatedPapers, getSemanticScholarPaperId } from './relatedPapersService.js';
```

y la línea 11 (`import { clearRelatedPapersCache, getRelatedPapers } …`) se borra.

- [ ] **Step 2: El test**

Añadir después de `shares one request between two callers that ask for the same paper at once`:

```js
test('shares one request between the feed asking for twenty and the sheet asking for eight, in the same tick', async () => {
  clearRelatedPapersCache();
  let calls = 0;
  const fetchWorker = async () => { calls += 1; return twentyRecommendations(); };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  // The pairing the in-flight map exists for: `traverseAndExpandNetwork` seeds
  // from twenty on a like, and the sheet opens on eight in the same second.
  const [forFeed, forSheet] = await Promise.all([
    getRelatedPapers(paper, 20, { fetchWorker, apiBase: WORKER }),
    getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }),
  ]);

  assert.equal(calls, 1);
  assert.equal(forFeed.length, 20);
  assert.equal(forSheet.length, 8);
  assert.deepEqual(forSheet, forFeed.slice(0, 8), 'each caller trims its own view of one shared answer');
});
```

- [ ] **Step 3: Verde y lint**

Run: `node --test src/services/relatedPapersService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 6`, `fail 0`.

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 4: Mutación**

En `src/services/relatedPapersService.js:85-86`, sustituir `let request = IN_FLIGHT.get(paperId); if (!request) {` por `let request; {` (crear siempre la promesa). Correr: el test nuevo y el anterior en rojo con `calls` = `2`. Restaurar.

- [ ] **Step 5: Commit**

```bash
git add src/services/relatedPapersService.test.js
git commit -m "test(related): the feed's twenty and the sheet's eight share one request, and the imports sit together

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: El cuelgue de `/related` no relaya un estado que no tiene

**Files:**
- Modify: `worker/report-api.test.js` — el test `/related names a stalled Semantic Scholar instead of dressing it as a generic failure`

**Interfaces:** ninguna nueva.

**Por qué.** Su análogo para las fuentes (`names a timed-out upstream instead of dressing it as a generic failure`) afirma `body.upstreamStatus === undefined` con el mensaje «a stall has no status to relay». El de `/related`, escrito en la Task 1 del plan anterior, no lo afirma. Una línea, y la asimetría desaparece.

- [ ] **Step 1: La aserción**

Al final de ese test, después de `assert.equal(body.code, 'UPSTREAM_TIMEOUT');`, añadir:

```js
  assert.equal(body.upstreamStatus, undefined, 'a stall has no status to relay');
```

- [ ] **Step 2: Verde**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 101`, `fail 0`.

- [ ] **Step 3: Mutación**

En `worker/report-api.js`, dentro de `upstreamFailureResponse`, cambiar `...(error?.status ? { upstreamStatus: error.status } : {})` por `upstreamStatus: error?.status ?? 0`. Correr: este test en rojo (`0 !== undefined`); el análogo de OpenReview también, lo que confirma que ahora los dos vigilan lo mismo. Restaurar.

- [ ] **Step 4: Commit**

```bash
git add worker/report-api.test.js
git commit -m "test(worker): a stalled /related relays no upstream status, like every other source

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: La cabecera `retry-after` del compás se deriva de su ventana

**Files:**
- Modify: `worker/upstream-pace.js:19` (exportar la constante y añadir la derivada)
- Modify: `worker/report-api.js` — el `import` de `upstream-pace.js` y `awaitSharedPace`
- Test: `worker/upstream-pace.test.js`, `worker/report-api.test.js` (el test `refuses a Semantic Scholar search itself when no second is free…`)

**Interfaces:**
- Produces: `export const DEFAULT_MAX_WAIT_MS = 2_500` y `export const PACE_RETRY_AFTER_SECONDS = String(Math.ceil(DEFAULT_MAX_WAIT_MS / 1000))` (= `'3'`) desde `worker/upstream-pace.js`. Task 6 usa `PACE_RETRY_AFTER_SECONDS` en el bloque que reescribe.

**Por qué.** `awaitSharedPace` responde `'retry-after': '2'` con un comentario que lo ata a los 2,5 s de `DEFAULT_MAX_WAIT_MS`, pero nada en el código los ata: quien suba la ventana deja la cabecera mintiendo. Es además una tercera grafía de la misma decisión junto a `UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS['/sources/s2'] = '2'`. Las dos **no** son el mismo número: la del fallback dice «la ventana del proveedor es un segundo»; la del compás dice «vuelve cuando haya pasado mi ventana de búsqueda». Derivada, la del compás es `ceil(2500 / 1000)` = **3**, no 2 — y es la correcta: el compás rechazó porque no encontró segundo libre en 2,5 s, así que decirle al cliente que vuelva a los 2 es decirle que vuelva antes de que la búsqueda que acaba de fracasar hubiera terminado.

- [ ] **Step 1: El test unitario**

Añadir a `worker/upstream-pace.test.js`, junto a los imports, `DEFAULT_MAX_WAIT_MS, PACE_RETRY_AFTER_SECONDS` al `import` de `./upstream-pace.js`, y al final del fichero:

```js
// The header a refused caller receives has to cover the whole window the beat
// just searched: telling it to come back sooner than that is telling it to
// come back before the search that just failed would even have finished.
test('tells a refused caller to come back no sooner than the wait budget it just exhausted', () => {
  assert.match(PACE_RETRY_AFTER_SECONDS, /^\d+$/, 'retry-after is whole seconds');
  assert.ok(Number(PACE_RETRY_AFTER_SECONDS) * 1000 >= DEFAULT_MAX_WAIT_MS,
    `${PACE_RETRY_AFTER_SECONDS}s does not cover a ${DEFAULT_MAX_WAIT_MS}ms window`);
});
```

- [ ] **Step 2: El test de router cambia**

En `worker/report-api.test.js`, el test `refuses a Semantic Scholar search itself when no second is free, without spending the provider` sustituye `assert.equal(response.headers.get('retry-after'), '2');` por:

```js
  // Not a literal: the same constant the beat derives from its own wait budget,
  // so raising the budget cannot leave this header quietly lying.
  assert.equal(response.headers.get('retry-after'), PACE_RETRY_AFTER_SECONDS);
```

y el fichero importa `PACE_RETRY_AFTER_SECONDS` desde `./upstream-pace.js` junto a los imports de cabecera.

- [ ] **Step 3: Verlos fallar**

Run: `node --test worker/upstream-pace.test.js worker/report-api.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: fallo de importación (`PACE_RETRY_AFTER_SECONDS` no exportada) en los dos ficheros.

- [ ] **Step 4: Exportar y derivar**

En `worker/upstream-pace.js`, la línea 19 pasa a:

```js
export const DEFAULT_MAX_WAIT_MS = 2_500;
// What a caller refused here is told to wait, in whole seconds, derived from the
// window above rather than written next to it: the beat gave up because no
// second was free inside that window, so "come back" means "after it". Not the
// same number as the router's fallback for a *provider* refusal, which speaks
// for Semantic Scholar's own one-second window.
export const PACE_RETRY_AFTER_SECONDS = String(Math.ceil(DEFAULT_MAX_WAIT_MS / 1000));
```

En `worker/report-api.js`, el import de arriba pasa a `import { awaitUpstreamSlot, PACE_RETRY_AFTER_SECONDS } from './upstream-pace.js';` y en `awaitSharedPace` el bloque final queda:

```js
  // The beat's own window, not a literal next to a comment that promised it.
  return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    'retry-after': PACE_RETRY_AFTER_SECONDS,
  });
```

(El comentario «Two seconds, not a minute…» desaparece: ya no dice dos.)

- [ ] **Step 5: Verde**

Run: `node --test worker/upstream-pace.test.js worker/report-api.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 107`, `pass 107`, `fail 0` (5 + 1 en pace, 101 en router).

- [ ] **Step 6: Mutación, una por aserción**

(a) En `report-api.js`, volver a poner `'retry-after': '2'` literal → el test de router en rojo (`'2' !== '3'`). Restaurar. (b) En `upstream-pace.js`, cambiar la derivada por `export const PACE_RETRY_AFTER_SECONDS = '2';` → el test unitario en rojo (`2000 < 2500`); el de router sigue en verde, porque compara contra la constante — así se ve que hacen falta los dos. Restaurar.

- [ ] **Step 7: Commit**

```bash
git add worker/upstream-pace.js worker/upstream-pace.test.js worker/report-api.js worker/report-api.test.js
git commit -m "fix(worker): the beat's retry-after is derived from its wait budget, and covers it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Un rechazo del compás devuelve el asiento de minuto, y el techo se resuelve una vez

**Files:**
- Modify: `worker/report-api.js` — `reserveSharedMinuteQuota` (~426), `awaitSharedPace` (~457), `cacheResponse` (~480), y el `import` de `request-quota-ledger.js` (:52)
- Test: `worker/report-api.test.js`

**Interfaces:**
- Consumes: `releaseRequestQuota(namespace, { periodKey, subject, subjectLimit, globalLimit })` de `worker/request-quota-ledger.js` (ya existe, ya se usa en `ai-explanation.js:1408`); `PACE_RETRY_AFTER_SECONDS` de Task 5.
- Produces: `reserveSharedMinuteQuota(ceiling, env, origin)` → `{ error: Response } | { reservation: LedgerRequest }`; `awaitSharedPace(ceiling, env, origin, minuteReservation)` → `Response | null`. **Cambian de firma**: verificar con `grep -n "reserveSharedMinuteQuota\|awaitSharedPace" worker/` que `cacheResponse` es su único llamador antes de tocar nada.

**Por qué.** Las puertas de `cacheResponse` van minuto → identidad → compás, y el compás va último a propósito (es la única que cuesta tiempo de reloj). El precio de ese orden: cuando el compás rechaza, el asiento de minuto ya está gastado y nada lo devuelve. Una ráfaga de sesenta gasta sesenta asientos para ~3 respuestas, y a ~56 clientes les llega un `retry-after` corto cuya reintento se estrella contra el techo de minuto con `retry-after: 60`. La magnitud no cambió con el plan anterior (antes del compás la ráfaga también gastaba los sesenta); lo que cambió es que ahora el consejo es contradictorio. `releaseRequestQuota` existe y su patrón está en `releaseAIQuota`: **devolver el mismo asiento que se reservó**, con el mismo `periodKey`, porque recalcular el minuto al devolver acreditaría el minuto siguiente si la petición cruzó la frontera. Para eso la reserva tiene que viajar como valor.

De paso, `awaitSharedPace` deja de repetir `SHARED_MINUTE_CEILINGS[new URL(request.url).pathname]`: `cacheResponse` resuelve el techo una vez y se lo pasa a las dos puertas.

**Alcance declarado:** solo el asiento de minuto compartido. La reserva de identidad de `/related` (`reserveProtectedProviderQuota`) también se pierde en un rechazo del compás, pero tiene otra forma (sujeto por usuario más global) y nadie la ha señalado; queda como observación al final de esta tarea, no como trabajo.

- [ ] **Step 1: Los tests**

En `worker/report-api.test.js`, junto a `paceRefusingLedger`, añadir un ledger que además registre cada acción con su clave de periodo, leyendo la acción del path de la URL (`/quota/reserve` o `/quota/release`, que es como `callRequestQuotaLedger` la envía):

```js
// Like `paceRefusingLedger`, but it also remembers every action with the period
// key it was aimed at, so a test can see a release land on exactly the minute
// the reserve took -- and not on a minute recomputed later.
function actionRecordingLedger(state) {
  let lastName = '';
  return {
    idFromName: name => {
      lastName = String(name);
      return `quota-${lastName}`;
    },
    get: () => ({
      fetch: async (url, options) => {
        const action = String(url).split('/').pop();
        const body = JSON.parse(options.body);
        state.actions.push({ action, periodKey: lastName, subjectKey: body.subjectKey });
        if (action === 'release') return new Response(JSON.stringify({ released: true }));
        return new Response(JSON.stringify(
          lastName.endsWith(':pace') ? { accepted: false, scope: 'user' } : { accepted: true },
        ));
      },
    }),
  };
}

test('gives the minute back when the beat refuses, to the same minute it was taken from', async () => {
  const state = { actions: [] };
  const response = await withWorkerFetchMock(
    async () => new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: actionRecordingLedger(state) }),
  );

  assert.equal(response.status, 429);
  const minuteReserve = state.actions.find(a => a.action === 'reserve' && !a.periodKey.endsWith(':pace'));
  const releases = state.actions.filter(a => a.action === 'release');
  assert.ok(minuteReserve, `no minute reservation seen: ${JSON.stringify(state.actions)}`);
  assert.equal(releases.length, 1, `expected exactly one release, saw ${JSON.stringify(releases)}`);
  // The refund has to name the minute the reserve named, and the same subject:
  // a minute recomputed at release time credits the next one when the request
  // straddled the boundary, and a different subject credits somebody else.
  assert.equal(releases[0].periodKey, minuteReserve.periodKey);
  assert.equal(releases[0].subjectKey, minuteReserve.subjectKey);
});
```

Y en el test existente `charges /related and /sources/s2 to the same Semantic Scholar ceiling` (que usa `countingQuotaLedger`, acepta todo y por tanto el compás acepta), **añadir** al final:

```js
  // Both requests went through: nothing was refused, so nothing is given back.
  // A release on the accepted path would mint a minute unit out of nothing.
  assert.equal(state.releases ?? 0, 0);
```

y a `countingQuotaLedger` (~línea 1530) añadirle el contador, dentro de `fetch`, antes del `return`:

```js
        if (String(arguments[0]).endsWith('/release')) state.releases = (state.releases ?? 0) + 1;
```

(`fetch` es `async () => {…}` sin parámetros nombrados; darle `(url)` y usar `String(url)` es más limpio que `arguments` — hacerlo así.)

- [ ] **Step 2: Verlos fallar**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 1` — el test nuevo, con `releases.length` = `0`. El de la ceiling compartida sigue en verde (no hay releases todavía, que es lo que afirma).

- [ ] **Step 3: El import**

`worker/report-api.js:52` pasa a:

```js
import { releaseRequestQuota, reserveRequestQuota } from './request-quota-ledger.js';
```

- [ ] **Step 4: `reserveSharedMinuteQuota` devuelve lo que reservó**

Sustituir la función entera (desde su comentario de cabecera) por:

```js
// The sibling of `reserveProtectedProviderQuota` for routes with no identity to
// charge, and the sibling of `reserveOpenAlexBudget` for providers that bill in
// requests rather than in money. It stays separate from that one because the
// budgets are different in kind: OpenAlex needs a daily ceiling because the
// allowance is a daily sum of dollars, while NCBI and Semantic Scholar publish a
// rate -- requests per second -- which a per-minute ceiling is the direct
// expression of, and a daily one would not bound at all.
//
// Returns the ledger request it reserved with, not just a verdict, because the
// beat behind it may refuse the caller after this unit is spent and has to give
// back *this* unit: the same minute, the same subject. Recomputing the minute at
// release time credits the next one whenever the request straddled the boundary.
async function reserveSharedMinuteQuota(ceiling, env, origin) {
  const minute = new Date().toISOString().slice(0, 16);
  const limit = boundedLimit(env[ceiling.variable], ceiling.fallback, 100_000);
  const ledgerRequest = {
    periodKey: `${ceiling.namespace}:${minute}`,
    subject: `${ceiling.namespace}:shared`,
    subjectLimit: limit,
    globalLimit: limit,
  };
  const reservation = await reserveRequestQuota(env.REQUEST_QUOTA_LEDGER, ledgerRequest);
  if (!reservation.accepted && reservation.code) {
    return { error: json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    }) };
  }
  if (!reservation.accepted) {
    return { error: json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
      'retry-after': '60',
    }) };
  }
  return { reservation: ledgerRequest };
}
```

- [ ] **Step 5: `awaitSharedPace` devuelve el asiento al rechazar**

Sustituir la función entera (desde su comentario) por:

```js
// The beat under the ceiling, for the providers that count per second. It runs
// last of the three gates because it is the only one that costs wall-clock: a
// caller the minute ceiling or the identity quota is about to turn away must not
// first take a second away from somebody who would have used it.
//
// The price of running last is that the minute unit is already spent when this
// refuses, so the refusal gives it back -- the exact unit, via the request the
// reserve was made with. Same shape as `releaseAIQuota`: a refund that cannot be
// delivered must not replace the answer the caller is owed.
async function awaitSharedPace(ceiling, env, origin, minuteReservation) {
  if (!ceiling?.paced) return null;
  const slot = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, { namespace: ceiling.namespace });
  if (slot.accepted) return null;
  if (slot.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  try {
    await releaseRequestQuota(env.REQUEST_QUOTA_LEDGER, minuteReservation);
  } catch {
    // The caller is owed a 429 either way; a failed refund is a leak, not an error.
  }
  // The beat's own window, not a literal next to a comment that promised it.
  return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    'retry-after': PACE_RETRY_AFTER_SECONDS,
  });
}
```

- [ ] **Step 6: `cacheResponse` resuelve el techo una vez**

Sustituir las tres líneas de las puertas de minuto y compás por:

```js
  // Resolved once here and handed to both gates: the beat used to re-parse the
  // URL to find the same ceiling the minute reservation had just looked up.
  const ceiling = SHARED_MINUTE_CEILINGS[new URL(request.url).pathname];
  const minute = ceiling ? await reserveSharedMinuteQuota(ceiling, env, origin) : {};
  if (minute.error) return minute.error;
  const quotaError = await reserveProtectedProviderQuota(options.identity || null, env, origin);
  if (quotaError) return quotaError;
  const paceError = await awaitSharedPace(ceiling, env, origin, minute.reservation);
  if (paceError) return paceError;
```

(La rama `if (!ceiling) return null;` que tenía `reserveSharedMinuteQuota` ya no hace falta: la decide `cacheResponse`.)

- [ ] **Step 7: Todo en verde**

Run: `node --test worker/report-api.test.js worker/upstream-pace.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 108`, `pass 108`, `fail 0`.

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|cancelled)"`
Expected: `1965` en total, `fail 0`, `cancelled 0` (1962 + 1 de Task 3 + 1 de Task 5 + 1 de esta).

- [ ] **Step 8: Mutación, una por aserción**

(a) Quitar el bloque `try { await releaseRequestQuota(…) } catch {}` → el test nuevo en rojo (`releases.length` = `0`). Restaurar. (b) Mover ese mismo bloque **antes** de `if (slot.accepted) return null;` (devolver también en el camino aceptado) → `charges /related and /sources/s2…` en rojo (`releases` = `2`). Restaurar. (c) En el release, sustituir `minuteReservation` por un objeto reconstruido con `periodKey: \`${ceiling.namespace}:${new Date().toISOString().slice(0, 16)}\`` y el resto igual: en el test pasa (mismo minuto), y **eso es lo que hay que anotar en el informe** — la aserción de `periodKey` solo distingue un recálculo cuando la petición cruza la frontera del minuto, cosa que un test sin reloj inyectado no provoca. La protección real contra (c) es el comentario y el valor que viaja; queda dicho. Restaurar.

- [ ] **Step 9: Commit**

```bash
git add worker/report-api.js worker/report-api.test.js
git commit -m "fix(worker): a beat refusal gives the minute unit back, and the ceiling is resolved once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Observación para después, no para esta tarea:** en `/related`, un rechazo del compás también pierde la unidad de `reserveProtectedProviderQuota` (por usuario y global). Misma solución, otra forma de reserva. Si alguna vez se ve a un lector agotar sus 60 por minuto en `/related` por culpa de rechazos del compás, es esto.

---

### Task 7: Documentación

**Files:**
- Modify: `STATE.md` — la línea del límite ampliado (~:50-51) y una entrada nueva de cabecera
- Modify: `worker/README.md` — el párrafo del compás, donde diga `retry-after: 2`

**Interfaces:** ninguna.

- [ ] **Step 1: `@mugar` vuelve a la línea del límite**

En `STATE.md`, la frase `Pendiente también, y sin relación con este código: la solicitud a Semantic Scholar de un límite mayor que 1 RPS.` pasa a:

```
Pendiente también de @mugar, y sin relación con este código: la solicitud a
Semantic Scholar de un límite mayor que 1 RPS.
```

- [ ] **Step 2: El README dice la cabecera nueva**

En `worker/README.md`, en el párrafo que describe el compás, donde diga que un rechazo local lleva `retry-after: 2`, sustituir por `retry-after: 3` y añadir la frase: `Derived from the beat's own 2.5 s wait budget rather than written beside it, so the two cannot drift apart; the router's separate fallback of 2 s for a refusal Semantic Scholar itself sends speaks for the provider's one-second window and stays as it is.` Comprobar antes con `grep -n "retry-after" worker/README.md` cuál es la frase exacta.

- [ ] **Step 3: La entrada de `STATE.md`**

Encima de la entrada `## Semantic Scholar sobrevive a su segundo (2026-09-03)`:

```markdown
## Deuda diferida de Semantic Scholar, cerrada (2026-09-0X)

**Los diez hallazgos que las revisiones del endurecimiento dejaron diferidos,
cerrados en siete tareas — plan en
`docs/superpowers/plans/2026-09-03-semantic-scholar-deuda-diferida.md`.** Lo
que cambia de verdad: un rechazo del compás **devuelve el asiento de minuto**
que ya había gastado (el mismo asiento, no uno recalculado), así que una ráfaga
ya no gasta sesenta unidades para tres respuestas ni da consejos contradictorios;
y la cabecera `retry-after` del compás pasa de `2` a **`3`**, derivada de su
ventana de 2,5 s en vez de inventada al lado. El resto son tests que ahora
mueren donde antes callaban: el del presupuesto del cliente **falla en vez de
colgar la suite** si alguien alarga los 11 s; el recomendador tiene que
reenviar *el* paper (un mutante que reconstruía sus identificadores pasaba toda
la suite y rompía el autofiltrado); el feed a 20 y la hoja a 8 comparten
petición en el mismo tick; y el cuelgue de `/related` no relaya un estado que
no tiene. Sigue abierto: **S6** (la caché partida por origen), la unidad de
identidad de `/related` que un rechazo del compás también pierde (observado,
no arreglado), y la solicitud del límite a Semantic Scholar.
```

Sustituir `0X` por el día real. Si se despliega, el Worker antes que el frontend.

- [ ] **Step 4: Suite completa y commit**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|cancelled)"`
Expected: `1965`, `fail 0`, `cancelled 0`.

```bash
git add STATE.md worker/README.md
git commit -m "docs(s2): the deferred debt, closed, and the header it changed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Auto-revisión

**Cobertura.** Los diez hallazgos diferidos → tareas: test que cuelga (1), mutante del paper reenviado (2), dos `limit` en un tick (3), `import` a mitad de fichero (3), `upstreamStatus` en el cuelgue de `/related` (4), `retry-after` literal desacoplado (5), asiento de minuto no devuelto (6), `new URL()` de más (6), atribución `@mugar` (7). El guardia `IN_FLIGHT.get(paperId) === request` **no está** porque la revisión final lo declaró correcto y alcanzable; no se toca.

**Consistencia.** `PACE_RETRY_AFTER_SECONDS` se define en Task 5 y se consume en Task 6 (mismo nombre, mismo import). `reserveSharedMinuteQuota(ceiling, env, origin)` y `awaitSharedPace(ceiling, env, origin, minuteReservation)` se definen y se llaman en Task 6 con esas firmas exactas. `actionRecordingLedger` lee la acción del path porque `callRequestQuotaLedger` la pone en `https://papertok.internal/quota/${action}` — verificado en `request-quota-ledger.js:139`.

**Recuentos.** Baseline 1962. Task 3 +1 → 1963. Task 5 +1 → 1964. Task 6 +1 → 1965. Las demás reescriben sin añadir. En `report-api.test.js`: 101 → 101 (Task 4) → 101 (Task 5, cambia una aserción) → 102 (Task 6). En `upstream-pace.test.js`: 5 → 6 (Task 5). Si un recuento no cuadra, comprobar que no se ha añadido un test de más antes de buscar un fallo.

**Lo que este plan no promete.** Que el compás dé «tres de tres» en producción: eso se mide en frío, sin sondas, y no es código. Que S6 se cierre: es otro plan.
