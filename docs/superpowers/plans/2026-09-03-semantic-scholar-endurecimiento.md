# Endurecimiento de Semantic Scholar — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que las dos rutas de Semantic Scholar sobrevivan a su límite real —una petición por segundo para toda la aplicación— sin que un lector vea la fuente muerta ni espere por nada.

**Architecture:** El Worker gana un compás de segundo debajo del techo por minuto (una reserva por segundo en el ledger que ya existe, y esperar al siguiente en vez de rechazar), y `/related` pasa a relayar los fallos del proveedor con el mismo mapeo que las rutas `/sources/*`. El navegador deja de pedir dos veces lo mismo: una sola clave de caché por paper (siempre 20 recomendaciones arriba, recorte abajo) y deduplicación de peticiones en vuelo. Todo cambio lleva un test que muere por mutación.

**Tech Stack:** Cloudflare Worker (`worker/report-api.js`, Durable Object `RequestQuotaLedger`), React 19 + Vite en `src/`, `node --test` para ambos.

**Spec:** `docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md` (hallazgos S1–S10; este plan cubre S1–S5 y S7–S10; **S6 queda fuera a propósito**, ver abajo).

## Global Constraints

- Comentarios de código, mensajes de commit y documentación técnica **en inglés** (`AGENTS.md`); prosa de `STATE.md` en español.
- Semantic Scholar: **1 petición por segundo** por clave, sin `retry-after` en sus 429, y cuelga la conexión bajo presión sostenida (medido 03-09-2026).
- `S2_GLOBAL_MINUTE_LIMIT = 60` se queda como está: el compás de segundo va *debajo* del techo, no lo sustituye.
- Ningún cambio toca el contrato de `RequestQuotaLedger` (`worker/request-quota-ledger.js`): el compás usa la acción `reserve` que ya existe, con un `periodKey` fijo y un `subject` por segundo.
- Cada test nuevo se comprueba **por mutación**: se revierte el arreglo, se ejecuta el test, tiene que estar en rojo, y se restaura. Convención de `ce139ce`.
- Tests del Worker: `node --test worker/report-api.test.js` (95 en verde al empezar). Tests del navegador: `node --test src/services/<fichero>.test.js`. Suite completa: `npm test`. Lint: `npm run lint`.
- Si el trabajo se hace en un worktree, **copiar `.env` a mano** al worktree antes de correr los tests del Worker: sin él un test se cuelga para siempre en vez de fallar.
- No sondear Semantic Scholar en producción durante el trabajo: cada sonda gasta el segundo que un lector necesita. La verificación en vivo se hace una vez, al final, con seis consultas espaciadas 3 s.
- **Fuera de código y en paralelo desde el día 1:** pedir a Semantic Scholar la ampliación del límite con las cifras de la auditoría (§2.2). Tarda días y es lo único que compra más de un segundo.
- **S6 (caché partida por origen) queda fuera:** afecta a todas las rutas de `cacheResponse`, no solo a S2, y `www` redirige al apex desde el 01-09, así que hoy el reparto real es pequeño. Va en su propio plan si se decide hacer.

---

## Mapa de ficheros

| Fichero | Responsabilidad en este plan |
|---|---|
| `worker/upstream-pace.js` *(nuevo)* | `awaitUpstreamSlot`: el compás de segundo, puro, con reloj y `sleep` inyectables |
| `worker/upstream-pace.test.js` *(nuevo)* | tests unitarios del compás con ledger y reloj falsos |
| `worker/report-api.js` | `/related` relaya como las fuentes; fallback de `retry-after` por proveedor; el compás enganchado en `cacheResponse`; `/related` con clave por paper |
| `worker/report-api.test.js` | tests de router para cada cambio del Worker |
| `src/services/relatedPapersService.js` | una clave de caché por paper, recorte local, deduplicación en vuelo, seam de test |
| `src/services/relatedPapersService.test.js` | tests de caché y deduplicación |
| `src/services/semanticScholarService.js` | recomendaciones por paper (DOI o arXiv), no solo por `arxivId` |
| `src/services/semanticScholarService.test.js` | tests actualizados |
| `src/context/FeedContext.jsx:611` | pasa el paper entero |
| `src/components/Feed/RelatedPapersSheet.jsx:249-280` | un solo efecto pide relacionados |
| `src/services/adapters/SemanticScholarAdapter.js:16` | `OR`/`AND` solo como palabras |
| `src/services/SemanticScholarAdapter.test.js` | test del recorte |
| `worker/README.md`, `STATE.md` | documentación del régimen nuevo |

---

### Task 1: `/related` relaya el rechazo como las fuentes, y el `retry-after` inventado deja de ser un minuto (S2 + S7)

**Files:**
- Modify: `worker/report-api.js` — `handleRelated` (~430-455), el `catch` de `/related` en el router (~2362-2367), el `catch` de `DOMAIN_SOURCE_HANDLERS` (~2395-2422), y una constante nueva junto a `SHARED_MINUTE_CEILINGS` (~200)
- Test: `worker/report-api.test.js`

**Interfaces:**
- Consumes: `fetchJsonUpstream(url, headers)` (ya existe, `report-api.js:950`; lanza un `Error` con `.status` y `.retryAfter`), `json()`, `corsHeaders()`, `withWorkerFetchMock`, `withCachedIdentity`, `AUTHENTICATED_ENV`, `OPEN_ROUTE_ENV` (todos en el test).
- Produces: `upstreamFailureResponse(pathname, error, origin, env, label)` → `Response`; `upstreamRetryAfter(pathname, error)` → `string`. Task 2 no los usa; Task 3 sí reutiliza el `handleRelated` reescrito aquí.

- [ ] **Step 1: Escribir los tres tests que fallan**

Añadir al final del bloque de Semantic Scholar en `worker/report-api.test.js` (después del test `lets /related ask for the twenty recommendations the feed seeds from`, ~línea 1917):

```js
// Semantic Scholar's 429 reached the browser from `/sources/s2` as a 429 with a
// code and from `/related` as `502 Related papers unavailable` -- the one shape a
// client retries at once. Both routes spend the same key; they relay the same way.
test('/related relays a Semantic Scholar refusal with its code, its status and a short wait', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=20',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV)),
  );

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(body.upstreamStatus, 429);
  // Semantic Scholar names no wait and its window is one second: a minute here
  // is fifty-nine seconds of a reader waiting for a slot that opened long ago.
  assert.equal(response.headers.get('retry-after'), '2');
});

test('/related names a stalled Semantic Scholar instead of dressing it as a generic failure', async () => {
  const response = await withWorkerFetchMock(
    async () => { throw new DOMException('aborted due to timeout', 'TimeoutError'); },
    () => withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=20',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV)),
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'Related papers unavailable');
  assert.equal(body.code, 'UPSTREAM_TIMEOUT');
});

test('tells a client refused by Semantic Scholar search to wait a second, not a minute', async () => {
  const response = await withWorkerFetchMock(
    async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), OPEN_ROUTE_ENV),
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '2');
});
```

El test existente `falls back to a minute when the upstream refused without saying for how long` (PubMed, `retry-after: 60`) **se queda como está**: para NCBI el minuto sigue siendo la respuesta.

- [ ] **Step 2: Ejecutar y ver los tres en rojo**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^(✖|ℹ (pass|fail))"`
Expected: `fail 3` — el primero con `502 !== 429`, el segundo con `undefined !== 'UPSTREAM_TIMEOUT'`, el tercero con `'60' !== '2'`.

- [ ] **Step 3: La constante y las dos funciones nuevas**

En `worker/report-api.js`, justo después de `SHARED_MINUTE_CEILINGS` (~línea 204):

```js
// What the router tells a client to wait when the upstream refused without
// saying for how long. Semantic Scholar's 429 carries no `retry-after` (measured
// 2026-09-03) and its window is one second: the introductory key admits one
// request per second and refuses the rest of that second at once, so a minute
// is fifty-nine seconds of a reader waiting for a slot that opened long ago. A
// minute stays the answer everywhere else, where the window really is a minute.
const UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS = Object.freeze({
  '/sources/s2': '2',
  '/related': '2',
});
const DEFAULT_UPSTREAM_RETRY_AFTER_SECONDS = '60';

function upstreamRetryAfter(pathname, error) {
  return error?.retryAfter
    || UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS[pathname]
    || DEFAULT_UPSTREAM_RETRY_AFTER_SECONDS;
}

// One mapping for every route that spends a provider. `/sources/*` had it and
// `/related` did not, so the same Semantic Scholar 429 reached the browser from
// one route as `429 UPSTREAM_RATE_LIMITED retry-after` and from the other as
// `502 Related papers unavailable` -- the one shape a client retries at once,
// which is the one thing that makes a rate limit worse.
function upstreamFailureResponse(pathname, error, origin, env, label) {
  const isScopus = pathname === '/sources/scopus';
  const rateLimited = error?.status === 429;
  // `AbortSignal.timeout` rejects with a `TimeoutError`, and a stall has no
  // status to relay -- so it gets a name instead of the generic 502 body.
  const timedOut = error?.name === 'TimeoutError';
  const status = rateLimited ? 429 : 502;
  return json({
    error: label,
    ...(rateLimited ? { code: 'UPSTREAM_RATE_LIMITED' } : {}),
    ...(timedOut ? { code: 'UPSTREAM_TIMEOUT' } : {}),
    // For every route, not only Scopus: a 400 we caused and an outage they had
    // both used to leave here as the same 502, and the number that told them
    // apart stayed in `wrangler tail` -- which is how the OpenReview `tcdate`
    // bug went unseen for weeks.
    ...(error?.status ? { upstreamStatus: error.status } : {}),
    ...(isScopus && error?.resetAt ? { resetAt: error.resetAt } : {}),
  }, status, {
    ...corsHeaders(origin, env),
    ...(rateLimited ? { 'retry-after': upstreamRetryAfter(pathname, error) } : {}),
  });
}
```

- [ ] **Step 4: `handleRelated` pasa por `fetchJsonUpstream`**

Sustituir el `fetcher` de `handleRelated` (las cinco líneas desde `const headers = { accept: 'application/json' };` hasta `return response.json();`):

```js
  return cacheResponse(request, origin, env, RELATED_CACHE_SECONDS, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${limit}`;
    // Through the source helper, not a bare `fetchWithDeadline`: this used to
    // throw a plain Error with the status in its message and nothing on the
    // error itself, which is why the router could only ever answer 502. Six
    // seconds rather than eight, too -- the browser gives this route eight, and
    // an answer that lands as the client leaves is cached for nobody.
    return fetchJsonUpstream(url, env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {});
  }, { identity, canonicalParams: { paper_id: paperId, limit: String(limit) } });
```

`fetchJsonUpstream` está declarado más abajo en el fichero (~950) como `function`; se iza, no hace falta moverlo.

- [ ] **Step 5: Los dos `catch` del router usan el helper**

El de `/related`:

```js
    if (url.pathname === '/related') {
      try {
        return await handleRelated(request, env, protectedIdentity);
      } catch (error) {
        console.error('Related papers failed', error);
        return upstreamFailureResponse('/related', error, origin, env, 'Related papers unavailable');
      }
    }
```

El de `DOMAIN_SOURCE_HANDLERS` queda reducido a:

```js
    if (DOMAIN_SOURCE_HANDLERS[url.pathname]) {
      try {
        return await DOMAIN_SOURCE_HANDLERS[url.pathname](request, env, protectedIdentity);
      } catch (error) {
        console.error(`Specialist source failed: ${url.pathname}`, error);
        const label = url.pathname === '/sources/scopus' ? 'Scopus unavailable' : 'Specialist source unavailable';
        return upstreamFailureResponse(url.pathname, error, origin, env, label);
      }
    }
```

Los comentarios que había dentro del `catch` viejo (el de «A refusal relayed as a 502 reads as…» y el de OpenReview `tcdate`) ya viven en `upstreamFailureResponse`; no duplicarlos.

- [ ] **Step 6: Todo en verde**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 98`, `pass 98`, `fail 0`.

- [ ] **Step 7: Mutación**

Revertir solo el `catch` de `/related` a `return json({ error: 'Related papers unavailable' }, 502, corsHeaders(origin, env));`, correr el fichero, comprobar que el primer y el segundo test nuevos están en rojo, y restaurar. Después revertir solo el `fetcher` a la versión con `fetchWithDeadline` + `throw new Error(...)`, correr, comprobar que el primero está en rojo (`502 !== 429`: el error no lleva `status`), y restaurar.

- [ ] **Step 8: Commit**

```bash
git add worker/report-api.js worker/report-api.test.js
git commit -m "fix(worker): /related relays a refusal the way the sources do, and a Semantic Scholar wait is a second

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: El compás de segundo debajo del techo por minuto (S1, y S3 cae con él)

**Files:**
- Create: `worker/upstream-pace.js`
- Create: `worker/upstream-pace.test.js`
- Modify: `worker/report-api.js` — `SHARED_MINUTE_CEILINGS` (~200), `cacheResponse` (~404), una función nueva junto a `reserveSharedMinuteQuota` (~373), un `import` arriba
- Test: `worker/report-api.test.js` — un test existente cambia, dos nuevos

**Interfaces:**
- Consumes: `reserveRequestQuota(namespace, { periodKey, subject, subjectLimit, globalLimit })` de `worker/request-quota-ledger.js` → `{ accepted: boolean, code?: string }`.
- Produces: `awaitUpstreamSlot(ledger, { namespace, maxWaitMs?, now?, sleep? })` → `Promise<{ accepted: true, second: number, waitedMs: number } | { accepted: false, code?: string }>`; entradas de `SHARED_MINUTE_CEILINGS` con `paced: true`.

- [ ] **Step 1: Los tests unitarios del compás**

Crear `worker/upstream-pace.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitUpstreamSlot } from './upstream-pace.js';

// A ledger that answers each `reserve` from a script, and remembers what it was
// asked. Subjects reach the real ledger hashed, so the fake records the order
// of calls rather than their names; the period key is visible as-is.
function scriptedLedger(answers, seen) {
  let call = 0;
  return {
    idFromName: name => { seen.periodKeys.push(String(name)); return `quota-${name}`; },
    get: () => ({
      fetch: async () => {
        const answer = answers[Math.min(call, answers.length - 1)];
        call += 1;
        seen.calls = call;
        return new Response(JSON.stringify(answer));
      },
    }),
  };
}

// The clock is pinned at the start of second 10, so the first slot asked for is
// second 10 itself, the next is 11, and the wait for 11 is exactly a second.
const AT_SECOND_TEN = () => 10_000;

test('sends at once when the current second is free', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(scriptedLedger([{ accepted: true }], seen), {
    namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); },
  });

  assert.deepEqual(slot, { accepted: true, second: 10, waitedMs: 0 });
  assert.deepEqual(slept, []);
  assert.deepEqual(seen.periodKeys, ['s2:pace']);
});

test('takes the next second and waits for it when the current one is taken', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }, { accepted: true }], seen),
    { namespace: 's2', now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, second: 11, waitedMs: 1000 });
  assert.deepEqual(slept, [1000]);
  assert.equal(seen.calls, 2);
});

test('gives up within the wait budget instead of queueing forever', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }], seen),
    { namespace: 's2', maxWaitMs: 2_500, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: false });
  // Seconds 10, 11 and 12 are within 2.5 s of the start; 13 is not.
  assert.equal(seen.calls, 3);
  assert.deepEqual(slept, [], 'a refusal must not cost the caller any waiting');
});

test('relays a ledger that is not there instead of treating it as a full second', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' }], seen),
    { namespace: 's2', now: AT_SECOND_TEN, sleep: async () => {} },
  );

  assert.deepEqual(slot, { accepted: false, code: 'QUOTA_LEDGER_UNAVAILABLE' });
  assert.equal(seen.calls, 1);
});
```

- [ ] **Step 2: Verlos fallar**

Run: `node --test worker/upstream-pace.test.js 2>&1 | tail -5`
Expected: fallo de carga del módulo (`Cannot find module './upstream-pace.js'`).

- [ ] **Step 3: El compás**

Crear `worker/upstream-pace.js`:

```js
import { reserveRequestQuota } from './request-quota-ledger.js';

// Semantic Scholar admits one request per second per key and refuses the rest
// of that second at once (measured 2026-09-03: five in parallel, one 200; the
// next single request a second later, 200). The per-minute ceiling is the same
// average and no protection at all against that: sixty reservations fit in one
// second, each one spent, one answered.
//
// This is the beat the ceiling lacks. A second is a *subject* in one long-lived
// ledger object (`<namespace>:pace`) with a limit of one, so the reservation is
// the slot: the first caller to take second N sends in second N, the next one
// takes N+1 and waits for it, and a caller that finds nothing free within
// `maxWaitMs` is refused here rather than upstream -- same 429, no provider
// call spent, no minute reservation wasted on a request the provider would
// have refused anyway. The retention alarm of the ledger clears the used
// seconds every three days; at one a second that is under 260k entries, well
// inside the object's global counter.
const DEFAULT_MAX_WAIT_MS = 2_500;
const PACE_GLOBAL_LIMIT = 1_000_000;

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function awaitUpstreamSlot(ledger, {
  namespace,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  const started = now();
  for (let second = Math.floor(started / 1000); second * 1000 - started <= maxWaitMs; second += 1) {
    const reservation = await reserveRequestQuota(ledger, {
      periodKey: `${namespace}:pace`,
      subject: `${namespace}:second:${second}`,
      subjectLimit: 1,
      globalLimit: PACE_GLOBAL_LIMIT,
    });
    if (!reservation.accepted && reservation.code) return { accepted: false, code: reservation.code };
    if (!reservation.accepted) continue;
    const waitMs = Math.max(0, second * 1000 - now());
    if (waitMs > 0) await sleep(waitMs);
    return { accepted: true, second, waitedMs: waitMs };
  }
  return { accepted: false };
}
```

- [ ] **Step 4: Los cuatro en verde**

Run: `node --test worker/upstream-pace.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: Los tests de router**

En `worker/report-api.test.js`, **cambiar** el test existente `charges /related and /sources/s2 to the same Semantic Scholar ceiling` (~1873): la aserción final pasa de contar todas las claves `s2:` a contar solo las de minuto, porque ahora el compás añade `s2:pace`:

```js
  // One namespace, because both spend the same provider allowance. A limiter with
  // one counter per route is the per-tab limiter this replaced, wearing a hat.
  // The pace keys are the same namespace's beat, counted separately below.
  const minuteKeys = state.periodKeys.filter(key => key.startsWith('s2:') && !key.endsWith(':pace'));
  assert.equal(minuteKeys.length, 2, `expected both routes on the s2 ceiling, saw ${JSON.stringify(state.periodKeys)}`);
  const paceKeys = state.periodKeys.filter(key => key === 's2:pace');
  assert.equal(paceKeys.length, 2, 'both routes have to keep the same beat');
```

Y **añadir** después del test `tells a client refused by Semantic Scholar search to wait a second, not a minute` (Task 1):

```js
// The ledger accepts the minute and refuses every second: what the route must do
// then is answer 429 itself, with the short wait, and never call the provider.
function paceRefusingLedger(state) {
  let lastName = '';
  return {
    idFromName: name => {
      lastName = String(name);
      state.periodKeys.push(lastName);
      return `quota-${lastName}`;
    },
    get: () => ({
      fetch: async () => new Response(JSON.stringify(
        lastName.endsWith(':pace') ? { accepted: false, scope: 'user' } : { accepted: true },
      )),
    }),
  };
}

test('refuses a Semantic Scholar search itself when no second is free, without spending the provider', async () => {
  const state = { periodKeys: [] };
  let upstreamCalls = 0;
  const response = await withWorkerFetchMock(
    async () => { upstreamCalls += 1; return new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } }); },
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/s2?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: paceRefusingLedger(state) }),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(response.headers.get('retry-after'), '2');
  assert.equal(upstreamCalls, 0, 'a request the beat refused must not reach Semantic Scholar');
  assert.ok(state.periodKeys.includes('s2:pace'), `the beat was never consulted: ${JSON.stringify(state.periodKeys)}`);
});

test('does not put PubMed on the Semantic Scholar beat', async () => {
  const state = { periodKeys: [], reservations: 0 };
  await withWorkerFetchMock(
    async () => new Response(JSON.stringify({ esearchresult: { count: '0', idlist: [] } }), { headers: { 'content-type': 'application/json' } }),
    () => reportApi.fetch(new Request(
      'https://papertok-report-api.example/sources/pubmed?q=malaria',
      { headers: { origin: 'https://mugar123.github.io' } },
    ), { REQUEST_QUOTA_LEDGER: countingQuotaLedger(state) }),
  );

  assert.deepEqual(state.periodKeys.filter(key => key.endsWith(':pace')), [], 'NCBI counts ten a second and has its own retry; it needs no beat');
});
```

- [ ] **Step 6: Verlos fallar**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 2` — el test cambiado (`0 !== 2` claves `s2:pace`) y el de rechazo (`200 !== 429`). El de PubMed pasa ya (no hay compás en ninguna ruta todavía); es el que garantiza que el Step 7 no lo enchufa donde no toca.

- [ ] **Step 7: Enganchar el compás en el Worker**

En `worker/report-api.js`, junto a los otros imports de arriba:

```js
import { awaitUpstreamSlot } from './upstream-pace.js';
```

En `SHARED_MINUTE_CEILINGS`, las dos entradas de S2 ganan `paced: true` y el comentario que las precede gana un párrafo:

```js
// `/related` shares the `s2` namespace with `/sources/s2` on purpose. Both spend
// the same Semantic Scholar allowance, and a ceiling that only covered one of
// them would leave alive exactly the failure this replaces -- a limiter that
// counts per caller instead of per provider.
//
// `paced` puts a route on the one-a-second beat of `upstream-pace.js` under its
// minute ceiling. Semantic Scholar is the provider that needs it: it admits one
// request per second per key, and a per-minute ceiling of sixty is the same
// average with no say over which second. PubMed is not paced: the key buys ten
// a second and `withPubmedRetry` absorbs the burst.
const DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT = 60;
const DEFAULT_S2_GLOBAL_MINUTE_LIMIT = 60;
const SHARED_MINUTE_CEILINGS = Object.freeze({
  // (comentario existente de PubMed, sin cambios)
  '/sources/pubmed': { namespace: 'pubmed', variable: 'PUBMED_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_PUBMED_GLOBAL_MINUTE_LIMIT },
  '/sources/s2': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT, paced: true },
  '/related': { namespace: 's2', variable: 'S2_GLOBAL_MINUTE_LIMIT', fallback: DEFAULT_S2_GLOBAL_MINUTE_LIMIT, paced: true },
});
```

Justo después de `reserveSharedMinuteQuota` (~línea 400):

```js
// The beat under the ceiling, for the providers that count per second. The
// minute reservation comes first because it is the cheap refusal: a caller the
// minute already turned away must not also take a second from somebody else.
async function awaitSharedPace(request, env, origin) {
  const ceiling = SHARED_MINUTE_CEILINGS[new URL(request.url).pathname];
  if (!ceiling?.paced) return null;
  const slot = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, { namespace: ceiling.namespace });
  if (slot.accepted) return null;
  if (slot.code) {
    return json({ code: 'PROVIDER_QUOTA_NOT_CONFIGURED' }, 503, {
      ...corsHeaders(origin, env),
      'cache-control': 'no-store',
    });
  }
  // Two seconds, not a minute: the next free second is at most 2.5 s away and
  // the caller is being told to come back, not to give up.
  return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
    ...corsHeaders(origin, env),
    'cache-control': 'no-store',
    'retry-after': '2',
  });
}
```

En `cacheResponse`, entre la reserva de minuto y la de identidad:

```js
  const sharedQuotaError = await reserveSharedMinuteQuota(request, env, origin);
  if (sharedQuotaError) return sharedQuotaError;
  const paceError = await awaitSharedPace(request, env, origin);
  if (paceError) return paceError;
  const quotaError = await reserveProtectedProviderQuota(options.identity || null, env, origin);
```

- [ ] **Step 8: Todo en verde, en los dos ficheros**

Run: `node --test worker/report-api.test.js worker/upstream-pace.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tests 104`, `pass 104`, `fail 0`.

Si algún test antiguo de `/sources/s2` o `/related` se cuelga: sus ledgers falsos (`OPEN_ROUTE_ENV`, `AUTHENTICATED_ENV`) aceptan todo, así que el compás acepta el segundo actual con `waitMs = 0` y no duerme. Un cuelgue ahí significa que `now()` se está llamando con un reloj distinto del de `started`; revisar que `awaitUpstreamSlot` no ha cambiado.

- [ ] **Step 9: Mutación**

Quitar `paced: true` de las dos entradas, correr `report-api.test.js`: el test cambiado (`s2:pace` ×2) y el de rechazo tienen que estar en rojo. Restaurar. Cambiar `paced: true` a la entrada de PubMed: el test `does not put PubMed on the Semantic Scholar beat` en rojo. Restaurar.

- [ ] **Step 10: Commit**

```bash
git add worker/upstream-pace.js worker/upstream-pace.test.js worker/report-api.js worker/report-api.test.js
git commit -m "feat(worker): Semantic Scholar keeps a one-a-second beat under its minute ceiling

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Una clave de caché por paper: `/related` pide siempre veinte y el navegador recorta (S5)

**Files:**
- Modify: `worker/report-api.js` — `handleRelated` (~430-455)
- Modify: `src/services/relatedPapersService.js`
- Test: `worker/report-api.test.js` (un test existente cambia, uno nuevo), `src/services/relatedPapersService.test.js`

**Interfaces:**
- Consumes: el `handleRelated` de Task 1; `workerSourceUrl(path, params, apiBase)` y `authenticatedWorkerFetch(url, options)` de `workerApiClient.js`.
- Produces: `getRelatedPapers(paper, limit = 8, { fetchWorker = authenticatedWorkerFetch, apiBase } = {})` → `Promise<Paper[]>` (recortado a `limit`); `clearRelatedPapersCache()`. Task 4 y Task 6 usan esta firma.

- [ ] **Step 1: Los tests del Worker**

**Cambiar** el test `lets /related ask for the twenty recommendations the feed seeds from` (~1899): la petición pasa a pedir `limit=8` y la aserción se explica:

```js
test('asks Semantic Scholar for twenty whatever the client asked, so one paper is one entry', async () => {
  let upstreamUrl = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    upstreamUrl = String(url);
    return new Response(JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await withCachedIdentity(() => reportApi.fetch(new Request(
      'https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=8',
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV));
  } finally {
    globalThis.fetch = originalFetch;
  }

  // The feed seeds from twenty and the sheet shows eight. With `limit` in the key
  // those were two misses and two provider calls for one list of which the
  // second is a prefix of the first -- at one request a second, a refusal.
  assert.match(upstreamUrl, /limit=20/);
});
```

**Añadir** a continuación:

```js
test('serves the sheet and the feed the same /related entry for one paper', async () => {
  const stored = new Map();
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ recommendedPapers: [] }), { headers: { 'content-type': 'application/json' } });
  };
  globalThis.caches = {
    default: {
      match: async request => (String(request.url).includes('/auth/')
        ? new Response(JSON.stringify({ uid: 'user-1' }), { headers: { 'content-type': 'application/json' } })
        : stored.get(request.url)?.clone() || null),
      put: async (request, response) => stored.set(request.url, response.clone()),
    },
  };
  try {
    const ask = limit => reportApi.fetch(new Request(
      `https://papertok-report-api.example/related?paper_id=ARXIV:2607.12345&limit=${limit}`,
      { headers: { origin: 'https://mugar123.github.io', authorization: 'Bearer test-token' } },
    ), AUTHENTICATED_ENV);

    await ask(20);
    await ask(8);
    await ask(20);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }

  assert.equal(upstreamCalls, 1);
  assert.equal(stored.size, 1);
});
```

- [ ] **Step 2: Verlos fallar**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 2` — `limit=8` no casa con `/limit=20/`, y `upstreamCalls` es `2`.

- [ ] **Step 3: `handleRelated` sin `limit`**

En `worker/report-api.js`, sustituir desde el comentario `// Twenty, not the eight-of-ten…` hasta el final de `handleRelated`:

```js
  // Twenty, always. The feed seeds from twenty and the sheet shows eight; when
  // `limit` was part of the cache key those were two misses and two provider
  // calls for one list of which the second is a prefix of the first. The client
  // trims what it shows. `limit` is still accepted so an older bundle keeps
  // working; it just no longer changes the question.
  return cacheResponse(request, origin, env, RELATED_CACHE_SECONDS, async () => {
    const fields = 'paperId,title,abstract,authors,year,externalIds,url,venue,publicationDate,citationCount,isOpenAccess,openAccessPdf,publicationTypes';
    const url = `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(paperId)}?fields=${encodeURIComponent(fields)}&limit=${RELATED_UPSTREAM_LIMIT}`;
    // Through the source helper, not a bare `fetchWithDeadline`: this used to
    // throw a plain Error with the status in its message and nothing on the
    // error itself, which is why the router could only ever answer 502. Six
    // seconds rather than eight, too -- the browser gives this route eight, and
    // an answer that lands as the client leaves is cached for nobody.
    return fetchJsonUpstream(url, env.SEMANTIC_SCHOLAR_API_KEY ? { 'x-api-key': env.SEMANTIC_SCHOLAR_API_KEY } : {});
  }, { identity, canonicalParams: { paper_id: paperId } });
}
```

Y junto a `RELATED_CACHE_SECONDS` (~línea 77):

```js
const RELATED_UPSTREAM_LIMIT = 20;
```

La línea `const limit = getSafeLimit(requestUrl.searchParams.get('limit'), 8, 20);` desaparece.

- [ ] **Step 4: Worker en verde**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 101`, `fail 0`.

- [ ] **Step 5: El test del navegador**

Añadir a `src/services/relatedPapersService.test.js`:

```js
import { clearRelatedPapersCache, getRelatedPapers } from './relatedPapersService.js';

const WORKER = 'https://papertok-report-api.example';

function twentyRecommendations() {
  return new Response(JSON.stringify({
    recommendedPapers: Array.from({ length: 20 }, (_, index) => ({
      paperId: `s2-${index}`,
      title: `Paper ${index}`,
      externalIds: { ArXiv: `2601.${String(index).padStart(5, '0')}` },
      authors: [],
    })),
  }), { headers: { 'content-type': 'application/json' } });
}

test('asks the Worker once per paper and trims locally whatever limit each caller wants', async () => {
  clearRelatedPapersCache();
  const asked = [];
  const fetchWorker = async url => { asked.push(new URL(url)); return twentyRecommendations(); };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  const forFeed = await getRelatedPapers(paper, 20, { fetchWorker, apiBase: WORKER });
  const forSheet = await getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER });

  assert.equal(asked.length, 1, 'the sheet must be served from the feed\'s entry');
  // `limit` no longer travels: on the Worker it was a second cache key for the
  // same list, and at one request a second a second miss is a refusal.
  assert.equal(asked[0].searchParams.has('limit'), false);
  assert.equal(forFeed.length, 20);
  assert.equal(forSheet.length, 8);
  assert.deepEqual(forSheet, forFeed.slice(0, 8));
});
```

- [ ] **Step 6: Verlo fallar**

Run: `node --test src/services/relatedPapersService.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: falla en la importación (`clearRelatedPapersCache` no existe) o, si se añade solo el export, con `asked.length` = `2`.

- [ ] **Step 7: `relatedPapersService` con una entrada por paper**

Sustituir `getRelatedPapers` entera en `src/services/relatedPapersService.js` (y la constante `CACHE`):

```js
const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;
// The Worker always answers twenty (`RELATED_UPSTREAM_LIMIT` there); every
// caller trims from that one list rather than asking for its own size.
const RELATED_UPSTREAM_LIMIT = 20;

// (getSemanticScholarPaperId y mapRelatedPaper, sin cambios)

async function fetchRelatedFromWorker(paperId, paper, { fetchWorker, apiBase }) {
  // There used to be a direct `api.semanticscholar.org` branch here for when no
  // Worker origin was configured. It could not ship — `vite build` refuses a
  // bundle without `VITE_PAPER_API_BASE_URL` — and it was a keyless browser call
  // to an API that rate-limits per provider, which is the whole reason this route
  // exists. A failure is a failure: there is no second route to try.
  const url = workerSourceUrl('/related', { paper_id: paperId }, apiBase);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchWorker(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Semantic Scholar API error: ${response.status}`);
    const payload = await response.json();
    const items = payload.recommendedPapers || payload.papers || [];
    const currentIds = new Set([paper.id, paper.arxivId, paper.doi].filter(Boolean).map(value => String(value).toLowerCase()));
    return PaperBuilder.deduplicate(items.map(mapRelatedPaper).filter(item => {
      return ![item.id, item.arxivId, item.doi].filter(Boolean).some(value => currentIds.has(String(value).toLowerCase()));
    })).slice(0, RELATED_UPSTREAM_LIMIT);
  } finally {
    clearTimeout(timeout);
  }
}

// `fetchWorker` and `apiBase` are the same seam the adapters have: the real
// path needs a Firebase session and a configured Worker origin, neither of
// which exists under `node --test`. `apiBase` left undefined lets
// `workerSourceUrl` fall back to the configured origin.
export async function getRelatedPapers(paper, limit = 8, { fetchWorker = authenticatedWorkerFetch, apiBase } = {}) {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];
  const cached = CACHE.get(paperId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data.slice(0, limit);

  const related = await fetchRelatedFromWorker(paperId, paper, { fetchWorker, apiBase });
  CACHE.set(paperId, { data: related, timestamp: Date.now() });
  return related.slice(0, limit);
}

// Same escape hatch `semanticScholarService` exposes: a module-level cache that
// survives between tests makes the second one lie about what the first proved.
export function clearRelatedPapersCache() {
  CACHE.clear();
}
```

- [ ] **Step 8: Verde, y lint**

Run: `node --test src/services/relatedPapersService.test.js src/services/semanticScholarService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 5`, `fail 0` (el test antiguo de `getSemanticScholarPaperId` sigue; los tres de `semanticScholarService` siguen porque inyectan `fetchRelated`).

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 9: Mutación**

En el Worker: volver a poner `limit: String(limit)` en `canonicalParams` (con `const limit = 20`) → el test `serves the sheet and the feed…` sigue en verde (misma clave) pero **`stored.size` deja de ser el discriminante**; por eso el test anterior (`limit=8` → `limit=20`) es el que muere si se restaura `getSafeLimit`. Comprobar ese. En el navegador: volver a `CACHE.get(\`${paperId}:${limit}\`)` → `asked.length` = `2`, rojo. Restaurar los dos.

- [ ] **Step 10: Commit**

```bash
git add worker/report-api.js worker/report-api.test.js src/services/relatedPapersService.js src/services/relatedPapersService.test.js
git commit -m "perf(related): one paper is one cache entry, on the edge and in the browser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Dos peticiones concurrentes por el mismo paper son una (S4)

**Files:**
- Modify: `src/services/relatedPapersService.js` (el `getRelatedPapers` de Task 3)
- Modify: `src/components/Feed/RelatedPapersSheet.jsx:249-280`
- Test: `src/services/relatedPapersService.test.js`

**Interfaces:**
- Consumes: `getRelatedPapers(paper, limit, { fetchWorker, apiBase })` y `clearRelatedPapersCache()` de Task 3.
- Produces: la misma firma; `clearRelatedPapersCache()` vacía también las peticiones en vuelo.

- [ ] **Step 1: Los dos tests**

Añadir a `src/services/relatedPapersService.test.js`:

```js
test('shares one request between two callers that ask for the same paper at once', async () => {
  clearRelatedPapersCache();
  let calls = 0;
  const fetchWorker = async () => { calls += 1; return twentyRecommendations(); };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  // The sheet used to fire this twice on one mount for a paper without a DOI --
  // once from the "similar" tab, once from "no graph to draw" -- and the second
  // landed in the same second as the first. At one request a second that is a
  // refusal by construction, and the refusal could overwrite the answer.
  const [forSheet, forSheetAgain] = await Promise.all([
    getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }),
    getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }),
  ]);

  assert.equal(calls, 1);
  assert.deepEqual(forSheetAgain, forSheet);
});

test('does not remember a failed request as the paper\'s answer', async () => {
  clearRelatedPapersCache();
  let calls = 0;
  const fetchWorker = async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429 });
    return twentyRecommendations();
  };
  const paper = { id: 'arxiv:2607.12345', arxivId: '2607.12345' };

  await assert.rejects(() => getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER }), /429/);
  const related = await getRelatedPapers(paper, 8, { fetchWorker, apiBase: WORKER });

  assert.equal(calls, 2, 'the failure must not stay in flight, or in the cache');
  assert.equal(related.length, 8);
});
```

- [ ] **Step 2: Verlos fallar**

Run: `node --test src/services/relatedPapersService.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 1` — el primero, con `calls` = `2`. El segundo ya pasa (la caché solo se escribe tras resolver); se queda como guardia del Step 3.

- [ ] **Step 3: El mapa en vuelo**

En `src/services/relatedPapersService.js`, junto a `CACHE`:

```js
const CACHE = new Map();
// One promise per paper while it is being asked: the cache only fills once the
// answer is in, and two callers in the same tick used to be two Worker calls
// and two provider calls in the same second.
const IN_FLIGHT = new Map();
```

`getRelatedPapers` pasa a:

```js
export async function getRelatedPapers(paper, limit = 8, { fetchWorker = authenticatedWorkerFetch, apiBase } = {}) {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];
  const cached = CACHE.get(paperId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data.slice(0, limit);

  let request = IN_FLIGHT.get(paperId);
  if (!request) {
    request = fetchRelatedFromWorker(paperId, paper, { fetchWorker, apiBase })
      .then(related => {
        CACHE.set(paperId, { data: related, timestamp: Date.now() });
        return related;
      })
      .finally(() => {
        if (IN_FLIGHT.get(paperId) === request) IN_FLIGHT.delete(paperId);
      });
    IN_FLIGHT.set(paperId, request);
  }
  const related = await request;
  return related.slice(0, limit);
}

export function clearRelatedPapersCache() {
  CACHE.clear();
  IN_FLIGHT.clear();
}
```

- [ ] **Step 4: Verde**

Run: `node --test src/services/relatedPapersService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: La hoja pide una vez**

En `src/components/Feed/RelatedPapersSheet.jsx`, sustituir los dos `useEffect` de `getRelatedPapers` (líneas 249-280, el que empieza `if (mode !== 'similar' || relatedRequestedRef.current)` y el que empieza `if (hasGraphIdentifier) return undefined;`) por uno:

```jsx
  /**
   * Two effects used to ask for the related papers -- one for the "similar"
   * tab, one for a paper with no graph to draw -- and a paper without a DOI
   * starts on "similar" precisely because it has no graph, so both fired on
   * the same mount. The service now shares one request between them, but the
   * condition is one condition, and it reads better as one.
   */
  useEffect(() => {
    const wanted = mode === 'similar' || !hasGraphIdentifier;
    if (!wanted || relatedRequestedRef.current) return undefined;
    relatedRequestedRef.current = true;
    let cancelled = false;
    setRelatedStatus('loading');
    getRelatedPapers(paper).then(results => {
      if (cancelled) return;
      setPapers(results);
      setRelatedStatus(results.length ? 'ready' : 'empty');
    }).catch(error => {
      if (cancelled) return;
      console.error('No se pudieron cargar papers relacionados', error);
      setRelatedStatus('error');
    });
    return () => { cancelled = true; };
  }, [mode, hasGraphIdentifier, paper]);
```

Comprobar que `relatedRequestedRef` sigue declarado más arriba en el componente (lo usaba el primer efecto) y que ningún otro sitio dependía del segundo efecto para fijar `relatedStatus` en `'loading'`: el segundo no lo hacía, así que un paper sin DOI ahora pasa por `'loading'` antes de `'ready'`, que es lo que la vista ya espera para la pestaña «similares».

- [ ] **Step 6: Lint y verificación en el navegador**

Run: `npm run lint`
Expected: sin errores.

Arrancar el dev server con `preview_start` (`.claude/launch.json`), iniciar sesión el propio usuario (la sesión es suya; nunca pedir credenciales), abrir un paper del feed **sin DOI** (uno de arXiv) y su hoja de relacionados. Con `read_network_requests` filtrando `urlPattern: "/related"`: **una** petición, no dos. Repetir con un paper con DOI y pestaña «similares»: una.

- [ ] **Step 7: Mutación**

Quitar el `IN_FLIGHT.get` (crear siempre la promesa) → el test `shares one request…` en rojo con `calls` = `2`. Restaurar.

- [ ] **Step 8: Commit**

```bash
git add src/services/relatedPapersService.js src/services/relatedPapersService.test.js src/components/Feed/RelatedPapersSheet.jsx
git commit -m "fix(related): the sheet asks once per paper, and two callers at once share the request

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: El adaptador recorta `OR` y `AND` solo como palabras (S8)

**Files:**
- Modify: `src/services/adapters/SemanticScholarAdapter.js:16`
- Test: `src/services/SemanticScholarAdapter.test.js`

**Interfaces:**
- Consumes: `new SemanticScholarAdapter({ apiBase, fetchImpl })` y `adapter.search(query, page, filters)` (ya existen).
- Produces: nada nuevo.

- [ ] **Step 1: El test**

Añadir a `src/services/SemanticScholarAdapter.test.js`:

```js
test('strips boolean operators as words, not as letters inside words', async () => {
  const escaped = [];
  const restore = silencedGlobalFetch(escaped);
  let asked = '';
  try {
    const adapter = new SemanticScholarAdapter({
      apiBase: 'https://papertok-report-api.example',
      fetchImpl: async url => {
        asked = new URL(String(url)).searchParams.get('q');
        return new Response(JSON.stringify({ total: 0, data: [] }), { headers: { 'content-type': 'application/json' } });
      },
    });

    await adapter.search('CORD-19 NAND ANDROID OR bandwidth', 1);
  } finally {
    restore();
  }

  // `replace(/OR|AND/g, ' ')` turned CORD-19 into "C D-19" and ANDROID into
  // " ROID". Nobody saw it because the adapter is only reached with
  // `type: 'author'`, which skips the line -- until the day it is not.
  assert.match(asked, /^CORD-19 NAND ANDROID\s+bandwidth$/);
});
```

- [ ] **Step 2: Verlo fallar**

Run: `node --test src/services/SemanticScholarAdapter.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 1`, `asked` = `'C D-19 N   ROID   bandwidth'`.

- [ ] **Step 3: La expresión con límites de palabra**

En `SemanticScholarAdapter.js`, línea 16:

```js
    // Word boundaries, or CORD-19 becomes "C D-19": the operators are words.
    let safeQuery = query.replace(/\b(?:OR|AND)\b/g, ' ').replace(/"/g, '').replace(/[()]/g, '');
```

- [ ] **Step 4: Verde**

Run: `node --test src/services/SemanticScholarAdapter.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/services/adapters/SemanticScholarAdapter.js src/services/SemanticScholarAdapter.test.js
git commit -m "fix(s2-adapter): boolean operators are stripped as words, not as letters

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: El feed pide recomendaciones por paper, no solo por `arxivId` (S9)

**Files:**
- Modify: `src/services/semanticScholarService.js`
- Modify: `src/context/FeedContext.jsx:611`
- Test: `src/services/semanticScholarService.test.js`

**Interfaces:**
- Consumes: `getRelatedPapers(paper, limit, options)` de Task 3; `getSemanticScholarPaperId(paper)` de `relatedPapersService.js`.
- Produces: `getPaperRecommendations(paper, { fetchRelated } = {})` → `Promise<string[]>` (ids de arXiv). **Cambia la firma**: antes recibía un `arxivId` string.

- [ ] **Step 1: Los tests**

En `src/services/semanticScholarService.test.js`, **sustituir** el primer test (`turns the related papers from the Worker into arXiv identifiers`) por estos dos y dejar los otros dos como están, cambiando en ellos `getPaperRecommendations('2607.12345')` por `getPaperRecommendations({ arxivId: '2607.12345' })`:

```js
test('turns the related papers from the Worker into arXiv identifiers, once per paper', async () => {
  clearRecommendationCache();
  const asked = [];
  const fetchRelated = async (paper, limit) => {
    asked.push({ paper, limit });
    return [
      { arxivId: '2601.00001' },
      { arxivId: null },
      { arxivId: '2602.00002' },
    ];
  };

  const ids = await getPaperRecommendations({ arxivId: '2607.12345v3' }, { fetchRelated });
  const again = await getPaperRecommendations({ arxivId: '2607.12345v2' }, { fetchRelated });

  assert.deepEqual(ids, ['2601.00001', '2602.00002']);
  assert.deepEqual(again, ids);
  // v2 and v3 of one paper are one lookup: the cache is keyed by the
  // version-free Semantic Scholar id, the same one `/related` is asked with.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].limit, 20);
});

test('asks for a paper that has a DOI and no arXiv id, instead of skipping it', async () => {
  clearRecommendationCache();
  const asked = [];
  const fetchRelated = async paper => { asked.push(paper); return [{ arxivId: '2601.00001' }]; };

  // A PubMed or OpenAlex paper used to be `getPaperRecommendations(undefined)`:
  // no recommendation, no log, and nobody knew the feed only expanded from
  // arXiv. `/related` takes a DOI and so does this.
  const ids = await getPaperRecommendations({ doi: '10.1000/xyz' }, { fetchRelated });

  assert.deepEqual(ids, ['2601.00001']);
  assert.deepEqual(asked, [{ doi: '10.1000/xyz' }]);
});

test('has nothing to ask for a paper with neither DOI nor arXiv id', async () => {
  clearRecommendationCache();
  let calls = 0;
  const ids = await getPaperRecommendations({ id: 'local-only' }, { fetchRelated: async () => { calls += 1; return []; } });
  assert.deepEqual(ids, []);
  assert.equal(calls, 0);
});
```

- [ ] **Step 2: Verlos fallar**

Run: `node --test src/services/semanticScholarService.test.js 2>&1 | grep -E "^(✖|ℹ fail)"`
Expected: `fail 2` como mínimo (`arxivId.replace is not a function` en el primero; `[]` en el del DOI).

- [ ] **Step 3: `getPaperRecommendations` por paper**

Sustituir el cuerpo de `src/services/semanticScholarService.js` desde `import` hasta el final de `getPaperRecommendations`:

```js
import { getRelatedPapers, getSemanticScholarPaperId } from './relatedPapersService.js';

const CACHE = new Map();
const RECOMMENDATION_LIMIT = 20;

/**
 * Get AI-based recommendations for a paper.
 *
 * Takes the paper, not its arXiv id: a paper that came from PubMed, OpenAlex or
 * Scopus has a DOI and no arXiv id, and `/related` takes either. Keyed by the
 * same version-free identifier the route is asked with, so v2 and v3 of one
 * preprint are one lookup.
 *
 * `fetchRelated` is injectable for the same reason the adapters take a fetch:
 * `getRelatedPapers` needs a Firebase session and a configured Worker origin,
 * neither of which exists under `node --test`.
 *
 * @param {object} paper
 * @returns {Promise<string[]>} Array of recommended arXiv IDs
 */
export async function getPaperRecommendations(paper, { fetchRelated = getRelatedPapers } = {}) {
  const paperId = getSemanticScholarPaperId(paper);
  if (!paperId) return [];
  const cacheKey = `rec_${paperId}`;

  if (CACHE.has(cacheKey)) return CACHE.get(cacheKey);

  try {
    const related = await fetchRelated(paper, RECOMMENDATION_LIMIT);
    const arxivIds = related.map(item => item.arxivId).filter(Boolean);
    CACHE.set(cacheKey, arxivIds);
    return arxivIds;
  } catch (error) {
    // A failure is not an answer: leaving it uncached means the next feed advance
    // can still get recommendations once the route recovers.
    console.warn('Semantic Scholar recommendations unavailable', error);
    return [];
  }
}
```

`clearRecommendationCache` se queda igual.

- [ ] **Step 4: El feed pasa el paper**

En `src/context/FeedContext.jsx:611`:

```js
        const semanticRecs = await getPaperRecommendations(paper);
```

- [ ] **Step 5: Verde, y lint**

Run: `node --test src/services/semanticScholarService.test.js src/services/relatedPapersService.test.js 2>&1 | grep -E "^ℹ (pass|fail)"`
Expected: `pass 8`, `fail 0`.

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 6: Mutación**

Volver a `if (!paper?.arxivId) return [];` al principio → el test del DOI en rojo. Restaurar.

- [ ] **Step 7: Commit**

```bash
git add src/services/semanticScholarService.js src/services/semanticScholarService.test.js src/context/FeedContext.jsx
git commit -m "feat(feed): a paper with a DOI and no arXiv id gets recommendations too

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Documentación, suite completa y verificación en vivo

**Files:**
- Modify: `worker/README.md` (párrafo de `SEMANTIC_SCHOLAR_API_KEY`, ~línea 71-85)
- Modify: `STATE.md` (entrada nueva de cabecera)
- Modify: `docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md` (una línea al principio)

**Interfaces:** ninguna.

- [ ] **Step 1: Suite completa**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|cancelled)"`
Expected: `fail 0`, `cancelled 0`. Si algún caso sale `cancelled` bajo Node 22 es el vigilante de tiempo, no el código: ver la memoria de trampas de Node 22 antes de tocar nada.

- [ ] **Step 2: `worker/README.md`**

Sustituir el párrafo añadido el 03-09 (el que empieza `The key's introductory rate limit is **1 RPS**…`) por:

```markdown
The key's introductory rate limit is **1 RPS**, and Semantic Scholar applies it per second: of
five requests in one second, one is answered and four refused at once, with no `retry-after`
(measured 2026-09-03). `S2_GLOBAL_MINUTE_LIMIT` (60, shared by `/sources/s2` and `/related`) is
the same average and no say over which second, so under it both routes keep a one-a-second beat
(`worker/upstream-pace.js`): a caller takes the first free second in the shared ledger, waits for
it (at most 2.5 s), and is refused here with `retry-after: 2` rather than upstream when none is
free. A refusal Semantic Scholar does send is relayed with the same short wait from both routes;
`/related` used to flatten every failure into a bare 502. Raising the ceiling does not help at
1 RPS — asking Semantic Scholar for a higher limit is what does.
```

- [ ] **Step 3: `STATE.md`**

Añadir en la cabecera (encima de la entrada «Semantic Scholar vuelve a responder» del 03-09):

```markdown
## Semantic Scholar sobrevive a su segundo (2026-09-0X)

**Las dos rutas de S2 llevan ahora un compás de una petición por segundo
debajo del techo por minuto (`worker/upstream-pace.js`: una reserva por
segundo en el ledger de siempre, esperar al siguiente hasta 2,5 s, y rechazar
aquí con `retry-after: 2` antes que arriba), `/related` relaya los fallos del
proveedor con el mismo mapeo que `/sources/*` (429 con `code`, `upstreamStatus`
y `retry-after`; `UPSTREAM_TIMEOUT` en el cuelgue), y el navegador pide una
vez por paper: una clave de caché sin `limit` en el borde y en el cliente,
deduplicación de peticiones en vuelo, y la hoja de relacionados con un solo
efecto.** De regalo: el feed pide recomendaciones también para papers con DOI
y sin arXiv, y el adaptador ya no mutila «CORD-19». Plan en
`docs/superpowers/plans/2026-09-03-semantic-scholar-endurecimiento.md`;
hallazgos en `docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md` (S6, la caché
partida por origen, sigue abierta a propósito). Pendiente de @mugar: la
solicitud de límite ampliado a Semantic Scholar.
```

Sustituir `0X` por el día real.

- [ ] **Step 4: Estado en la auditoría**

En `docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md`, justo debajo del título, añadir:

```markdown
> **Estado (2026-09-0X):** S1–S5 y S7–S10 implementados según
> `docs/superpowers/plans/2026-09-03-semantic-scholar-endurecimiento.md`.
> S6 sigue abierta. La solicitud de límite ampliado está pendiente de @mugar.
```

- [ ] **Step 5: Commit de la documentación**

```bash
git add worker/README.md STATE.md docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md
git commit -m "docs(s2): the beat, the relay and the single cache entry, recorded

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 6: Desplegar y verificar en vivo (solo con el árbol rebasado)**

Antes de nada: `git fetch && git rebase origin/main` — `wrangler deploy` sube el árbol entero y sin rebase revierte lo que otra sesión haya desplegado. Después:

```bash
npx wrangler deploy
```

Verificación, **una sola vez y espaciada** (cada sonda gasta el segundo de un lector):

```bash
for i in 1 2 3 4 5 6; do curl -s -m 25 -o /dev/null -w "s2 try$i %{http_code}\n" -H 'Origin: https://papertok.app' "https://api.papertok.app/sources/s2?q=verify+$i+$RANDOM&limit=3"; sleep 3; done
```

Expected: 6 × 200 (antes del compás: 5/6 en las mismas condiciones). Y la prueba del compás, **una vez**:

```bash
for i in 1 2 3; do ( curl -s -m 25 -o /dev/null -w "burst$i %{http_code} %{time_total}s\n" -H 'Origin: https://papertok.app' "https://api.papertok.app/sources/s2?q=beat+$i+$RANDOM&limit=3" ) & done; wait
```

Expected: 3 × 200, con tiempos escalonados de ~1 s (una en el segundo actual, una en el siguiente, una en el de después). Antes del compás esto era 1 × 200 + 2 × 429. Si sale un 429 con `code: PROVIDER_RATE_LIMITED` y `retry-after: 2`, es el compás rechazando porque había tráfico real en esos segundos: correcto, no un fallo.

`/related` no se puede sondear con `curl` (exige identidad): comprobarlo desde la app logueada, abriendo la hoja de relacionados de un paper y mirando en `read_network_requests` que la respuesta es 200 o, si S2 refusa, un **429** con `code` — no un 502.

- [ ] **Step 7: Registrar el resultado**

Añadir a la entrada de `STATE.md` del Step 3 una línea con los dos números medidos (los 6 espaciados y la ráfaga de 3), con la hora UTC.

---

## Auto-revisión

**Cobertura del spec.** S1 → Task 2. S2 → Task 1. S3 → Task 2 (el compás espera en vez de rechazar; no hace falta `withUpstreamRetry`). S4 → Task 4. S5 → Task 3. S6 → fuera, declarado en Global Constraints. S7 → Task 1. S8 → Task 5. S9 → Task 6. S10 → los tests de `/related` fallando están en Task 1. La solicitud de límite → Global Constraints y Task 7.

**Consistencia de nombres.** `awaitUpstreamSlot` (Task 2, fichero y hook), `awaitSharedPace` (solo en `report-api.js`), `upstreamFailureResponse` y `upstreamRetryAfter` (Task 1, usados en el router), `RELATED_UPSTREAM_LIMIT` (Task 3, en el Worker y en el cliente con el mismo nombre y valor), `getRelatedPapers(paper, limit, { fetchWorker, apiBase })` (Task 3, consumido por Task 4 y Task 6), `clearRelatedPapersCache` (Task 3, ampliado en Task 4), `getPaperRecommendations(paper, { fetchRelated })` (Task 6, consumido por `FeedContext`).

**Recuentos de tests.** Al empezar: 95 en `report-api.test.js`. Task 1 añade 3 (98). Task 2 añade 2 y cambia 1 (100 en ese fichero, más 4 en `upstream-pace.test.js` = 104 en la orden de Step 8). Task 3 añade 1 (101 en el fichero; 101 + 4 de `upstream-pace.test.js` = 105 en total del Worker). Si un recuento no cuadra, comprobar que no se ha añadido un test a más antes de buscar un fallo de código.
