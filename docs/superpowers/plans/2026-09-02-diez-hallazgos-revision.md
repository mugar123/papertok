# Diez hallazgos de la revisión 7940a3e..HEAD — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar los diez hallazgos que dejó la revisión del rango `7940a3e..HEAD` (migración a Vercel y papertok.app, anclas de hilos en el edge, onboarding de handle, almacenamiento por usuario), cada uno con un test que lo reproduce antes del arreglo.

**Architecture:** Diez arreglos independientes, agrupados por capa: tres en el Worker (`worker/thread-anchor.js`, `worker/report-api.js`), cinco en el cliente React (comentarios, analítica, auth, onboarding, modal de listas, perfil), uno en el despliegue (`vercel.json` + `src/main.jsx`). Ningún arreglo depende de otro salvo la Tarea 3, que reutiliza el `memoryStore` endurecido en la Tarea 1. La lógica nueva que se puede aislar (fusionar filas, alternar un seguido, techo por minuto) va a helpers puros con test directo; lo que vive dentro de JSX se fija con tests SOURCE, que es la convención del repo (`saveModalMotion.test.js`, `OnboardingFlow.test.js`).

**Tech Stack:** React 18 + Vite (HashRouter), Firebase Web SDK (Firestore), Cloudflare Worker con KV y Durable Objects, `node --test` (Node 22 en CI, 25 en local), Vercel para el frontend.

**Spec:** la sección «Hallazgos (spec)» de este mismo documento. No hay spec aparte: los hallazgos salieron del panel de `/code-review high 7940a3e..HEAD` y se transcriben aquí con el código verificado.

## Global Constraints

- Tests: `node --test $(find src worker proxy -name '*.test.js')` (`npm test`). Un fichero nuevo se descubre solo si termina en `.test.js` y vive bajo `src/`, `worker/` o `proxy/`.
- CI corre Node 22. Un test que cuelga sale como `cancelled`; no dejes promesas sin resolver en un test.
- Si trabajas en un worktree, copia `.env` a mano: sin él un test del Worker se cuelga para siempre en vez de fallar.
- KV en producción rechaza `expirationTtl < 60`. El KV falso de los tests lo aceptaba; deja de aceptarlo en la Tarea 1.
- Nada del camino del feed importa servicios sociales (`commentService.test.js` «SOURCE: nothing on the feed path imports any social service»). Los helpers nuevos de comentarios van a `src/utils/`, no a `services/`, y no los importa nada del feed.
- El escáner de Tailwind revive cualquier clase citada en un comentario, incluso fuera de `src/`. No cites clases en comentarios nuevos.
- Otra sesión de Claude puede estar editando el mismo árbol: antes de cada commit, revisa `git diff --stat` y añade solo los ficheros de la tarea.
- Antes de desplegar, rebase: `wrangler` sube el árbol entero y sin rebase revierte lo de la otra sesión.
- Commits en español, estilo `fix(ámbito): frase en minúscula`, con el trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Estilo: `src/main.jsx` va sin punto y coma; el resto del código, con él.

---

## Hallazgos (spec)

| # | Fichero | Defecto | Escenario de fallo |
|---|---------|---------|--------------------|
| F1 | `src/components/Comments/CommentsSheet.jsx:505` | Las páginas que sirve el Worker llegan con `cursor: null` y `hasMore: true`; `loadMore` filtra `source.hasMore && source.cursor`, así que nunca las pagina. | Un hilo con 21+ comentarios abierto vía edge muestra 20 y el botón «cargar más» no hace nada. |
| F2 | `worker/thread-anchor.js:49` | `THREAD_KV_THREAD_TTL_SECONDS = 20` está por debajo del mínimo de KV (60 s). El `put` falla en producción, `writeCachedEntry` lo traga, y ningún hilo vivo se cachea. | Cada apertura de un hilo con comentarios paga las tres lecturas REST; el KV falso de los tests acepta el TTL y no lo detecta. |
| F3 | `src/context/AuthContext.jsx:133-136` | El flag de onboarding guardado en el dispositivo suprime `PROFILE_LOAD_FAILED` y el reinicio cuando el documento no existe. La app abre con `followedAuthors = []`, y `toggleFollowAuthor` escribe el array entero. | Lectura de perfil que agota los 7 s → app abierta con lista vacía → seguir a un autor sobrescribe `followedAuthors` en Firestore con `[ese autor]`: pérdida de datos. |
| F4 | `src/context/AnalyticsContext.jsx` | `<Analytics route path>` emite pageview solo cuando cambian `route`/`path`, y ambos llevan el patrón normalizado. | Paper A → paper B (mismo patrón `/public/paper/:id`) no cuenta una vista; el emisor GA4 anterior contaba por `location.pathname`. |
| F5 | `worker/report-api.js:2057` | `/thread-anchor` acepta peticiones sin `Origin` (`if (origin && …)`) y no reserva cuota: cada miss son hasta tres lecturas REST con la cuenta de servicio, sin techo. | `curl` en bucle con ids distintos agota las 50k lecturas diarias del plan Spark en menos de una hora. |
| F6 | `worker/thread-anchor.js:166` | `runQuery(...).catch(() => [])` y `countQuery(...).catch(() => 0)` convierten un fallo de Firestore en un hilo vacío que además se cachea. | REST devuelve 503 → el lector ve «sin comentarios» durante el TTL, y el cliente no cae al camino de Firestore porque el Worker contestó 200. |
| F7 | `src/components/Onboarding/OnboardingFlow.jsx:172` | Si `createUserProfile` tiene éxito y `completeOnboarding` falla, el reintento vuelve a llamar a `createUserProfile` con el mismo handle. | La segunda llamada recibe `permission-denied` → `HandleUnavailableError` → «Ese handle ya está cogido» por su propio handle; el usuario no puede terminar. |
| F8 | `vercel.json` (rewrite) | `/:path((?!_vercel/).*)` reescribe también `/assets/*` a `index.html`, y `main.jsx` no maneja `vite:preloadError`. | Una pestaña abierta durante un despliegue pide un chunk con hash viejo, recibe HTML con 200, Vite lanza «Failed to fetch dynamically imported module» y la ruta no abre hasta que alguien recarga a mano. |
| F9 | `src/components/Lists/SaveToListModal.jsx:676` | `onClose={(event) => event.stopPropagation()}`: un cierre nativo del `<dialog>` que no pase por `closeDialog` no avisa al padre. | `App.jsx` sigue con `saveModalPaper` puesto: el diálogo está cerrado, el componente montado, y ninguna tarjeta puede volver a abrirlo. |
| F10 | `src/components/Profile/ProfilePage.jsx:675` | `unpublishProfile` limpia la caché de sesión (`forgetOwnProfile`) pero no la copia en `localStorage`; `hydrateAccountCaches` la vuelve a sembrar en la siguiente recarga y `warmAccountCaches` solo sobrescribe cuando hay perfil. | Despublicar → recargar → la cabecera muestra el perfil borrado; si la lectura de fondo falla, se queda. |

---

### Tarea 1: KV rechaza el TTL de los hilos vivos (F2)

**Files:**
- Modify: `worker/thread-anchor.js:47-49`
- Test: `worker/thread-anchor.test.js` (`memoryStore` en las líneas 19-35, y un test nuevo)

**Interfaces:**
- Produces: `memoryStore().put(key, value, options)` lanza si `options.expirationTtl < 60` — la Tarea 3 lo reutiliza.

- [ ] **Paso 1: endurecer el KV falso y escribir el test que falla**

En `worker/thread-anchor.test.js`, añade `THREAD_KV_THREAD_TTL_SECONDS` al import de `./thread-anchor.js` y sustituye el `put` de `memoryStore` por:

```js
    async put(key, value, options) {
      // Production KV refuses TTLs under a minute; the fake has to as well, or
      // a TTL that never caches anything passes every test.
      if (options?.expirationTtl !== undefined && options.expirationTtl < 60) {
        throw new Error(`Invalid expiration_ttl of ${options.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      data.set(key, value);
    },
```

Añade al final del fichero:

```js
test('a live thread is cached: its TTL clears the KV floor of 60 s', async () => {
  const store = memoryStore();
  await resolveThreadAnchorFromStore(
    [{ identity: DOI, key: DOI_KEY }],
    {
      store,
      admin: {
        batchGet: async () => [{ canonicalKey: DOI, title: 'A result' }],
        runQuery: async () => ([{
          id: 'c1',
          data: {
            authorUid: 'u1',
            authorHandle: 'alice',
            text: 'First',
            status: 'visible',
            createdAt: new Date('2026-08-31T10:00:00.000Z'),
          },
        }]),
        countQuery: async () => 1,
      },
    },
  );
  assert.ok(
    THREAD_KV_THREAD_TTL_SECONDS >= 60,
    `TTL ${THREAD_KV_THREAD_TTL_SECONDS} is under the KV floor`,
  );
  const cached = await store.get(threadKvKey(DOI_KEY), 'json');
  assert.equal(cached?.stubExists, true, 'the live thread never reached KV');
});
```

- [ ] **Paso 2: verificar que falla**

Run: `node --test worker/thread-anchor.test.js`
Expected: FAIL «TTL 20 is under the KV floor». Los demás tests del fichero siguen en verde (ninguno mira el store tras un `put` de hilo vivo).

- [ ] **Paso 3: subir el TTL al mínimo**

En `worker/thread-anchor.js`, sustituye las líneas 48-49 por:

```js
/**
 * A live thread is invalidated on write; this is only the missed-invalidation
 * net. 60 is KV's floor, not a choice: an `expirationTtl` under a minute is
 * rejected by production KV — the put throws, `writeCachedEntry` swallows it,
 * and no live thread is ever cached, so every open paid Firestore REST.
 */
export const THREAD_KV_THREAD_TTL_SECONDS = 60;
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test worker/thread-anchor.test.js`
Expected: PASS, todos.

- [ ] **Paso 5: commit**

```bash
git add worker/thread-anchor.js worker/thread-anchor.test.js
git commit -m "fix(worker): cachear los hilos vivos con el TTL mínimo que KV acepta

El TTL de 20 s estaba por debajo del mínimo de KV: el put fallaba en
producción, writeCachedEntry lo tragaba y cada apertura de un hilo con
comentarios pagaba las tres lecturas REST. El KV falso de los tests ahora
rechaza lo mismo que el real.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 2: un fallo de Firestore no es un hilo vacío (F6)

**Files:**
- Modify: `worker/thread-anchor.js:165-180` (`loadThreadPage`)
- Test: `worker/thread-anchor.test.js`

- [ ] **Paso 1: escribir el test que falla**

Al final de `worker/thread-anchor.test.js`:

```js
test('a Firestore failure is an error to fall back from, not an empty thread to cache', async () => {
  const store = memoryStore();
  const failing = {
    batchGet: async () => [{ canonicalKey: DOI, title: 'A result' }],
    runQuery: async () => { throw new Error('REST 503'); },
    countQuery: async () => 1,
  };
  await assert.rejects(
    resolveThreadAnchorFromStore([{ identity: DOI, key: DOI_KEY }], { store, admin: failing }),
    /REST 503/,
  );
  assert.equal(store.data.has(threadKvKey(DOI_KEY)), false, 'a failed read was cached as empty');

  const countFailing = {
    ...failing,
    runQuery: async () => [],
    countQuery: async () => { throw new Error('count 503'); },
  };
  await assert.rejects(
    resolveThreadAnchorFromStore([{ identity: DOI, key: DOI_KEY }], { store, admin: countFailing }),
    /count 503/,
  );
  assert.equal(store.data.has(threadKvKey(DOI_KEY)), false, 'a failed count was cached as zero');
});
```

- [ ] **Paso 2: verificar que falla**

Run: `node --test worker/thread-anchor.test.js`
Expected: FAIL en el primer `assert.rejects` («Missing expected rejection»): hoy la promesa resuelve con un hilo vacío.

- [ ] **Paso 3: dejar que el error suba**

En `worker/thread-anchor.js`, `loadThreadPage` queda así:

```js
async function loadThreadPage(admin, identity, key) {
  // No catch here on purpose. A REST failure has to reach the route as an
  // error: the browser treats anything but a 200 as "read Firestore yourself",
  // which is the path this cache replaced. Swallowing it served an empty
  // thread — and cached it — for as long as the TTL lasted.
  const [comments, rawCount] = await Promise.all([
    admin.runQuery({
      parentSegments: ['papers', key],
      collectionId: 'comments',
      orderByField: 'createdAt',
      orderDirection: 'ASCENDING',
      limit: THREAD_PAGE_SIZE,
    }),
    admin.countQuery({
      parentSegments: ['papers', key],
      collectionId: 'comments',
      limit: THREAD_COUNT_CAP,
    }),
  ]);
  const rows = Array.isArray(comments) ? comments : [];
  const serialized = rows.map(serializeComment).filter(Boolean);
  const count = Number.isFinite(rawCount) ? Math.max(0, Math.trunc(rawCount)) : serialized.length;
  return {
    identity,
    key,
    stubExists: true,
    comments: serialized,
    hasMore: serialized.length >= THREAD_PAGE_SIZE,
    count: Math.min(count, THREAD_COUNT_CAP),
    capped: count >= THREAD_COUNT_CAP,
  };
}
```

`threadAnchorErrorResponse` ya convierte un `Error` genérico en `502 THREAD_ANCHOR_UNAVAILABLE` y un `FirestoreAdminError` en su propio estado; `report-api.js` lo registra con `console.error('Thread anchor failed', …)`. El cliente (`CommentsSheet.loadThread`) cae a `resolveThreadAnchor` + `fetchThreadPage` ante cualquier rechazo. No hay nada más que tocar.

- [ ] **Paso 4: verificar que pasa**

Run: `node --test worker/thread-anchor.test.js`
Expected: PASS.

- [ ] **Paso 5: commit**

```bash
git add worker/thread-anchor.js worker/thread-anchor.test.js
git commit -m "fix(worker): un fallo de Firestore en /thread-anchor ya no se cachea como hilo vacío

runQuery y countQuery tragaban el error y devolvían [] y 0, que se
guardaban en KV. Ahora el fallo llega a la ruta como 502/503 y el navegador
cae al camino de Firestore, que es lo que esta caché sustituye.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 3: `/thread-anchor` exige `Origin` y reserva cuota antes de Firestore (F5)

**Files:**
- Modify: `worker/thread-anchor.js` (import, constante, `threadQuotaFromEnv`, `reserveFirestoreMiss`, `resolveThreadAnchorFromStore`, `handleThreadAnchorRequest`, `threadAnchorErrorResponse`)
- Modify: `worker/report-api.js:2057-2062`
- Modify: `wrangler.toml:73` (tras `S2_GLOBAL_MINUTE_LIMIT`)
- Modify: `worker/README.md:61`
- Test: `worker/thread-anchor.test.js`, `worker/report-api.test.js:2151-2167`

**Interfaces:**
- Consumes: `reserveRequestQuota(namespace, { periodKey, subject, subjectLimit, globalLimit })` de `worker/request-quota-ledger.js` → `{ accepted, code? }`; `memoryStore` endurecido de la Tarea 1.
- Produces: `threadQuotaFromEnv(env) → { ledger, limit }`; `resolveThreadAnchorFromStore(identities, { admin, store, quota })`; `THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT`; error `THREAD_ANCHOR_RATE_LIMITED` (429, `retry-after: 60`).

- [ ] **Paso 1: escribir los tests que fallan**

En `worker/thread-anchor.test.js`, amplía el import de `./thread-anchor.js` con `THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT`, `ThreadAnchorError`, `threadAnchorErrorResponse`, `threadQuotaFromEnv`. Añade tras `memoryStore`:

```js
function fakeLedger(accepted = true) {
  const reservations = [];
  return {
    reservations,
    idFromName: name => String(name),
    get: () => ({
      fetch: async (_url, options) => {
        reservations.push(JSON.parse(options.body));
        return new Response(JSON.stringify(accepted
          ? { accepted: true }
          : { accepted: false, scope: 'global' }));
      },
    }),
  };
}
```

Y al final del fichero:

```js
test('a miss reserves one shared minute slot before Firestore; a hit reserves nothing', async () => {
  const ledger = fakeLedger(true);
  const store = memoryStore();
  const admin = { batchGet: async () => [null], runQuery: async () => [], countQuery: async () => 0 };
  const quota = { ledger, limit: 120 };
  await resolveThreadAnchorFromStore([{ identity: DOI, key: DOI_KEY }], { store, admin, quota });
  assert.equal(ledger.reservations.length, 1);
  assert.equal(ledger.reservations[0].globalLimit, 120);
  await resolveThreadAnchorFromStore([{ identity: DOI, key: DOI_KEY }], { store, admin, quota });
  assert.equal(ledger.reservations.length, 1, 'a KV hit must not spend the ledger');
});

test('an exhausted minute is a 429 with retry-after, and Firestore is never asked', async () => {
  const ledger = fakeLedger(false);
  let asked = 0;
  const admin = {
    batchGet: async () => { asked += 1; return [null]; },
    runQuery: async () => [],
    countQuery: async () => 0,
  };
  await assert.rejects(
    resolveThreadAnchorFromStore(
      [{ identity: DOI, key: DOI_KEY }],
      { store: memoryStore(), admin, quota: { ledger, limit: 1 } },
    ),
    error => error.code === 'THREAD_ANCHOR_RATE_LIMITED' && error.status === 429,
  );
  assert.equal(asked, 0);
  const response = threadAnchorErrorResponse(new ThreadAnchorError('THREAD_ANCHOR_RATE_LIMITED', 429));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
});

test('the minute ceiling comes from env with a bounded default', () => {
  assert.equal(threadQuotaFromEnv({}).limit, THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT);
  assert.equal(threadQuotaFromEnv({ THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT: '30' }).limit, 30);
  assert.equal(threadQuotaFromEnv({ THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT: 'lots' }).limit, THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT);
  assert.equal(threadQuotaFromEnv({ THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT: '0' }).limit, 1);
  assert.equal(threadQuotaFromEnv({ REQUEST_QUOTA_LEDGER: 'ledger' }).ledger, 'ledger');
  assert.equal(threadQuotaFromEnv({}).ledger, null);
});
```

En `worker/report-api.test.js`, dentro de `test('the thread-anchor route is origin-gated and public', …)`, antes de `const allowed = …`:

```js
  // No Origin at all is not one of our browsers: a cross-origin fetch always
  // carries it, and the API host has no same-origin page. Refusing it keeps a
  // script from draining Firestore through the service account.
  const anonymous = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor?ids=doi:10.1234/abc',
  ), {});
  assert.equal(anonymous.status, 403);
  assert.equal((await anonymous.json()).code, 'ORIGIN_NOT_ALLOWED');

  const anonymousInvalidate = await reportApi.fetch(new Request(
    'https://papertok-report-api.example/thread-anchor/invalidate',
    { method: 'POST', body: '{"keys":["k"]}' },
  ), {});
  assert.equal(anonymousInvalidate.status, 403);
```

- [ ] **Paso 2: verificar que fallan**

Run: `node --test worker/thread-anchor.test.js worker/report-api.test.js`
Expected: FAIL. En `thread-anchor.test.js`, los tres tests nuevos fallan en el import (`threadQuotaFromEnv` no existe → `SyntaxError: The requested module does not provide an export`). En `report-api.test.js`, «origin-gated and public» falla con `403 !== …`: la petición sin `Origin` hoy devuelve 503.

- [ ] **Paso 3: implementar el techo y el cierre de origen**

En `worker/thread-anchor.js`, junto a los imports:

```js
import { reserveRequestQuota } from './request-quota-ledger.js';
```

Tras `THREAD_KV_THREAD_TTL_SECONDS`:

```js
/**
 * Firestore REST misses a minute, shared by every caller. A KV hit costs KV
 * only and is not counted. Each miss is up to three reads per identity (stub,
 * first page, count) against the service account — nothing the rules meter —
 * so the ceiling is global, like OpenAlex's, and reserved only when KV had
 * nothing. 120 misses a minute is 360 reads a minute at worst: an audience
 * opening new threads, not a script draining the daily Spark allowance.
 */
export const THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT = 120;

export function threadQuotaFromEnv(env) {
  const parsed = Number.parseInt(env?.THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT, 10);
  const limit = Number.isInteger(parsed)
    ? Math.max(1, Math.min(100_000, parsed))
    : THREAD_FIRESTORE_MINUTE_LIMIT_DEFAULT;
  return { ledger: env?.REQUEST_QUOTA_LEDGER || null, limit };
}

async function reserveFirestoreMiss(quota) {
  if (!quota) return;
  const minute = new Date().toISOString().slice(0, 16);
  const reservation = await reserveRequestQuota(quota.ledger, {
    periodKey: `thread:${minute}`,
    subject: 'thread:shared',
    subjectLimit: quota.limit,
    globalLimit: quota.limit,
  });
  // No ledger bound is a deploy mistake, and the safe answer to one is the
  // same 503 the browser already treats as "read Firestore yourself".
  if (!reservation.accepted && reservation.code) {
    throw new ThreadAnchorError('THREAD_ANCHOR_UNAVAILABLE', 503);
  }
  if (!reservation.accepted) throw new ThreadAnchorError('THREAD_ANCHOR_RATE_LIMITED', 429);
}
```

En `resolveThreadAnchorFromStore`, la firma pasa a `(identities, { admin, store, quota = null })` y la rama de miss empieza por la reserva:

```js
  if (missing.length && admin) {
    await reserveFirestoreMiss(quota);
    const stubs = await admin.batchGet(missing.map(index => ['papers', identities[index].key]));
```

En `handleThreadAnchorRequest`:

```js
  const payload = await resolveThreadAnchorFromStore(identities, {
    admin,
    store,
    quota: threadQuotaFromEnv(env),
  });
```

En `threadAnchorErrorResponse`, la última línea:

```js
  return json({ code }, status, {
    ...cors,
    'cache-control': 'no-store',
    ...(status === 429 ? { 'retry-after': '60' } : {}),
  });
```

En `worker/report-api.js:2057-2062`:

```js
    if (url.pathname === '/thread-anchor' || url.pathname === '/thread-anchor/invalidate') {
      // Public comments: a guest can open a thread, so this is origin-gated
      // rather than session-gated — and `Origin` is required, not optional:
      // every fetch from the app is cross-origin and carries it, and a request
      // without one is not a browser of ours. Invalidation still requires a
      // Firebase identity because it is a write against the shared cache.
      if (!origin || !allowedOrigins(env).has(origin)) {
        return json({ code: 'ORIGIN_NOT_ALLOWED' }, 403, { 'cache-control': 'no-store' });
      }
```

En `wrangler.toml`, tras `S2_GLOBAL_MINUTE_LIMIT = "60"`:

```toml
# Firestore REST misses of /thread-anchor a minute, global: a KV hit is free
# and not counted, and each miss is up to three service-account reads per
# identity, which no Firestore rule meters.
THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT = "120"
```

En `worker/README.md`, tras el párrafo que termina en «so N tabs were N times the limit.»:

```markdown
`/thread-anchor` takes the same trade for the comments sheet: origin gate (`Origin` required — the
API host has no same-origin page), KV as the cache, and a **global** per-minute ceiling on Firestore
REST misses only (`THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT`, default 120). A hit costs KV and nothing else.
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test worker/thread-anchor.test.js worker/report-api.test.js`
Expected: PASS. Comprueba también `npm run worker:deploy:dry-run` (la variable nueva no rompe el bundle).

- [ ] **Paso 5: commit**

```bash
git add worker/thread-anchor.js worker/thread-anchor.test.js worker/report-api.js worker/report-api.test.js wrangler.toml worker/README.md
git commit -m "fix(worker): /thread-anchor exige Origin y reserva un techo por minuto antes de Firestore

Sin Origin la ruta contestaba igual, y cada miss eran hasta tres lecturas
REST con la cuenta de servicio sin ningún techo. Ahora un miss reserva un
hueco global por minuto (THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT, 120) y un hit
de KV sigue siendo gratis; agotado el minuto, 429 con retry-after.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 4: las páginas del Worker traen cursor y el hilo pagina (F1)

**Files:**
- Modify: `src/services/threadAnchorClient.js:55-62` (`normalizeThreadAnchorPayload`)
- Create: `src/utils/threadRows.js`
- Create: `src/utils/threadRows.test.js`
- Modify: `src/components/Comments/CommentsSheet.jsx:513-516` (`loadMore`) e import
- Modify: `src/services/commentService.js:213-218` (solo comentario)
- Test: `src/services/threadAnchorClient.test.js`

**Interfaces:**
- Produces: `appendNewRows(previous, fresh) → rows` (mismo array si no hay nada nuevo); `normalizeThreadAnchorPayload` devuelve `pages[].cursor` como `Date` cuando `hasMore`.
- Consumes: `fetchThreadPage(key, { cursor })` acepta el `Date` porque `startAfter` del SDK admite valores de campo además de snapshots.

- [ ] **Paso 1: escribir los tests que fallan**

En `src/services/threadAnchorClient.test.js`, tras el test «the Worker payload becomes the sheet's…»:

```js
test('a full first page from the Worker carries a cursor the sheet can page from', () => {
  const comments = Array.from({ length: 20 }, (unused, index) => ({
    id: `c${index}`,
    authorUid: 'u1',
    authorHandle: 'alice',
    text: String(index),
    status: 'visible',
    createdAt: `2026-08-31T12:00:${String(index).padStart(2, '0')}.000Z`,
  }));
  const full = normalizeThreadAnchorPayload({
    identity: DOI, key: KEY, stubExists: true, alternates: [],
    pages: [{ key: KEY, hasMore: true, comments }],
    count: { count: 45, capped: false },
  });
  assert.deepEqual(full.pages[0].cursor, new Date('2026-08-31T12:00:19.000Z'));

  const short = normalizeThreadAnchorPayload({
    identity: DOI, key: KEY, stubExists: true, alternates: [],
    pages: [{ key: KEY, hasMore: false, comments: comments.slice(0, 3) }],
    count: { count: 3, capped: false },
  });
  assert.equal(short.pages[0].cursor, null);
});

test('SOURCE: paging appends by id, because a value cursor can hand back its own comment', async () => {
  const { readFile } = await import('node:fs/promises');
  const sheet = await readFile(new URL('../components/Comments/CommentsSheet.jsx', import.meta.url), 'utf8');
  assert.match(sheet, /appendNewRows\(previous, fresh\)/);
});
```

(El import dinámico de `readFile` dentro del test es la convención de este fichero: sus dos tests SOURCE de las líneas 94-101 lo hacen así y no hay import estático arriba.)

Crea `src/utils/threadRows.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNewRows } from './threadRows.js';

test('paging appends only the rows the sheet does not already show', () => {
  const previous = [{ id: 'a' }, { id: 'b' }];
  const fresh = [{ id: 'b', text: 'again' }, { id: 'c' }];
  const merged = appendNewRows(previous, fresh);
  assert.deepEqual(merged.map(row => row.id), ['a', 'b', 'c']);
  assert.equal(merged[1], previous[1], 'the row already on screen keeps its object');
  assert.equal(appendNewRows(previous, [{ id: 'a' }]), previous, 'nothing new returns the same array');
});
```

- [ ] **Paso 2: verificar que fallan**

Run: `node --test src/services/threadAnchorClient.test.js src/utils/threadRows.test.js`
Expected: FAIL. `threadRows.test.js` no encuentra el módulo (`ERR_MODULE_NOT_FOUND`); «a full first page…» falla con `null` frente al `Date`; el SOURCE falla porque `CommentsSheet.jsx` no contiene `appendNewRows`.

- [ ] **Paso 3: implementar**

Crea `src/utils/threadRows.js`:

```js
/**
 * Appends a page of thread rows to the ones on screen, by id.
 *
 * A page fetched from a value cursor — the Worker hands the sheet the last
 * comment's createdAt at millisecond precision, while Firestore keeps
 * microseconds — can begin with the comment the cursor was made from. React
 * keys are ids, and a duplicated key is a duplicated comment on screen.
 */
export function appendNewRows(previous, fresh) {
  const seen = new Set(previous.map(row => row.id));
  const additions = fresh.filter(row => !seen.has(row.id));
  return additions.length ? [...previous, ...additions] : previous;
}
```

En `src/services/threadAnchorClient.js`, el `map` de páginas de `normalizeThreadAnchorPayload`:

```js
  const pages = (Array.isArray(payload.pages) ? payload.pages : []).map(page => {
    const comments = (Array.isArray(page.comments) ? page.comments : [])
      .map(row => hydrateComment(row, page.key))
      .filter(Boolean);
    const last = comments[comments.length - 1];
    return {
      key: page.key,
      comments,
      // `startAfter` takes a field value as readily as a snapshot, so the last
      // comment's createdAt is the cursor `fetchThreadPage` pages from. Without
      // it the sheet's `loadMore` — `hasMore && cursor` — never paged a thread
      // the Worker had served.
      cursor: page.hasMore === true && last?.createdAt instanceof Date ? last.createdAt : null,
      hasMore: page.hasMore === true,
    };
  });
```

En `src/components/Comments/CommentsSheet.jsx`: importa `appendNewRows` desde `'../../utils/threadRows.js'` (junto a `commentMillis`) y en `loadMore` sustituye

```js
      setRows(previous => [...previous, ...fresh]);
```

por

```js
      setRows(previous => appendNewRows(previous, fresh));
```

En `src/services/commentService.js`, `defaultReadThreadPage`, encima de `...(cursor ? [startAfter(cursor)] : [])`:

```js
    // `cursor` is a DocumentSnapshot from a previous SDK page, or a Date — the
    // last createdAt of a page the Worker served. `startAfter` takes both.
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/services/threadAnchorClient.test.js src/utils/threadRows.test.js src/services/commentService.test.js`
Expected: PASS, incluido «SOURCE: nothing on the feed path imports any social service» (el helper vive en `utils/` y solo lo importa la hoja).

- [ ] **Paso 5: commit**

```bash
git add src/utils/threadRows.js src/utils/threadRows.test.js src/services/threadAnchorClient.js src/services/threadAnchorClient.test.js src/components/Comments/CommentsSheet.jsx src/services/commentService.js
git commit -m "fix(comentarios): las páginas que sirve el Worker traen cursor y el hilo pagina de verdad

normalizeThreadAnchorPayload dejaba cursor: null con hasMore: true, y
loadMore filtra por cursor, así que un hilo abierto vía edge se quedaba en
20. El cursor es el createdAt del último comentario (startAfter admite
valores), y la página siguiente se funde por id porque el Worker serializa
a milisegundos.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 5: una vista por cada cambio de ruta, no solo de patrón (F4)

**Files:**
- Modify: `src/context/AnalyticsContext.jsx`
- Create: `src/context/analyticsPageviews.test.js`

**Interfaces:**
- Consumes: `pageview({ route, path })` exportado por `@vercel/analytics` (el paquete genérico; `@vercel/analytics/react` solo exporta `Analytics` y `track`). Encola en `window.va`, que `<Analytics>` define en su efecto de inyección; los efectos del hijo corren antes que los del padre en el mismo commit, así que la cola existe cuando el proveedor emite.

- [ ] **Paso 1: escribir el test que falla**

Crea `src/context/analyticsPageviews.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AnalyticsContext.jsx', import.meta.url);

test('SOURCE: a page view is sent on every pathname change, not only when the pattern changes', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // Two papers share the pattern `/public/paper/:id`. Keyed on the pattern,
  // the second one was never a page view; keyed on the pathname it is, and
  // what travels is still only the pattern.
  const tag = source.match(/<Analytics[\s\S]*?\/>/);
  assert.ok(tag, 'the <Analytics /> tag is gone');
  assert.doesNotMatch(tag[0], /\bpath=/, '<Analytics path> re-emits on pattern change only');
  assert.match(tag[0], /\broute=/, 'route= is what disables the script\'s own tracking');
  assert.match(source, /import \{ pageview \} from '@vercel\/analytics';/);
  assert.match(
    source,
    /pageview\(\{ route: viewPath, path: viewPath \}\);\s*\}, \[consent, location\.pathname\]\);/,
  );
});
```

- [ ] **Paso 2: verificar que falla**

Run: `node --test src/context/analyticsPageviews.test.js`
Expected: FAIL en `doesNotMatch(/\bpath=/)`: la etiqueta actual lleva `path={analyticsPath}`.

- [ ] **Paso 3: mover la emisión al proveedor**

En `src/context/AnalyticsContext.jsx`:

Import nuevo, junto al de `@vercel/analytics/react`:

```js
import { pageview } from '@vercel/analytics';
```

Sustituye el comentario y el efecto de `trackDay7Return` (líneas 41-47) por:

```js
  // Page views are sent from here, keyed on the concrete pathname, and report
  // only the pattern. <Analytics route> below is what flips `disableAutoTrack`
  // on the injected script; its own `path` prop is deliberately not passed,
  // because that emitter re-fires on a change of PATTERN, and two papers share
  // one — the second was never a view.
  //
  // `route` and `path` carry the SAME normalized value on purpose. Vercel reads
  // `route` as the pattern and `path` as the concrete URL that matched it, but
  // the concrete URL is the one thing that must not travel: the privacy policy
  // promises that reading a paper is reported as `/public/paper/:id` and never
  // says which.
  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    const viewPath = normalizeAnalyticsPath(location.pathname);
    pageview({ route: viewPath, path: viewPath });
  }, [consent, location.pathname]);

  useEffect(() => {
    if (consent !== ANALYTICS_CONSENT.GRANTED) return;
    trackDay7Return();
  }, [consent, location.pathname]);
```

Sustituye el bloque de comentario sobre `analyticsPath` (líneas 63-73) y la etiqueta por:

```js
  // Passing `route` is what makes this work under HashRouter: it flips
  // `disableAutoTrack` on the injected script, whose own tracking reads
  // `location.pathname` — `/` for every route in this app, since the route
  // lives in the fragment. The views themselves are emitted above.
  const analyticsPath = normalizeAnalyticsPath(location.pathname);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
      {consent === ANALYTICS_CONSENT.GRANTED ? (
        <Analytics
          mode={import.meta.env.DEV ? 'development' : 'production'}
          route={analyticsPath}
          beforeSend={sanitizeOutgoingEvent}
        />
      ) : null}
    </AnalyticsContext.Provider>
  );
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/context/analyticsPageviews.test.js src/services/analyticsService.test.js && npx eslint src/context/AnalyticsContext.jsx`
Expected: PASS y sin avisos de `react-hooks/exhaustive-deps` (`location.pathname` se lee dentro del efecto).

- [ ] **Paso 5: commit**

```bash
git add src/context/AnalyticsContext.jsx src/context/analyticsPageviews.test.js
git commit -m "fix(analytics): contar una vista por cada cambio de ruta, no solo por cambio de patrón

<Analytics route path> reemite solo cuando cambian sus props, y ambas
llevaban el patrón normalizado: paper A → paper B no contaba. La vista se
emite desde el proveedor por pathname y sigue viajando solo el patrón.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 6: el recuerdo local del onboarding no tapa un perfil que no cargó (F3)

**Files:**
- Create: `src/utils/followedAuthors.js`
- Create: `src/utils/followedAuthors.test.js`
- Create: `src/context/authProfileLoad.test.js`
- Modify: `src/context/AuthContext.jsx:12` (import), `:131-142` (rama remota), `:279-297` (`toggleFollowAuthor`)

**Interfaces:**
- Produces: `toggleFollowedAuthor(followed, authorName, { union, remove }) → { next, patch }`.
- Consumes: `arrayUnion`, `arrayRemove` de `firebase/firestore`; `saveStoredOnboarding(uid, { complete: false, preferences: [] })` borra la clave (ya implementado en `userScopedStorage.js`).

- [ ] **Paso 1: escribir los tests que fallan**

Crea `src/utils/followedAuthors.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFollowedAuthor } from './followedAuthors.js';

const transforms = {
  union: name => ({ op: 'union', name }),
  remove: name => ({ op: 'remove', name }),
};

test('following adds locally and sends a union, never the whole array', () => {
  const result = toggleFollowedAuthor(['Ada'], 'Grace', transforms);
  assert.deepEqual(result.next, ['Ada', 'Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'union', name: 'Grace' } });
});

test('unfollowing removes locally and sends a remove', () => {
  const result = toggleFollowedAuthor(['Ada', 'Grace'], 'Ada', transforms);
  assert.deepEqual(result.next, ['Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'remove', name: 'Ada' } });
});
```

Crea `src/context/authProfileLoad.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('./AuthContext.jsx', import.meta.url);

test('SOURCE: a remembered onboarding never stands in for a profile that failed to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  // The device flag decides the first paint while the read is in flight, and
  // nothing else: a failed read is PROFILE_LOAD_FAILED and a missing document
  // is an account without onboarding, whatever this device remembers. Opening
  // the app on an empty followedAuthors is what turned the next follow into an
  // overwrite of the whole list.
  assert.doesNotMatch(source, /!storedOnboarding\?\.complete/);
  assert.match(
    source,
    /if \(!applyProfile\(remote\.value\)\) \{\s*setOnboardingComplete\(false\);\s*saveStoredOnboarding\(currentUser\.uid, \{ complete: false, preferences: \[\] \}\);/,
  );
  assert.match(source, /\} else if \(!hydratedFromCache\) \{\s*setProfileLoadError\('PROFILE_LOAD_FAILED'\);/);
});

test('SOURCE: a follow toggle writes a field transform, not the list this session happened to load', async () => {
  const source = await readFile(SOURCE, 'utf8');
  assert.match(source, /toggleFollowedAuthor\(followedAuthors, authorName\)/);
  assert.doesNotMatch(source, /followedAuthors: newFollowed/);
});
```

- [ ] **Paso 2: verificar que fallan**

Run: `node --test src/utils/followedAuthors.test.js src/context/authProfileLoad.test.js`
Expected: FAIL. `followedAuthors.test.js`: `ERR_MODULE_NOT_FOUND`. `authProfileLoad.test.js`: `doesNotMatch(/!storedOnboarding\?\.complete/)` falla (aparece dos veces) y el segundo test falla en `toggleFollowedAuthor(`.

- [ ] **Paso 3: implementar**

Crea `src/utils/followedAuthors.js`:

```js
import { arrayRemove, arrayUnion } from 'firebase/firestore';

/**
 * One follow toggle: the next local list, and the write that expresses it.
 *
 * The write is a field transform, not the array. The local list is whatever
 * this session managed to read — empty after a profile read that failed or
 * timed out — and writing it whole would replace every author the account
 * follows with the one it just tapped.
 */
export function toggleFollowedAuthor(followed, authorName, { union = arrayUnion, remove = arrayRemove } = {}) {
  const following = followed.includes(authorName);
  return {
    next: following ? followed.filter(name => name !== authorName) : [...followed, authorName],
    patch: { followedAuthors: following ? remove(authorName) : union(authorName) },
  };
}
```

En `src/context/AuthContext.jsx`, añade el import:

```js
import { toggleFollowedAuthor } from '../utils/followedAuthors.js';
```

Sustituye la rama remota (líneas 131-142) por:

```js
        if (remote.status === 'fulfilled') {
          // The server is the authority on whether the document exists. A
          // remembered onboarding only decided the paint while this read was
          // in flight; it does not get to overrule a missing document.
          if (!applyProfile(remote.value)) {
            setOnboardingComplete(false);
            saveStoredOnboarding(currentUser.uid, { complete: false, preferences: [] });
          }
        } else if (!hydratedFromCache) {
          setProfileLoadError('PROFILE_LOAD_FAILED');
          if (remote.status === 'rejected') {
            console.error('Error fetching user data', remote.reason);
          } else {
            console.warn('Profile loading exceeded the timeout');
          }
        }
```

Sustituye `toggleFollowAuthor` (líneas 279-297) por:

```js
  const toggleFollowAuthor = useCallback(async (authorName) => {
    const { next, patch } = toggleFollowedAuthor(followedAuthors, authorName);
    setFollowedAuthors(next);

    if (IS_DEMO) {
      demoSet('followedAuthors', next);
      return;
    }

    const userId = user?.uid;
    if (userId) {
      await setDoc(doc(db, 'users', userId), patch, { merge: true });
    }
  }, [followedAuthors, user?.uid]);
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/utils/followedAuthors.test.js src/context/authProfileLoad.test.js src/services/accountWarmup.test.js src/components/Onboarding/OnboardingFlow.test.js && npx eslint src/context/AuthContext.jsx`
Expected: PASS (el SOURCE de `accountWarmup.test.js` sigue viendo `readStoredOnboarding` y `accountLooksOnboarded`).

- [ ] **Paso 5: commit**

```bash
git add src/utils/followedAuthors.js src/utils/followedAuthors.test.js src/context/authProfileLoad.test.js src/context/AuthContext.jsx
git commit -m "fix(auth): el recuerdo local del onboarding no tapa un perfil que no cargó, y seguir a un autor ya no pisa la lista

Con el flag guardado, una lectura fallida abría la app sin error y con
followedAuthors vacío, y el siguiente follow escribía ese array entero.
La lectura fallida vuelve a ser PROFILE_LOAD_FAILED, un documento ausente
vuelve a ser onboarding, y el follow escribe arrayUnion/arrayRemove.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 7: reintentar el onboarding no reclama el handle dos veces (F7)

**Files:**
- Modify: `src/components/Onboarding/OnboardingFlow.jsx:1` (import `useRef`), `:65` (ref), `:165-181` (`handleFinish`)
- Test: `src/components/Onboarding/OnboardingFlow.test.js`

- [ ] **Paso 1: escribir el test que falla**

Al final de `src/components/Onboarding/OnboardingFlow.test.js`:

```js
test('SOURCE: a retry after a failed completeOnboarding does not claim the handle twice', async () => {
  const source = await readFile(new URL('./OnboardingFlow.jsx', import.meta.url), 'utf8');
  // createUserProfile succeeded, completeOnboarding failed, the reader taps
  // again: the second createUserProfile hits its own reservation, the rules
  // refuse it, and the error reads "that handle is taken" — by them.
  assert.match(source, /const profileCreated = useRef\(false\);/);
  assert.match(
    source,
    /if \(!existingProfile && !profileCreated\.current && visibilityDraft === PROFILE_VISIBILITY\.public\)/,
  );
  assert.match(source, /await createUserProfile\(\{[\s\S]*?\}\);\s*profileCreated\.current = true;/);
});
```

- [ ] **Paso 2: verificar que falla**

Run: `node --test src/components/Onboarding/OnboardingFlow.test.js`
Expected: FAIL en `const profileCreated = useRef(false);`.

- [ ] **Paso 3: recordar que el perfil ya existe**

En `src/components/Onboarding/OnboardingFlow.jsx`:

Línea 1:

```js
import { useEffect, useMemo, useRef, useState } from 'react';
```

Tras `const [existingProfile, setExistingProfile] = useState(false);`:

```js
  // Set the moment createUserProfile succeeds. A retry after a failed
  // completeOnboarding must skip the create: the handle is already this
  // account's, and a second create hits its own reservation as "taken".
  const profileCreated = useRef(false);
```

En `handleFinish`, la condición y el bloque de creación:

```js
      if (!existingProfile && !profileCreated.current && visibilityDraft === PROFILE_VISIBILITY.public) {
        if (!handleCheck.valid || !resolvedDisplayName) {
          setSaving(false);
          return;
        }
        await createUserProfile({
          handle: handleCheck.handle,
          displayName: resolvedDisplayName,
          bio: '',
          allowContact: false,
          photo: '',
          visibility: PROFILE_VISIBILITY.public,
        });
        profileCreated.current = true;
      }
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/components/Onboarding/OnboardingFlow.test.js && npx eslint src/components/Onboarding/OnboardingFlow.jsx`
Expected: PASS.

- [ ] **Paso 5: commit**

```bash
git add src/components/Onboarding/OnboardingFlow.jsx src/components/Onboarding/OnboardingFlow.test.js
git commit -m "fix(onboarding): reintentar tras un fallo al guardar no vuelve a reclamar el handle

Si createUserProfile tenía éxito y completeOnboarding fallaba, el
reintento volvía a crear el perfil, las rules lo rechazaban y el aviso
decía que el handle estaba cogido: por él mismo.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 8: un cierre nativo del modal de guardar avisa al padre una vez (F9)

**Files:**
- Modify: `src/components/Lists/SaveToListModal.jsx:165` (ref nueva), `:399-412` (`closeDialog`), `:676` (`onClose`)
- Test: `src/components/Lists/saveModalMotion.test.js:52-60`

- [ ] **Paso 1: reescribir el test para que falle**

En `src/components/Lists/saveModalMotion.test.js`, sustituye las tres últimas líneas del test «every close path still funnels through the unsaved-changes guard» (el comentario «Native `onClose` used to unmount…» y su `assert.match`) por:

```js
  // A native `close` this component did not issue — a `dialog.close()` from
  // elsewhere, or the browser's own dismissal — has to reach the parent, or the
  // window is gone while `saveModalPaper` still says it is open and no card
  // can reopen it. A close this component issued must NOT reach it twice.
  assert.match(jsx, /onClose=\{handleNativeClose\}/);
  assert.match(
    jsx,
    /const handleNativeClose = \(event\) => \{\s*event\.stopPropagation\(\);\s*if \(closedByScript\.current\) \{\s*closedByScript\.current = false;\s*return;\s*\}\s*onClose\(\);\s*\};/,
  );
  assert.match(
    jsx,
    /const closeNative = \(\) => \{\s*closedByScript\.current = true;\s*dialogRef\.current\?\.close\(\);\s*\};/,
  );
  const scriptedCloses = jsx.match(/dialogRef\.current\?\.close\(\)/g) ?? [];
  assert.equal(scriptedCloses.length, 1, 'every scripted close goes through closeNative()');
```

- [ ] **Paso 2: verificar que falla**

Run: `node --test src/components/Lists/saveModalMotion.test.js`
Expected: FAIL en `onClose={handleNativeClose}`.

- [ ] **Paso 3: implementar**

En `src/components/Lists/SaveToListModal.jsx`, tras `const closeTimer = useRef(null);`:

```js
  // True between a `dialog.close()` this component issued and the native
  // `close` event it produces. `closeDialog` tells the parent itself, once;
  // the flag is how `handleNativeClose` knows not to tell it again.
  const closedByScript = useRef(false);
```

Sustituye `closeDialog` (líneas 399-412) por:

```js
  const closeNative = () => {
    closedByScript.current = true;
    dialogRef.current?.close();
  };

  // A native `close` the component did not issue: Escape when `onCancel` was
  // not fired, a `close()` from outside, a form with method="dialog". The
  // parent has to hear about it, or `saveModalPaper` stays set on a window
  // that is no longer there.
  const handleNativeClose = (event) => {
    event.stopPropagation();
    if (closedByScript.current) {
      closedByScript.current = false;
      return;
    }
    onClose();
  };

  const closeDialog = () => {
    if (closeTimer.current) return;
    if (prefersReducedMotion) {
      closeNative();
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      closeNative();
      onClose();
      setClosing(false);
    }, DIALOG_EXIT_MS);
  };
```

Y en el JSX, la prop del `<dialog>`:

```jsx
      onClose={handleNativeClose}
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/components/Lists/saveModalMotion.test.js src/services/accountWarmup.test.js && npx eslint src/components/Lists/SaveToListModal.jsx`
Expected: PASS.

- [ ] **Paso 5: commit**

```bash
git add src/components/Lists/SaveToListModal.jsx src/components/Lists/saveModalMotion.test.js
git commit -m "fix(listas): un cierre nativo del modal de guardar avisa al padre una sola vez

onClose del <dialog> solo paraba la propagación: un cierre que no pasara
por closeDialog dejaba a App con saveModalPaper puesto y ninguna tarjeta
podía volver a abrirlo. Los cierres propios se marcan para no avisar dos
veces.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 9: despublicar borra la copia del dispositivo y una ausencia confirmada no la resucita (F10)

**Files:**
- Modify: `src/utils/userScopedStorage.js` (nueva `clearStoredProfile`, tras `saveStoredProfile`)
- Modify: `src/services/accountWarmup.js:55-75` (`warmAccountCaches`)
- Modify: `src/components/Profile/ProfilePage.jsx` (import y `unpublishProfile`, línea 675)
- Test: `src/utils/userScopedStorage.test.js`, `src/services/accountWarmup.test.js`

**Interfaces:**
- Produces: `clearStoredProfile(userId, storage)`; `warmAccountCaches(uid, { storage, readProfile, readLists })` con inyección para tests.
- Consumes: `rememberOwnProfile(uid, null)` guarda `{ profile: null }` («esta cuenta no tiene perfil», distinto de «no preguntado»).

- [ ] **Paso 1: escribir los tests que fallan**

En `src/utils/userScopedStorage.test.js`, añade `clearStoredProfile` al import y, tras el test «the owner public profile is remembered without its photo»:

```js
test('clearing the remembered profile leaves the rest of the device state alone', () => {
  const storage = listStore();
  saveStoredProfile('uid-p2', { uid: 'uid-p2', handle: 'bob', displayName: 'Bob' }, storage);
  saveStoredLists('uid-p2', [{ id: 'l1', name: 'Notes', paperIds: ['p1'] }], storage);
  clearStoredProfile('uid-p2', storage);
  assert.equal(readStoredProfile('uid-p2', storage), null);
  assert.equal(readStoredLists('uid-p2', storage)?.[0]?.id, 'l1');
  clearStoredProfile('uid-p2', null);
});
```

En `src/services/accountWarmup.test.js`, amplía los imports: `warmAccountCaches` desde `./accountWarmup.js`, `readStoredProfile` desde `../utils/userScopedStorage.js`. Añade:

```js
function deviceStorage() {
  return {
    map: new Map(),
    getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
    setItem(key, value) { this.map.set(key, String(value)); },
    removeItem(key) { this.map.delete(key); },
    get length() { return this.map.size; },
  };
}

test('an authoritative "no profile" clears the device copy instead of reviving it', async () => {
  resetAccountWarmup();
  ownProfileCache.clear();
  const storage = deviceStorage();
  saveStoredProfile('uid-w2', { uid: 'uid-w2', handle: 'gone', displayName: 'Gone' }, storage);

  await warmAccountCaches('uid-w2', {
    storage,
    readProfile: async () => null,
    readLists: async () => null,
  });
  assert.equal(readStoredProfile('uid-w2', storage), null, 'the unpublished profile came back from storage');
  assert.deepEqual(ownProfileCache.get(ownProfileKey('uid-w2')), { profile: null });

  ownProfileCache.clear();
  resetAccountWarmup();
});

test('a failed profile read keeps the device copy: absence is not the same as silence', async () => {
  resetAccountWarmup();
  ownProfileCache.clear();
  const storage = deviceStorage();
  saveStoredProfile('uid-w3', { uid: 'uid-w3', handle: 'kept', displayName: 'Kept' }, storage);

  await warmAccountCaches('uid-w3', {
    storage,
    readProfile: async () => { throw new Error('offline'); },
    readLists: async () => null,
  });
  assert.equal(readStoredProfile('uid-w3', storage)?.handle, 'kept');
  assert.equal(ownProfileCache.get(ownProfileKey('uid-w3'))?.profile?.handle, 'kept');

  ownProfileCache.clear();
  resetAccountWarmup();
});

test('SOURCE: unpublishing forgets the profile on this device, not only in the session', async () => {
  const source = await readFile(new URL('../components/Profile/ProfilePage.jsx', import.meta.url), 'utf8');
  assert.match(source, /forgetOwnProfile\(user\.uid, unpublishedHandle\);\s*clearStoredProfile\(user\.uid\);/);
});
```

- [ ] **Paso 2: verificar que fallan**

Run: `node --test src/utils/userScopedStorage.test.js src/services/accountWarmup.test.js`
Expected: FAIL. `userScopedStorage.test.js` falla en el import (`clearStoredProfile` no existe). En `accountWarmup.test.js`, «an authoritative "no profile"…» falla porque la copia sigue (`readStoredProfile` devuelve el perfil) y el SOURCE falla.

- [ ] **Paso 3: implementar**

En `src/utils/userScopedStorage.js`, tras `saveStoredProfile`:

```js
export function clearStoredProfile(userId, storage) {
  const key = getOwnProfileStorageKey(userId);
  const target = getStorage(storage);
  if (!key || !target) return;

  try {
    target.removeItem(key);
  } catch {
    // A copy that cannot be removed is corrected by the next read, as before.
  }
}
```

En `src/services/accountWarmup.js`, añade `clearStoredProfile` al import de `../utils/userScopedStorage.js` y sustituye `warmAccountCaches` por:

```js
async function defaultReadLists(uid) {
  return getDocs(query(
    collection(db, 'users', uid, 'lists'),
    limit(OWN_LISTS_PAGE_SIZE),
  ));
}

export async function warmAccountCaches(uid, {
  storage,
  readProfile = readOwnUserProfile,
  readLists = defaultReadLists,
} = {}) {
  if (!uid || IS_DEMO || warmed.has(uid)) return;
  warmed.add(uid);
  hydrateAccountCaches(uid, { storage });
  const [profileRead, listsSnapshot] = await Promise.all([
    // A failed read and "no profile" are different answers, and only the
    // second one may erase what this device remembers: an unpublished
    // profile that came back from storage on every reload was the first
    // one wearing the second one's clothes.
    readProfile().then(profile => ({ profile }), () => null),
    readLists(uid).catch(() => null),
  ]);
  if (profileRead?.profile) {
    rememberOwnProfile(uid, profileRead.profile);
    saveStoredProfile(uid, profileRead.profile, storage);
  } else if (profileRead) {
    rememberOwnProfile(uid, null);
    clearStoredProfile(uid, storage);
  }
  if (listsSnapshot && queryIsAuthoritative(listsSnapshot)) {
    const lists = [];
    listsSnapshot.forEach(item => lists.push({ id: item.id, ...item.data() }));
    rememberOwnLists(uid, lists);
    saveStoredLists(uid, lists, storage);
  }
}
```

En `src/components/Profile/ProfilePage.jsx`, añade el import:

```js
import { clearStoredProfile } from '../../utils/userScopedStorage.js';
```

y en `unpublishProfile`, tras `forgetOwnProfile(user.uid, unpublishedHandle);`:

```js
      clearStoredProfile(user.uid);
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/utils/userScopedStorage.test.js src/services/accountWarmup.test.js src/utils/profileSessionCaches.test.js && npx eslint src/services/accountWarmup.js src/components/Profile/ProfilePage.jsx`
Expected: PASS.

- [ ] **Paso 5: commit**

```bash
git add src/utils/userScopedStorage.js src/utils/userScopedStorage.test.js src/services/accountWarmup.js src/services/accountWarmup.test.js src/components/Profile/ProfilePage.jsx
git commit -m "fix(perfil): despublicar borra también la copia del dispositivo, y una ausencia confirmada no la resucita

unpublishProfile olvidaba la caché de sesión pero no localStorage, y
hydrateAccountCaches volvía a sembrar el perfil borrado en cada recarga.
El calentamiento distingue ahora «no hay perfil» (borra la copia) de
«la lectura falló» (la conserva).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 10: un chunk que ya no existe es un 404 y la pestaña se recarga una vez (F8)

**Files:**
- Modify: `vercel.json:23`
- Modify: `src/main.jsx` (antes de `registerSW()`)
- Create: `src/utils/spaDeploy.test.js`

- [ ] **Paso 1: escribir los tests que fallan**

Crea `src/utils/spaDeploy.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VERCEL = new URL('../../vercel.json', import.meta.url);
const MAIN = new URL('../main.jsx', import.meta.url);

test('the SPA rewrite never answers a missing chunk with index.html', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const spa = config.rewrites.find(rule => rule.destination === '/index.html');
  assert.ok(spa, 'the SPA rewrite is gone');
  // Vercel compiles `/:path(<pattern>)` with path-to-regexp; the custom
  // pattern inside the parentheses is a plain regex, which is what this runs.
  const pattern = spa.source.match(/^\/:path\((.+)\)$/)?.[1];
  assert.ok(pattern, `unexpected rewrite source ${spa.source}`);
  const matches = value => new RegExp(`^${pattern}$`).test(value);
  assert.ok(matches('lists'));
  assert.ok(matches('public/paper/10.1234%2Fabc'));
  assert.ok(!matches('_vercel/insights/script.js'));
  // A tab that outlives a deploy asks for a chunk by its old hash. That has to
  // be a 404 Vite can report, not HTML served as JavaScript with a 200.
  assert.ok(!matches('assets/index-DToPZZZM.js'));
  assert.ok(!matches('assets/CommentsSheet-Da9L05_h.css'));
});

test('SOURCE: a failed chunk load reloads the tab once a minute at most', async () => {
  const source = await readFile(MAIN, 'utf8');
  assert.match(source, /addEventListener\('vite:preloadError'/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /window\.location\.reload\(\)/);
});
```

- [ ] **Paso 2: verificar que fallan**

Run: `node --test src/utils/spaDeploy.test.js`
Expected: FAIL. El primero en `!matches('assets/index-DToPZZZM.js')`; el segundo en `vite:preloadError`.

- [ ] **Paso 3: implementar**

En `vercel.json`, la regla de `rewrites`:

```json
  "rewrites": [
    { "source": "/:path((?!_vercel/|assets/).*)", "destination": "/index.html" }
  ],
```

(Los ficheros que sí existen bajo `/assets` se sirven antes de las reescrituras — Vercel resuelve el sistema de ficheros primero —, así que el único efecto es que un chunk ausente pase de `200 text/html` a `404`.)

En `src/main.jsx`, justo antes de `registerSW()`:

```js
// A deploy replaces every hashed chunk. A tab that outlives one keeps asking
// for chunks by their old hash; vercel.json keeps `/assets` out of the SPA
// rewrite so that request is a 404 and not index.html served as JavaScript,
// and Vite reports the failure here. One reload fetches the new graph. The
// timestamp is what keeps a deploy that is genuinely broken from reloading
// forever: a second failure inside a minute surfaces as the error it is.
const PRELOAD_RELOAD_KEY = 'papertok_preload_reloaded_at'
window.addEventListener('vite:preloadError', (event) => {
  const now = Date.now()
  let last = 0
  try {
    last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY)) || 0
    if (now - last < 60_000) return
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now))
  } catch {
    // No session storage means no way to stop a loop: let the error surface.
    return
  }
  event.preventDefault()
  window.location.reload()
})
```

- [ ] **Paso 4: verificar que pasa**

Run: `node --test src/utils/spaDeploy.test.js && npx eslint src/main.jsx && npm run build`
Expected: PASS, lint limpio, build en verde.

- [ ] **Paso 5: commit**

```bash
git add vercel.json src/main.jsx src/utils/spaDeploy.test.js
git commit -m "fix(deploy): un chunk que ya no existe es un 404 y la pestaña se recarga una vez

La reescritura SPA de Vercel tragaba /assets: una pestaña abierta durante
un despliegue pedía un chunk con hash viejo, recibía index.html con 200 y
la ruta no abría hasta recargar a mano. /assets queda fuera de la
reescritura y vite:preloadError recarga una vez por minuto como mucho.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Tarea 11: verificación completa, despliegue y registro

**Files:**
- Modify: `STATE.md` (entrada nueva ARRIBA del todo: el fichero va de más nuevo a más viejo)

- [ ] **Paso 1: suite completa**

Run: `npm run check`
Expected: `security:secrets`, `lint`, `test`, `build` y `worker:deploy:dry-run` en verde. Si un test sale `cancelled`, es un cuelgue (Node 22): revisa que ningún test nuevo deje una promesa sin resolver.

- [ ] **Paso 2: rebase y despliegue del Worker**

```bash
git fetch origin && git rebase origin/main
```

```bash
npm run worker:deploy
```

El Worker va primero: el cursor del cliente no depende de él, y la exigencia de `Origin` solo afecta a llamadas que no vienen del navegador.

- [ ] **Paso 3: verificar el Worker en vivo**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' 'https://api.papertok.app/thread-anchor?ids=doi:10.1234/abc'
```

Expected: `403`.

```bash
curl -sS -D - -o /dev/null -H 'Origin: https://papertok.app' 'https://api.papertok.app/thread-anchor?ids=doi:10.1234/abc' | grep -iE '^(HTTP|access-control-allow-origin|cache-control)'
```

Expected: `HTTP/2 200`, `access-control-allow-origin: https://papertok.app`, `cache-control: private, no-store`.

- [ ] **Paso 4: publicar el frontend**

```bash
git push origin main
```

Vercel despliega en el push sin esperar a los tests (la única CI es la de Pages). Cuando termine:

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://papertok.app/assets/no-such-chunk.js
```

Expected: `404 …` (antes: `200 text/html`).

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://papertok.app/lists
```

Expected: `200 text/html; charset=utf-8`.

- [ ] **Paso 5: verificar en el navegador**

Con la sesión del usuario ya iniciada (nunca pedir credenciales): abrir un hilo con más de 20 comentarios y pulsar «cargar más» → llegan los siguientes, sin duplicados. Abrir dos papers seguidos con la consola de red filtrando `/_vercel/insights/view` → dos peticiones, una por paper. Abrir «Guardar en lista», pulsar Escape → el modal se cierra y una segunda tarjeta lo vuelve a abrir.

- [ ] **Paso 6: registrar en STATE.md y commit**

Añade al principio de `STATE.md` una entrada fechada `2026-09-02` con los diez commits y el enlace a este plan; en particular deja escrito que `THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT` existe y vale 120, y que `/thread-anchor` ya no contesta sin `Origin`.

```bash
git add STATE.md
git commit -m "docs(estado): los diez hallazgos de la revisión 7940a3e..HEAD, cerrados y desplegados

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```
