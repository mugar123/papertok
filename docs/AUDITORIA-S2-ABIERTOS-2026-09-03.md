# Auditoría de lo que quedó abierto tras Semantic Scholar — 2026-09-03

Alcance: los dos frentes de código que `docs/AUDITORIA-SEMANTIC-SCHOLAR-2026-09-03.md`
y el plan de deuda diferida dejaron abiertos a propósito — **S6**, la caché de
borde partida por origen, y las **seis fugas de cuota** de `cacheResponse` y
`reserveOpenAlexBudget` — más el tercero, que no es código. Todo lo que dice
«verificado» se leyó en `main` a `a717b06`; **nada se sondeó en producción**
(cada sonda gasta el segundo de un lector).

---

## Veredicto

| Frente | Estado |
|---|---|
| S6 — caché partida por origen | **Real, pequeña hoy, y con una víctima concreta.** Seis puntos de caché ponen `_origin` en la clave porque la Cache API ignora `Vary` y la cabecera CORS va cocida en la entrada. En producción solo hay un origen de navegador, así que el reparto es entre ese origen y `no-origin` — y el sitio donde eso duele es `/health/scopus` y `/health/openalex`, cacheados precisamente para proteger un cupo semanal: un monitor sin `Origin` y un navegador son **dos** llamadas al proveedor por una respuesta idéntica. Arreglo mecánico: clave sin origen, cabecera reconstruida al servir. |
| Las seis fugas | **Cinco reales, una mal clasificada, y una que era decisión.** La causa raíz es una sola: las puertas devuelven un *veredicto* (`Response \| null`), no un *asiento*, así que nadie puede devolver lo que otra puerta gastó. Solo `reserveSharedMinuteQuota` devuelve asiento desde el plan anterior. El arreglo es uno, no seis: cada puerta devuelve lo que reservó y `cacheResponse` es el único dueño de las devoluciones. |
| El «throw del fetcher» | **No es fuga.** Un fallo del fetcher puede ser un timeout, y un timeout es un envío al proveedor. El ledger cuenta envíos. Devolver ahí sería contar de menos y superar el límite del proveedor: es el ledger haciendo su trabajo. Se reclasifica. |
| La fuga del minuto de OpenAlex | **Era deliberada** — el comentario de `reserveOpenAlexBudget` lo dice: «this way the leak lives in the minute bucket, thrown away sixty seconds later». Escrito cuando no había patrón de devolución; hoy `releaseRequestQuota` existe y cuesta tres líneas. Se arregla, y el comentario cambia de «cuál fuga es menos mala» a «no hay fuga». |
| Límite de 1 RPS en Semantic Scholar | **No es código.** Sigue pendiente de @mugar. Fuera del plan. |

---

## 1. S6 — la caché de borde se parte por origen

### Qué hay

`canonicalCacheKey` (`report-api.js:300-308`) construye la clave con los
parámetros canónicos **más `_origin`**. Seis llamadores, todos con la misma
forma — `match`, y si hay entrada, `return cached` tal cual:

| Llamador | Línea | Qué cachea |
|---|---|---|
| `cacheResponse` | :494 | todas las rutas `/sources/*`, `/related`, `/report/trends`, `/citation-graph`, `/oa` |
| `handleArxiv` | :971 | el Atom de arXiv |
| relay `/openalex/*` | :2005 | el cuerpo de OpenAlex |
| `/health/email` | :2349 | la sonda de Brevo |
| `/health/openalex` | :2386 | la sonda de OpenAlex |
| `/health/scopus` | :2405 | la sonda de Scopus (**una llamada del cupo semanal**) |

El motivo de `_origin` es correcto y hay que conservarlo al arreglar: la
respuesta cacheada lleva `access-control-allow-origin: <origen>` cocido, y la
Cache API de Workers **no honra `Vary`**, así que una entrada guardada bajo un
origen se serviría, cabecera incluida, al siguiente — y el navegador la
rechazaría por CORS. Meter el origen en la clave era la forma de no cruzar
cabeceras.

### Qué cuesta de verdad

`ALLOWED_ORIGINS` (`wrangler.toml:22`) tiene doce entradas: apex, `www`, el
alias de Vercel, `github.io` y ocho variantes de localhost. En producción
**`www`, `github.io` y el alias redirigen al apex** (verificado el 02-09 en la
auditoría de Vercel), así que el único origen de navegador real es
`https://papertok.app`. Las variantes de localhost no existen en producción.

El reparto real es, por tanto, entre **dos** claves: `papertok.app` y
`no-origin`. `no-origin` es cualquier petición sin cabecera `Origin`: `curl`, un
monitor externo, un `fetch` de servidor. Y ahí está la víctima concreta:

- `/health/scopus` cuesta **una llamada al cupo semanal de Elsevier** y se
  cachea justo para que «hammering the route cannot drain the weekly provider
  allowance» (:2401-2403). Un monitor sin `Origin` y un panel en el navegador
  son dos entradas y **dos llamadas** por una respuesta idéntica. La protección
  que se buscaba está a la mitad.
- Lo mismo para `/health/openalex` (cupo diario en dólares) y `/health/email`
  (el límite compartido de Brevo con la entrega real).
- En las rutas de fuentes el reparto vale poco: un monitor no pide
  `/sources/s2?q=malaria`. Pero cuesta lo mismo arreglarlas todas que una.

### Qué NO es un problema

El **cuerpo** de la entrada es independiente del origen en los seis sitios:
misma URL upstream, mismos parámetros canónicos. Lo único que varía por origen
es una cabecera. Compartir la entrada es seguro por construcción. Y un origen
no admitido nunca llega a la caché: todas las rutas devuelven 403 antes
(`sourceRequestContext`, `:2000`, `:2345`…).

### Arreglo

Clave **sin** `_origin`; al servir, **reconstruir** la cabecera CORS para el
origen que pregunta, conservando `vary: Origin` para que las cachés
intermedias y la del navegador tampoco crucen:

```js
function serveCached(cached, origin, env) {
  const headers = new Headers(cached.headers);
  headers.delete('access-control-allow-origin');
  headers.delete('vary');
  for (const [name, value] of Object.entries(corsHeaders(origin, env))) headers.set(name, value);
  return new Response(cached.body, { status: cached.status, headers });
}
```

Seis llamadores cambian `return cached` por `return serveCached(cached, origin, env)`
y `canonicalCacheKey` pierde el parámetro `origin`. Ningún test actual afirma
que dos orígenes den dos entradas (comprobado: la única mención, `:2141`, es un
comentario sobre otra cosa), así que nada se rompe; falta el test que afirme lo
contrario.

---

## 2. Las fugas de cuota

### La causa raíz: veredictos, no asientos

`cacheResponse` (`:493-522`) pasa por hasta cuatro puertas en orden:

```
minuto compartido (:500)  →  identidad (:502)  →  compás (:504)  →  presupuesto OpenAlex (:506)
```

Cada una **gasta** algo en el ledger si acepta. Pero tres de las cuatro
devuelven `Response | null` — un veredicto — y tiran el asiento que acaban de
reservar. Solo `reserveSharedMinuteQuota` devuelve `{ reservation }`, desde el
plan anterior, y solo el compás sabe devolver ese asiento concreto. Cualquier
otra combinación de «una puerta gastó, otra posterior rechazó» pierde el
asiento hasta que el ledger lo tira por retención (un minuto, un día, o tres
días según el periodo).

Verificado en el código: `reserveProtectedProviderQuota` (`:321-352`) construye
su `ledgerRequest` inline y devuelve `null`; `reserveOpenAlexBudget`
(`:1939-1978`) reserva dos periodos en bucle y devuelve `null`; `awaitSharedPace`
(`:467-488`) recibe `minuteReservation` y solo devuelve ese.

### Las seis, una a una

| # | Rechaza | Se pierde | Rutas | Alcanzable | Real |
|---|---|---|---|---|---|
| L1 | identidad (`:502`) | asiento de **minuto** | `/related` (única paced con identidad) | cuando un usuario pasa de 60/min | sí |
| L2a | `throw` del DO de identidad (`:502`) | minuto | `/related` | fallo transitorio del DO `provider:<minuto>` | sí |
| L2b | `throw` del DO del compás (`:504`) | minuto **e identidad** | `/related`, `/sources/s2` | fallo transitorio del DO `s2:pace` | sí |
| L2c | `throw` del **fetcher** (`:511`) | minuto, identidad, OpenAlex | todas | timeout, 5xx, 429 del proveedor | **no es fuga** — ver abajo |
| L3 | compás con `code` → 503 (`:471-476`) | minuto e identidad | `/related`, `/sources/s2` | `QUOTA_LEDGER_UNAVAILABLE` del DO `s2:pace` con el minuto ya aceptado | sí |
| L4 | compás rechaza (`:477-487`) | **identidad** | `/related` | cada vez que no hay segundo libre | sí — la más frecuente |
| L5 | presupuesto OpenAlex (`:507-508`) | **identidad** | `/report/trends`, `/citation-graph` | techo de minuto o de día de OpenAlex | sí |
| L6 | día de OpenAlex (`:1969-1974`) | **minuto de OpenAlex** | las dos anteriores **y el relay `/openalex/*`** | techo diario | sí, y deliberada |

**L4 es la que importa.** El compás rechaza en cuanto hay contención — que es
la condición normal de un feed con varios lectores a 1 RPS — y cada rechazo
resta una unidad de las 60 por minuto del usuario en `/related`. Un lector
activo en hora punta puede agotar su minuto **sin haber hecho ni una llamada
al proveedor**, y el síntoma que vería es un `PROVIDER_RATE_LIMITED` de la
puerta de identidad, que apunta a otro sitio. Es exactamente la miga de pan que
el plan anterior dejó anotada.

### La que no es fuga: L2c

Un `throw` del fetcher llega **después** de que el Worker haya enviado, o
intentado enviar, al proveedor. Un timeout a los 6 s es un envío que el
proveedor recibió y no contestó; un 429 es un envío que contó contra su
límite. El ledger existe para acotar **nuestros envíos**, no nuestras
respuestas. Devolver la unidad ahí haría que el ledger contara de menos y que,
bajo presión sostenida, se superara el 1 RPS que el compás administra —
justo cuando el proveedor ya está colgando conexiones. **No se devuelve nada
tras el fetcher.** La lista de STATE.md la contaba como fuga; se reclasifica.

Corolario para el arreglo: el `try/catch` que devuelve asientos ante un
`throw` abarca las puertas 2–4 y **termina antes del fetcher**.

### La que era decisión: L6

`reserveOpenAlexBudget:1937-1938`:

> «Minute first, day second. Both orders can leave one bucket spent when the
> other refuses; this way the leak lives in the minute bucket, which is thrown
> away sixty seconds later, instead of in the day's.»

No es un descuido: es la elección de la fuga menos mala, escrita cuando devolver
un asiento no era un patrón de este fichero. Hoy `releaseRequestQuota` existe,
`releaseAIQuota` lo usa, y el plan anterior lo trajo a `awaitSharedPace`.
Devolver el minuto cuando el día rechaza son tres líneas dentro del bucle, y
el comentario pasa de justificar una fuga a no tenerla. Afecta también al relay
`/openalex/*`, que llama a la función directamente (`:2010`).

### Arreglo: un solo dueño de las devoluciones

No seis parches sino un cambio de contrato:

1. **Cada puerta que reserva devuelve lo que reservó.** `reserveProtectedProviderQuota`
   → `{} | { error } | { reservation }`; `reserveOpenAlexBudget` →
   `{ error } | { reservations: [minuto, día] }`, y por dentro devuelve el
   minuto si el día rechaza (L6). `reserveSharedMinuteQuota` ya lo hace.
2. **`cacheResponse` acumula `held`** con cada asiento aceptado, y ante
   cualquier rechazo o `throw` de una puerta posterior devuelve todo lo
   acumulado antes de responder. Un `releaseHeld(env, held)` con el mismo
   `try/catch` que `releaseAIQuota`: una devolución que falla es una fuga, no
   un motivo para cambiar la respuesta.
3. **`awaitSharedPace` deja de devolver por su cuenta.** Su devolución del
   plan anterior se mueve al dueño único; el test que la protege sigue en verde
   porque el comportamiento observable es el mismo (misma clave de periodo,
   mismo sujeto), solo cambia quién lo hace.
4. **El fetcher queda fuera del `try`.** L2c no se devuelve.

Con eso L1–L6 (menos L2c) caen con un mecanismo, y cada una se prueba con la
misma fixture parametrizada: un ledger falso al que se le dice **qué clave de
periodo rechaza, cuál lanza y cuál responde no-ok**, y que registra cada
`reserve` y cada `release` con su clave. El test de cada fuga afirma que la
devolución nombra exactamente la clave que la reserva nombró.

---

## 3. Lo que no es código

La solicitud a Semantic Scholar de un límite mayor que 1 RPS sigue **pendiente
de @mugar**. Todo lo anterior administra un segundo; esto es lo único que
compra más. Fuera del plan.

---

## Método

Lectura de `canonicalCacheKey`, `corsHeaders`, los seis llamadores de la caché,
`cacheResponse` y sus cuatro puertas, `reserveOpenAlexBudget` con su
comentario, `openAlexResponseHeaders`, `callRequestQuotaLedger`, y los tests
que mencionan origen o caché. `ALLOWED_ORIGINS` de `wrangler.toml` contra las
redirecciones verificadas en la auditoría de Vercel del 02-09. Sin sondas.
Plan de arreglo en `docs/superpowers/plans/2026-09-03-s2-abiertos.md`.
