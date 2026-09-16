# Compás de arXiv — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que toda la app, sumada, pida a arXiv como mucho una vez cada tres segundos, y que lo que no cabe se rechace en el Worker sin gastar una llamada ni un turno.

**Architecture:** `awaitUpstreamSlot` (Worker) generaliza su asiento por segundo a un asiento por periodo (`periodMs`), y `handleArxiv` lo toma tras un MISS de caché con periodo de 3 s y espera máxima de 4 s; refusa con `429 PROVIDER_RATE_LIMITED`. Los fallos de `/arxiv` pasan por `upstreamFailureResponse`, como las demás fuentes. La caché del borde de arXiv sube a una hora. En el cliente, la cola serial de `arxivService` se saca a un módulo propio que deja caer las peticiones que han esperado más que el plazo de la ruta y respeta el `retry-after` de un 429.

**Tech Stack:** Cloudflare Worker (`worker/report-api.js`, Durable Object `RequestQuotaLedger`), `node --test`, `wrangler deploy` para el Worker (no lo despliega CI), Vercel para el frontend (despliega solo al hacer push).

**Spec:** `docs/AUDITORIA-ARXIV-COMPAS-2026-09-16.md`

## Global Constraints

- **Worker antes que frontend** (memoria `papertok-s2-rate-regime`): el Worker se despliega con `npm run worker:deploy` desde `main` al día con `origin/main`, y solo después se sube el frontend.
- Tests con `node --test <fichero>`; CI corre Node 22. Los tests del Worker corren sin Durable Objects reales: el ledger se falsea (`scriptedQuotaLedger`, `scriptedLedger`).
- Un ledger ausente o caído **no** debe matar a arXiv: el compás es cortesía, no protección de una clave. Sin ledger, `/arxiv` sale sin compás (y lo dice en consola).
- Mensajes de commit en castellano, estilo del historial, con la línea de atribución de Claude.

---

### Task 1: el compás late a cualquier periodo, no solo a un segundo

**Files:**
- Modify: `worker/upstream-pace.js`
- Test: `worker/upstream-pace.test.js`

**Interfaces:**
- Produces: `awaitUpstreamSlot(ledger, { namespace, periodMs = 1000, maxWaitMs = DEFAULT_MAX_WAIT_MS, now, sleep })` → `{ accepted: true, slot, waitedMs }` | `{ accepted: false }` | `{ accepted: false, code }`. El asiento se reserva como subject `<namespace>:slot:<n>` con `n = Math.floor(t / periodMs)`. Exporta `paceRetryAfterSeconds(maxWaitMs)`; `PACE_RETRY_AFTER_SECONDS` pasa a ser `paceRetryAfterSeconds(DEFAULT_MAX_WAIT_MS)`.

- [ ] **Step 1: Write the failing tests** (añadir al final de `worker/upstream-pace.test.js`, y cambiar `second:` por `slot:` en los tres `assert.deepEqual` existentes que lo nombran: `{ accepted: true, second: 10, waitedMs: 0 }` → `{ accepted: true, slot: 10, waitedMs: 0 }`, `second: 11` → `slot: 11`, `second: 12` → `slot: 12`)

```js
// arXiv asks for one request every three seconds. The beat is the same beat,
// with a longer period: the clock at 10 000 ms is inside period 3 (9 000 to
// 11 999), the next period starts at 12 000.
test('a three-second beat reserves one slot per three seconds and waits for the next one', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }, { accepted: true }], seen),
    { namespace: 'arxiv', periodMs: 3_000, maxWaitMs: 4_000, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: true, slot: 4, waitedMs: 2_000 });
  assert.deepEqual(slept, [2_000]);
  assert.deepEqual(seen.periodKeys, ['arxiv:pace', 'arxiv:pace']);
  const [first, second] = seen.reservations;
  assert.notEqual(first.subjectKey, second.subjectKey, 'each period must reserve a different subject');
  assert.equal(first.subjectLimit, 1);
});

test('a three-second beat gives up inside its own wait budget', async () => {
  const seen = { periodKeys: [], calls: 0 };
  const slept = [];
  const slot = await awaitUpstreamSlot(
    scriptedLedger([{ accepted: false, scope: 'user' }], seen),
    { namespace: 'arxiv', periodMs: 3_000, maxWaitMs: 4_000, now: AT_SECOND_TEN, sleep: async ms => { slept.push(ms); } },
  );

  assert.deepEqual(slot, { accepted: false });
  // Period 3 starts at 9 000 (already begun), period 4 at 12 000 (2 s away):
  // both inside 4 s of 10 000. Period 5 starts at 15 000, 5 s away: outside.
  assert.equal(seen.calls, 2);
  assert.deepEqual(slept, []);
});

test('the retry-after of a beat covers the wait budget it was given', () => {
  assert.equal(paceRetryAfterSeconds(4_000), '4');
  assert.equal(paceRetryAfterSeconds(2_500), '3');
  assert.equal(paceRetryAfterSeconds(DEFAULT_MAX_WAIT_MS), PACE_RETRY_AFTER_SECONDS);
});
```

Y en el import del test: `import { awaitUpstreamSlot, DEFAULT_MAX_WAIT_MS, PACE_RETRY_AFTER_SECONDS, paceRetryAfterSeconds } from './upstream-pace.js';`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test worker/upstream-pace.test.js`
Expected: FAIL — `paceRetryAfterSeconds` no existe (error de import) y, una vez exista, el asiento de tres segundos devuelve `second: 10` con `waitedMs: 0` porque el periodo está cableado a 1000.

- [ ] **Step 3: Implement**

Reemplazar en `worker/upstream-pace.js` desde `export const DEFAULT_MAX_WAIT_MS` hasta el final:

```js
export const DEFAULT_MAX_WAIT_MS = 2_500;
// What a caller refused here is told to wait, in whole seconds, derived from the
// window it was refused within rather than written next to it: the beat gave up
// because no slot was free inside that window, so "come back" means "after it".
// Not the same number as the router's fallback for a *provider* refusal, which
// speaks for the provider's own window.
export function paceRetryAfterSeconds(maxWaitMs) {
  return String(Math.ceil(maxWaitMs / 1000));
}
export const PACE_RETRY_AFTER_SECONDS = paceRetryAfterSeconds(DEFAULT_MAX_WAIT_MS);
// Sits exactly on `request-quota-ledger.js`'s own `MAX_LIMIT`. One increment
// past this and that module's `positiveInteger` returns 0 for any
// `globalLimit`, which turns every reservation `INVALID_REQUEST` -> 400 ->
// `QUOTA_LEDGER_UNAVAILABLE` here -> a 503 on every paced request.
// Raise the two together, or not at all.
const PACE_GLOBAL_LIMIT = 1_000_000;

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// `periodMs` is the beat's period: one slot per period, app-wide. Semantic
// Scholar takes the default second; arXiv asks for one request every three
// seconds (its published policy), so it passes 3 000. The slot index is the
// period the clock is in, `floor(t / periodMs)`, which for a one-second beat is
// the second itself -- the arithmetic below is unchanged, only the unit.
export async function awaitUpstreamSlot(ledger, {
  namespace,
  periodMs = 1000,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  const started = now();
  // The bound stays expressed in `slot` against `started`, never against a
  // fresh `now()` read, so it terminates in a handful of steps no matter what
  // the clock does inside the loop: each iteration below only ever moves
  // `slot` forward, so a clock that jumps ahead can only make this exit
  // sooner, never later, and one that stalls or runs backward leaves it exactly
  // as bounded as a plain per-period counter always was.
  let slot = Math.floor(started / periodMs);
  while (slot * periodMs - started <= maxWaitMs) {
    const reservation = await reserveRequestQuota(ledger, {
      periodKey: `${namespace}:pace`,
      subject: `${namespace}:slot:${slot}`,
      subjectLimit: 1,
      globalLimit: PACE_GLOBAL_LIMIT,
    });
    if (!reservation.accepted && reservation.code) return { accepted: false, code: reservation.code };
    // The reservation round trip just spent is exactly what can burn the
    // clock, so whether `slot` is still current has to be read fresh here,
    // after the await -- not assumed from the value the loop already held
    // going in. A slot confirmed once the period it names has already ended
    // is no more usable than one the ledger refused outright: honoring it
    // anyway is how a caller used to send inside a period somebody else holds,
    // because the wait below clamps to zero for any `now()` at or past
    // `slot`, past its own end included. (A check on `slot` before the
    // reservation call would not catch this -- it is the call's own latency
    // that does the damage, and it hasn't happened yet at that point.)
    if (reservation.accepted && Math.floor(now() / periodMs) <= slot) {
      const waitMs = Math.max(0, slot * periodMs - now());
      if (waitMs > 0) await sleep(waitMs);
      return { accepted: true, slot, waitedMs: waitMs };
    }
    // Next candidate is whichever is later: the next period in sequence, or
    // the period the clock has actually reached. Plain `slot + 1` is what
    // let a stale accept slip through above -- without the `now()` term here
    // too, a slow enough ledger keeps proposing periods that have already
    // closed by the time each reservation lands, one at a time, rather than
    // catching up to the present in a single jump.
    slot = Math.max(slot + 1, Math.floor(now() / periodMs));
  }
  return { accepted: false };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test worker/upstream-pace.test.js worker/report-api.test.js`
Expected: PASS (los tests del beat de S2 en `report-api.test.js` siguen verdes: la `periodKey` `s2:pace` no cambia).

- [ ] **Step 5: Commit**

```bash
git add worker/upstream-pace.js worker/upstream-pace.test.js
git commit -m "feat(worker): el compás de upstream late a cualquier periodo, no solo a un segundo"
```

---

### Task 2: `/arxiv` toma un asiento cada tres segundos y sus fallos dicen cuáles son

**Files:**
- Modify: `worker/report-api.js` — constantes (líneas ~73-92), `handleArxiv` (~1026-1075), despachador `/arxiv` (~2568-2574), `UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS` (~216)
- Test: `worker/report-api.test.js` (junto al test «cuts an arXiv upstream that sends its headers and then stalls the body», ~896)

**Interfaces:**
- Consumes: `awaitUpstreamSlot(ledger, { namespace: 'arxiv', periodMs, maxWaitMs })` y `paceRetryAfterSeconds` de la Task 1.
- Produces: `/arxiv` contesta `429 { code: 'PROVIDER_RATE_LIMITED' }` con `retry-after: 4` y `cache-control: no-store` cuando no hay asiento; `429 { error, code: 'UPSTREAM_RATE_LIMITED', upstreamStatus: 429 }` cuando arXiv refusa; `502 { error, code: 'UPSTREAM_TIMEOUT' }` en un cuelgue; `502 { error, upstreamStatus }` en otro fallo HTTP. `ARXIV_CACHE_SECONDS` = 3600.

- [ ] **Step 1: Write the failing tests** (añadir tras el test del cuelgue de arXiv, ~línea 907)

```js
const ARXIV_URL = 'https://papertok-report-api.example/arxiv?search_query=all:malaria';
const ATOM_FEED = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const arxivThrough = (env, upstream) => withWorkerFetchMock(upstream, () => reportApi.fetch(new Request(
  ARXIV_URL, { headers: { origin: 'https://mugar123.github.io' } },
), env));
const IS_ARXIV_PACE = key => key === 'arxiv:pace';

// One request every three seconds is arXiv's published policy, and the Worker
// is the one client arXiv sees. A miss takes a seat on the beat before it goes
// upstream; a seat that is not free within the wait budget is refused here,
// with no arXiv call spent.
test('an arXiv miss takes a seat on the three-second beat before going upstream', async () => {
  const state = { actions: [] };
  let upstreamCalls = 0;
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state) },
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }); },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
  const seat = state.actions.find(a => a.action === 'reserve' && IS_ARXIV_PACE(a.periodKey));
  assert.ok(seat, `no seat taken on the arXiv beat: ${JSON.stringify(state.actions)}`);
});

test('refuses an arXiv miss with 429 and retry-after when the beat has no seat, without calling arXiv', async () => {
  const state = { actions: [] };
  let upstreamCalls = 0;
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger(state, { refuse: IS_ARXIV_PACE }) },
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED); },
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'PROVIDER_RATE_LIMITED');
  assert.equal(response.headers.get('retry-after'), '4');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(upstreamCalls, 0);
});

// The beat is courtesy towards arXiv, not the protection of a key: a ledger
// that is missing or down must not take the source down with it.
test('an arXiv miss goes upstream unpaced when there is no ledger to keep the beat', async () => {
  let upstreamCalls = 0;
  const response = await arxivThrough(
    {},
    async () => { upstreamCalls += 1; return new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }); },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
});

// A 429 from arXiv, a stall, and a bad answer used to leave as the same
// `502 arXiv unavailable`. The client retries a 502 at once, which is the one
// thing that makes a rate limit worse.
test('relays an arXiv refusal as 429 UPSTREAM_RATE_LIMITED with the status that caused it', async () => {
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async () => new Response('Rate exceeded.', { status: 429 }),
  );

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(body.upstreamStatus, 429);
  assert.match(response.headers.get('retry-after'), /^\d+$/);
});

test('names an arXiv stall as UPSTREAM_TIMEOUT', async () => {
  const response = await withShortDeadlines(25, () => arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async (_url, options) => stalledBodyResponse(options?.signal, 'application/atom+xml'),
  ));

  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'UPSTREAM_TIMEOUT');
});

test('caches an arXiv answer for an hour at the edge', async () => {
  const response = await arxivThrough(
    { REQUEST_QUOTA_LEDGER: scriptedQuotaLedger({ actions: [] }) },
    async () => new Response(ATOM_FEED, { headers: { 'content-type': 'application/atom+xml' } }),
  );

  assert.match(response.headers.get('cache-control'), /s-maxage=3600\b/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test worker/report-api.test.js 2>&1 | grep -E "^not ok|# (pass|fail)"`
Expected: FAIL en «takes a seat» (no se reserva nada), «refuses … 429» (contesta 200), «relays an arXiv refusal» (502 sin código), «names an arXiv stall» (502 sin código) y «caches … an hour» (`s-maxage=600`). Pasa «goes upstream unpaced» (hoy nunca hay compás).

- [ ] **Step 3: Implement**

Constantes, junto a `ARXIV_UPSTREAM_TIMEOUT_MS` y `ARXIV_CACHE_SECONDS`:

```js
const ARXIV_UPSTREAM_TIMEOUT_MS = 5000;
// arXiv's published policy: one request every three seconds, one connection.
// The Worker is the one client arXiv sees, so the beat is app-wide, kept in
// the same ledger as the Semantic Scholar one (`utils/upstream-pace.js`). The
// wait budget is set by the client: the browser leaves `/arxiv` at 6 s
// (ARXIV_ROUTE_TIMEOUT_MS), so four seconds of waiting plus a healthy fetch
// still answers in time, and a seat further away than that is refused at
// once -- the caller has other sources, and a seat nobody will wait for is a
// seat somebody else could have used.
const ARXIV_PACE_PERIOD_MS = 3_000;
const ARXIV_PACE_MAX_WAIT_MS = 4_000;
```

y

```js
// An hour, up from ten minutes. arXiv's listings change once a day (the
// announcement at 20:00 ET), so a page served from the edge for an hour is as
// fresh as one fetched twice -- and with one upstream call every three seconds
// for the whole app, every call the cache saves is a seat somebody else gets.
const ARXIV_CACHE_SECONDS = 60 * 60;
```

En `UPSTREAM_RETRY_AFTER_FALLBACK_SECONDS` no se añade nada: arXiv no manda `retry-after` en su 429 y su ventana no está publicada, así que el minuto por defecto es la respuesta honesta.

`handleArxiv`, desde la caché hasta el `return`:

```js
  const cacheKey = canonicalCacheKey(request, Object.fromEntries(upstreamUrl.searchParams));
  const cached = await caches.default.match(cacheKey);
  if (cached) return serveCached(cached, origin, env);

  // A miss takes a seat on the beat before it goes upstream. No ledger, no
  // beat: the seat is courtesy towards arXiv, not the protection of a key,
  // and a ledger that is down must not take the source down with it.
  if (env.REQUEST_QUOTA_LEDGER) {
    const seat = await awaitUpstreamSlot(env.REQUEST_QUOTA_LEDGER, {
      namespace: 'arxiv',
      periodMs: ARXIV_PACE_PERIOD_MS,
      maxWaitMs: ARXIV_PACE_MAX_WAIT_MS,
    });
    if (!seat.accepted && !seat.code) {
      return json({ code: 'PROVIDER_RATE_LIMITED' }, 429, {
        ...corsHeaders(origin, env),
        'cache-control': 'no-store',
        'retry-after': paceRetryAfterSeconds(ARXIV_PACE_MAX_WAIT_MS),
      });
    }
    if (seat.code) console.warn(`arXiv beat unavailable (${seat.code}); sending unpaced`);
  }

  const response = await fetchWithDeadline(upstreamUrl.toString(), {
    headers: {
      accept: 'application/atom+xml, application/xml, text/xml;q=0.9',
      'user-agent': 'PaperTok/1.0 (mailto:app@papertok.io)',
    },
  }, ARXIV_UPSTREAM_TIMEOUT_MS);
  if (!response.ok) {
    // The status travels on the error so the router can tell arXiv's own 429
    // from an outage -- they used to leave as the same 502.
    const error = new Error(`arXiv error: ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  // Read under the same deadline: arXiv is the one upstream that answers XML, and
  // a feed that stops mid-document is a stall, not a short answer.
  const xml = await response.text();
  if (!xml.includes('<feed')) throw new Error('Invalid arXiv response');
```

(el resto de `handleArxiv`, la construcción de `workerResponse` y el `caches.default.put`, no cambia.) Import arriba del fichero, junto al de `upstream-pace.js` que ya existe: `import { awaitUpstreamSlot, paceRetryAfterSeconds, PACE_RETRY_AFTER_SECONDS } from './upstream-pace.js';` (mantener lo que ya importe).

Despachador:

```js
    if (url.pathname === '/arxiv') {
      try {
        return await handleArxiv(request, env);
      } catch (error) {
        console.error('arXiv route failed', error);
        return upstreamFailureResponse('/arxiv', error, origin, env, 'arXiv unavailable');
      }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test worker/report-api.test.js worker/upstream-pace.test.js 2>&1 | grep -E "^not ok|# (pass|fail)"`
Expected: PASS, incluido el test previo del cuelgue (sigue siendo 502).

- [ ] **Step 5: Commit**

```bash
git add worker/report-api.js worker/report-api.test.js
git commit -m "feat(worker): /arxiv toma un asiento cada tres segundos, y sus fallos dicen cuáles son"
```

---

### Task 3: la cola de arXiv de la pestaña deja caer lo que nadie espera y respeta el 429

**Files:**
- Create: `src/services/arxivRequestQueue.js`
- Create: `src/services/arxivRequestQueue.test.js`
- Modify: `src/services/arxivService.js` (líneas ~160-186 y `fetchXmlWithTimeout` ~58-64)

**Interfaces:**
- Produces: `createArxivRequestQueue({ gapMs = 350, maxQueueWaitMs, now = Date.now, sleep })` → `{ run(key, task) }`. `run` deduplica por `key` las tareas en vuelo, las serializa con `gapMs` entre una y otra, rechaza sin ejecutar (`ArxivQueueError` con `code: 'QUEUE_EXPIRED'`) las que llevan más de `maxQueueWaitMs` esperando cuando les toca, y tras un fallo con `status === 429` rechaza al instante (`code: 'RATE_LIMITED'`) todo lo que toque durante `retryAfterMs` (del error, o `DEFAULT_COOLDOWN_MS` = 4000 si no lo trae).
- `arxivService.js` usa esa cola con `maxQueueWaitMs = ARXIV_ROUTE_TIMEOUT_MS`, y `fetchXmlWithTimeout` pone `status` y `retryAfterMs` en el error de una respuesta no-ok.

- [ ] **Step 1: Write the failing tests** (`src/services/arxivRequestQueue.test.js`)

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createArxivRequestQueue, DEFAULT_COOLDOWN_MS } from './arxivRequestQueue.js';

// A clock the tests move by hand, and a sleep that moves it instead of waiting.
function fakeClock(start = 0) {
  const clock = { value: start };
  clock.now = () => clock.value;
  clock.sleep = async ms => { clock.value += ms; };
  return clock;
}

test('runs tasks one after another with the gap between them', async () => {
  const clock = fakeClock(1_000);
  const queue = createArxivRequestQueue({ gapMs: 350, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  const startedAt = [];
  const task = (label) => async () => { startedAt.push([label, clock.value]); clock.value += 100; return label; };

  const results = await Promise.all([queue.run('a', task('a')), queue.run('b', task('b'))]);

  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(startedAt, [['a', 1_000], ['b', 1_450]]);
});

test('shares one run between identical requests in flight', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ now: clock.now, sleep: clock.sleep, maxQueueWaitMs: 6_000 });
  let runs = 0;
  const task = async () => { runs += 1; return 'same'; };

  const results = await Promise.all([queue.run('k', task), queue.run('k', task)]);

  assert.deepEqual(results, ['same', 'same']);
  assert.equal(runs, 1);
});

// A request that waited in the queue longer than anyone waits for the route
// has no listener left; sending it anyway spends an app-wide seat on the
// beat for an answer that is thrown away.
test('drops a request that has waited longer than the queue allows, without running it', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  let lateRan = false;
  const slow = queue.run('slow', async () => { clock.value += 7_000; return 'slow'; });
  const late = queue.run('late', async () => { lateRan = true; return 'late'; });

  assert.equal(await slow, 'slow');
  await assert.rejects(late, error => error.code === 'QUEUE_EXPIRED');
  assert.equal(lateRan, false);
});

test('after a 429 it refuses at once for the retry-after it was given, then resumes', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  const refused = Object.assign(new Error('PaperTok arXiv API error: 429'), { status: 429, retryAfterMs: 4_000 });

  await assert.rejects(queue.run('a', async () => { throw refused; }), error => error.status === 429);
  let ran = false;
  await assert.rejects(queue.run('b', async () => { ran = true; }), error => error.code === 'RATE_LIMITED');
  assert.equal(ran, false);

  clock.value += 4_000;
  assert.equal(await queue.run('c', async () => 'c'), 'c');
});

test('a 429 without retry-after cools down for the default', async () => {
  const clock = fakeClock();
  const queue = createArxivRequestQueue({ gapMs: 0, maxQueueWaitMs: 6_000, now: clock.now, sleep: clock.sleep });
  await assert.rejects(queue.run('a', async () => { throw Object.assign(new Error('429'), { status: 429 }); }));
  clock.value += DEFAULT_COOLDOWN_MS - 1;
  await assert.rejects(queue.run('b', async () => 'b'), error => error.code === 'RATE_LIMITED');
  clock.value += 1;
  assert.equal(await queue.run('c', async () => 'c'), 'c');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test src/services/arxivRequestQueue.test.js`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implement** `src/services/arxivRequestQueue.js`

```js
/**
 * The one lane every arXiv request of this tab goes through.
 *
 * arXiv asks for one request every three seconds and one connection, and the
 * Worker now keeps that beat for the whole app (worker/report-api.js: a miss
 * takes a seat, a seat further than four seconds away is refused with 429).
 * This lane is the tab's side of the same bargain:
 *
 * - Requests go out one at a time, `gapMs` apart, and identical URLs in flight
 *   share one run -- the two things `arxivService` always did.
 * - A request that has waited in the lane longer than `maxQueueWaitMs` is
 *   dropped without being sent. Nobody is listening for it any more (the
 *   route's own deadline has passed for every caller), and sending it anyway
 *   would spend an app-wide seat on an answer that is thrown away. Measured
 *   2026-09-16: one cold feed load put five arXiv requests in this lane in
 *   2.5 s, and the last ones were for followed topics whose 3.5 s budget was
 *   long gone by the time they went out.
 * - A 429 -- the Worker's beat refusing, or arXiv itself -- puts the lane on
 *   a cooldown for the `retry-after` it carried (`DEFAULT_COOLDOWN_MS` when it
 *   carried none), during which every request is refused at once. Asking
 *   again inside that window costs a round trip and answers the same thing.
 *
 * `now` and `sleep` are injectable so the lane can be tested without waiting.
 */
export const DEFAULT_GAP_MS = 350;
export const DEFAULT_COOLDOWN_MS = 4_000;

export class ArxivQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArxivQueueError';
    this.code = code;
  }
}

const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createArxivRequestQueue({
  gapMs = DEFAULT_GAP_MS,
  maxQueueWaitMs,
  now = Date.now,
  sleep = realSleep,
} = {}) {
  let chain = Promise.resolve();
  const inFlight = new Map();
  let refusedUntil = 0;

  const runNow = async (enqueuedAt, task) => {
    if (now() < refusedUntil) {
      throw new ArxivQueueError('RATE_LIMITED', 'arXiv is rate limited; not asking again yet');
    }
    if (Number.isFinite(maxQueueWaitMs) && now() - enqueuedAt > maxQueueWaitMs) {
      throw new ArxivQueueError('QUEUE_EXPIRED', 'arXiv request waited longer than anyone waits for it');
    }
    try {
      return await task();
    } catch (error) {
      if (error?.status === 429) {
        const cooldown = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : DEFAULT_COOLDOWN_MS;
        refusedUntil = Math.max(refusedUntil, now() + cooldown);
      }
      throw error;
    }
  };

  const run = (key, task) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const enqueuedAt = now();
    const attempt = () => runNow(enqueuedAt, task);
    const result = chain.then(attempt, attempt);
    chain = result.then(() => sleep(gapMs), () => sleep(gapMs));
    const tracked = result.finally(() => inFlight.delete(key));
    inFlight.set(key, tracked);
    return tracked;
  };

  return { run };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/services/arxivRequestQueue.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire it into `arxivService.js`**

Sustituir el bloque desde `// arXiv asks clients for roughly one request every three seconds` hasta el final de `fetchArxivData` (líneas ~160-186) por:

```js
// Every arXiv request of this tab goes through one lane (arxivRequestQueue.js):
// serialized with a gap, deduplicated in flight, dropped when it has waited
// longer than the route's deadline, and paused for the retry-after of a 429.
// The Worker keeps arXiv's one-every-three-seconds beat for the whole app;
// the lane is what keeps this tab from spending seats on answers nobody
// waits for any more.
const arxivQueue = createArxivRequestQueue({ maxQueueWaitMs: ARXIV_ROUTE_TIMEOUT_MS });

function fetchArxivData(url) {
  return arxivQueue.run(url, () => fetchArxivDataNow(url));
}
```

con `import { createArxivRequestQueue } from './arxivRequestQueue.js';` arriba, y `ARXIV_ROUTE_TIMEOUT_MS` declarado **antes** de `arxivQueue` (mover el `export const ARXIV_ROUTE_TIMEOUT_MS = 6_000;` con su comentario por encima de este bloque).

Y en `fetchXmlWithTimeout`, el error de una respuesta no-ok lleva el estado y el `retry-after`:

```js
async function fetchXmlWithTimeout(url, timeoutMs, errorLabel) {
  const response = await fetch(url, withRequestDeadline({}, timeoutMs));
  if (!response.ok) {
    // The status and the provider's own backoff travel on the error: the
    // tab's lane pauses on a 429 for exactly what it was told.
    const error = new Error(`${errorLabel}: ${response.status}`);
    error.status = response.status;
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
    throw error;
  }
```

(el resto de la función igual).

- [ ] **Step 6: Run the arXiv tests and lint**

Run: `node --test src/services/arxivService.test.js src/services/arxivRequestQueue.test.js src/services/scientificReportService.test.js src/services/topicRetrievalService.test.js && npx eslint src/services/arxivService.js src/services/arxivRequestQueue.js src/services/arxivRequestQueue.test.js`
Expected: PASS y eslint limpio.

- [ ] **Step 7: Commit**

```bash
git add src/services/arxivRequestQueue.js src/services/arxivRequestQueue.test.js src/services/arxivService.js
git commit -m "feat(arxiv): la cola de la pestaña deja caer lo que nadie espera y respeta el retry-after"
```

---

### Task 4: desplegar el Worker y verificar el compás en producción

**Files:** ninguno nuevo. Sonda en el scratchpad (`arxiv-beat-probe.sh`).

- [ ] **Step 1: Suite completa y dry-run**

Run: `npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"` y `npm run worker:deploy:dry-run`
Expected: 0 fallos; el dry-run compila `worker/report-api.js` sin errores.

- [ ] **Step 2: Deploy del Worker** (desde `main`, con `git status` limpio en ficheros seguidos y `origin/main` alcanzado)

Run: `npm run worker:deploy`
Expected: «Deployed papertok-report-api» con una versión nueva.

- [ ] **Step 3: Sonda del compás** — seis peticiones únicas en paralelo contra `https://papertok-report-api.papertok-mugar123.workers.dev/arxiv`, con `start` distinto cada una para forzar MISS, midiendo estado y tiempo de cada una:

```bash
W=https://papertok-report-api.papertok-mugar123.workers.dev; U=$(date +%s)
for i in 1 2 3 4 5 6; do
  (curl -s -o /dev/null -w "req$i %{http_code} %{time_total}s retry-after=%header{retry-after}\n" \
    -H "Origin: https://papertok.app" -G "$W/arxiv" \
    --data-urlencode "search_query=cat:cs.AI" --data-urlencode "start=$((U % 500 + i * 7))" \
    --data-urlencode "max_results=3" --data-urlencode "sortBy=submittedDate" --data-urlencode "sortOrder=descending") &
done; wait
```

Expected: dos o tres `200` (el primero casi inmediato, los otros tras ≤3 s y ≤4 s de espera, según la fase del periodo en que caiga la ráfaga: simulado en el scratchpad, `beat-sim.mjs`) y el resto `429` inmediatos con `retry-after=4`. Repetir una de las URL con 200 al instante: `200` en <0,2 s (caché, sin asiento).

- [ ] **Step 4: Sonda de la entrada en frío** con el build nuevo (scratchpad `cold-entry-probe.mjs`, `nosnapshot`): el feed pinta sin error; en la red, las peticiones a `/arxiv` de una carga se ven espaciadas ≥3 s o rechazadas con 429, nunca en ráfaga.

- [ ] **Step 5: Registro y push**

Añadir la entrada de `STATE.md` (arriba), commitear docs y hacer push:

```bash
git add STATE.md docs/AUDITORIA-ARXIV-COMPAS-2026-09-16.md docs/superpowers/plans/2026-09-16-arxiv-compas.md
git commit -m "docs(arxiv): auditoría y plan del compás de arXiv"
git push origin main
```
