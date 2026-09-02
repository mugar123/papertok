# Fallos de las fuentes del feed — hallazgos del 2026-09-01

Informe de **hallazgos**, no de soluciones. Todo lo que sigue está medido; donde
hay una cifra, está el método al lado para que se pueda repetir.

Punto de partida: al verificar la migración a Vercel se vio el feed de invitado
pintando «⚠️ Error loading papers» en algunas cargas, con `/sources/pubmed`
devolviendo 429 y `/sources/biorxiv` devolviendo 502 de forma reproducible.

---

## Resumen

| # | Hallazgo | Estado |
|---|---|---|
| B1 | OpenReview: el Worker manda un campo de orden que api2 rechaza con 400 | Corregido `bd95268`; la ordenación real, en el Worker (ver auditoría) |
| B2 | El 429 de PubMed lo emite NCBI, no el ledger del Worker | Corregido (clave puesta); residual de ráfagas cerrado con un reintento |
| B3 | Una fuente colgada descartaba los resultados de las sanas | Corregido `46d147f` |
| B4 | `api.biorxiv.org` se cuelga en ~20 % de las llamadas | **Abierto** (ajeno; mitigado por B3) |
| B5 | OpenReview en frío tarda más que el presupuesto del cliente | **No reproducido** en la auditoría del 02-09 |
| B6 | El Worker enmascara cualquier upstream no-429 como 502 y el cliente tira el cuerpo | Corregido: `upstreamStatus` en todas las fuentes, `UPSTREAM_TIMEOUT`, y el cliente conserva el cuerpo |
| B7 | `PUBMED_GLOBAL_MINUTE_LIMIT` quedó desalineado con la clave de NCBI | Cerrado: el valor se queda en 60 a propósito y el comentario ya lo dice |

---

## B1 — OpenReview: `sort=tcdate:desc` provoca un 400

**Estado: corregido en `bd95268`.**

El síntoma era «502 intermitente, a veces 200». No era intermitencia. api2
responde:

```
SearchError: No mapping found for [tcdate] in order to sort on   → HTTP 400
```

Medido contra `api2.openreview.net/notes/search`, con el resto de parámetros
idénticos:

| `sort` | Respuesta |
|---|---|
| *(ninguno)* | 200 |
| `tcdate:desc` | **400** |
| `cdate:desc` | 200 |
| `tmdate:desc` | 200 |
| `mdate:desc` | 400 |
| `pdate:desc` | 400 |

Lo que variaba no era el upstream sino el modo de consulta: `handleOpenReview`
solo añadía ese `sort` cuando `context.sort === 'recent'`, así que las demás
llamadas pasaban limpias. Con `sort=recent` el fallo era del **100 %**.

---

## B2 — El 429 de PubMed lo emitía NCBI, no el ledger del Worker

**Estado: corregido poniendo `NCBI_API_KEY`.**

Los dos 429 posibles tienen cuerpos distintos, y ese es el único discriminante
fiable:

| Cuerpo | Quién rechazó |
|---|---|
| `{"error":"Specialist source unavailable","code":"UPSTREAM_RATE_LIMITED"}` | NCBI |
| `{"code":"PROVIDER_RATE_LIMITED"}` | `RequestQuotaLedger` del Worker |

El observado era siempre el primero. Corroborado en `wrangler tail`:

```
17 x  'Specialist source failed: /sources/pubmed',    'Error: Upstream error: 429'
 3 x  'Specialist source failed: /sources/openreview', 'Error: Upstream error: 400'
 1 x  'Specialist source failed: /sources/biorxiv',   'TimeoutError: aborted due to timeout'
```

Y de forma concluyente: **151 llamadas a `quota/reserve`, 151 aceptadas**. El
techo `PUBMED_GLOBAL_MINUTE_LIMIT = 60` no rechazó ni una sola vez.

La causa era la concurrencia contra los 3 req/s anónimos, porque cada fallo de
caché cuesta **tres** llamadas a E-utilities (`esearch`, y después `esummary` +
`efetch` en paralelo):

| Patrón de carga | Antes de la clave | Después |
|---|---|---|
| 8 concurrentes | **0/8** | 5/8 |
| 6 concurrentes | — | 5/6 |
| 4 concurrentes | — | 4/4 |
| 12 en serie | 12/12 | — |

`NCBI_API_KEY` no figuraba en `wrangler secret list` pese a estar en el README.

**Residual sin cerrar:** con la clave puesta, 8 fallos de caché simultáneos
siguen dando 3 rechazos. 8 × 3 = 24 llamadas en ~1,5 s ≈ 16 req/s, por encima
de los 10 req/s que compra la clave. En el feed de invitado no se manifiesta
porque la consulta es **fija** (`neuroscience OR bioinformatics`) y la caché de
borde dura 10 min, así que N invitados simultáneos producen *un* fallo de
caché, no N. Sí podría manifestarse en el feed con sesión, donde las consultas
varían por usuario.

**Cerrado:** `c1ec8cb` reintenta una vez cada llamada a E-utilities que NCBI
rechace con 429, tras una espera corta con jitter (o el `retry-after`
anunciado, si cabe en el deadline de 6 s); como NCBI cuenta por ventanas de
un segundo, ese reintento cae ya en la siguiente. `71bf61a` y `1f200bd`
corrigieron el retry-after negativo y en blanco del propio mecanismo.

---

## B3 — Una fuente colgada descartaba los resultados de las sanas

**Estado: corregido en `46d147f`.**

`fetchDomainPapers` esperaba a `Promise.allSettled` de todas sus fuentes, y
cada llamante envolvía esa rama entera en **un único presupuesto de 4 s**:

- `useGuestFeed.js` — `GUEST_SOURCE_BUDGET_MS`
- `FeedContext.jsx` — `FEED_SOURCE_RENDER_BUDGET_MS`, en tres puntos distintos

`allSettled` solo resuelve cuando lo hace su miembro más lento, y `settleWithin`
devuelve `{status:'timed_out'}` al vencer, que el llamante descartaba. Resultado:
un upstream que se pasara del presupuesto **se llevaba por delante los papers
que sus hermanas ya habían devuelto**.

Con el deadline de 6 s del Worker por encima del presupuesto de 4 s del
cliente, cada cuelgue de bioRxiv borraba también Europe PMC y HuggingFace de
esa carga.

---

## B4 — `api.biorxiv.org` se cuelga en ~20 % de las llamadas

**Estado: abierto.** Es un fallo ajeno, no del código, pero condiciona
cualquier decisión de presupuesto.

El comportamiento es **bimodal**: o responde rápido, o no responde. No hay
degradación gradual.

Primera tanda, 8 llamadas directas con `--max-time 25`:

```
4,9s   colgada(>25s)   1,8s   colgada(>25s)   1,6s   1,7s   1,4s   1,7s
```

Segunda medición, 30 intentos con deadline de 3 s:

| Métrica | Resultado |
|---|---|
| Primer intento | 24 ok / 6 fallos (~20 %) |
| Reintento inmediato tras fallo | 2 ok / 4 fallos |

El reintento inmediato recupera **1 de cada 3**, no los 3 de cada 4 que
predeciría la independencia. La tasa de fallo además oscila entre tandas (7 %
en una, 31 % en otra), lo que apunta a **ventanas malas correlacionadas** más
que a fallos independientes por petición.

**Hipótesis descartada por medición:** la ventana de 180 días *no* es la causa.

| Ventana | Resultado |
|---|---|
| 30 d | colgada (>40 s) |
| 60 d | colgada (>40 s) |
| 90 d | 200 en 5,3 s |
| 180 d | 200 en 2,4 s |

El tamaño de la respuesta es prácticamente idéntico (77–78 KB) en todas, así
que la API parece devolver un bloque fijo de 30 registros independientemente
del intervalo.

---

## B5 — OpenReview en frío excede el presupuesto del cliente

**Estado: abierto.**

Medido tras el despliegue, con la caché fría: **4,86 s** con `sort=recent` y
2,88 s con `sort=relevant`. El presupuesto por fuente del cliente es de 3,5 s,
así que en frío se pierde.

No es un hallazgo nuevo del todo: el comentario de `useGuestFeed.js:24` ya
decía «the only thing ever seen above 4 s is OpenReview's cold upstream at
5,2 s, which no realistic budget saves». Queda anotado porque interactúa con B3
y con el presupuesto elegido.

La TTL de OpenReview es de 30 min y la consulta del invitado es fija, así que
el impacto es de un lector cada media hora.

---

## B6 — El Worker enmascara el estado real del upstream, y el cliente tira el cuerpo

**Estado: corregido en `8163f7a`, `35e0a25` y `fa457652`.** Es el hallazgo
que explica por qué B1 tardó semanas en verse.

Dos pérdidas de información encadenadas:

1. **En el Worker** (`report-api.js`, manejador de `DOMAIN_SOURCE_HANDLERS`):
   cualquier upstream que no sea 429 se relaya como **502 genérico**. El campo
   `upstreamStatus` existía pero estaba condicionado a `isScopus`, así que el
   resto de fuentes no lo emitían.

2. **En el cliente** (`domainSourceService.js`, `fetchJson`):
   `throw new Error(\`${path} returned ${response.status}\`)` descartaba el
   cuerpo de la respuesta, y con él el `code` y cualquier detalle.

Consecuencia: un **400** (petición malformada nuestra) y una **caída real del
upstream** llegaban al navegador exactamente igual, como
`/sources/openreview returned 502`. La información existía —
`Specialist source failed: /sources/openreview, Error: Upstream error: 400` —
pero solo en los logs del Worker, no donde se depuraba.

Esto afectaba también a B2: sin `wrangler tail` no había forma de saber desde
el navegador si un 429 lo puso NCBI o el ledger. El cliente resultó tener dos
entradas independientes hacia `/sources/*`: `fetchJson` cubre los nueve paths
de `DOMAIN_SOURCE_PATHS`, pero `/sources/pubmed` y `/sources/s2` no están
entre ellos y llegan por `fetchWorkerSourceJson` (`workerApiClient.js`).
`35e0a25` arregló solo la primera entrada, así que este hallazgo sobrevivió
justo donde más dolía —PubMed es la ruta que motivó B2— hasta que `fa457652`
movió `sourceResponseError` a `workerApiClient.js` y lo aplicó también ahí.

---

## B7 — `PUBMED_GLOBAL_MINUTE_LIMIT` quedó desalineado con la clave

**Estado: corregido en `c1ec8cb` y `71bf61a`.**

El comentario de `wrangler.toml` justificaba el 60 así: 60 fallos de ruta × 3
llamadas = 180/min = 3 req/s, que es el techo anónimo de NCBI. Con
`NCBI_API_KEY` puesta ese techo pasa a 10 req/s, así que el paralelo
aritmético serían 200 — pero esa cuenta no contaba el reintento: cada fallo
de caché gasta tres llamadas a E-utilities, seis si cada una se rechaza una
vez y se reintenta, así que 60 fallos de ruta al minuto son como mucho 360
llamadas, y los 10 req/s de la clave compran 100 fallos al minuto en ese
peor caso, no 200.

Se dejó en 60 **a propósito**: el ledger no rechazó nada en ninguna medición
(151/151 aceptadas), así que nunca ha sido la restricción que ata. El
comentario ya dice la aritmética real, no los 200 de antes.

---

## Hipótesis descartadas (para no repetir el trabajo)

| Hipótesis | Cómo se descartó |
|---|---|
| La migración a Vercel rompió el feed | Idéntico desde el origen viejo (GitHub Pages) y el nuevo, repetido durante una hora |
| El 429 lo genera el techo del Worker | 151/151 reservas aceptadas; el cuerpo dice `UPSTREAM_RATE_LIMITED` |
| La ventana de 180 días causa el 502 de bioRxiv | 30 d y 60 d se colgaron; 180 d respondió en 2,4 s |
| El feed pinta error con fallos parciales | Solo lanza cuando `discovered.length === 0`; con OpenReview caído pintó 12 tarjetas |
| Un reintento arreglaría bioRxiv | Recupera 1 de cada 3, con la latencia de peor caso duplicada |

---

## Método, por si hace falta reproducir

**Distinguir quién rechaza.** El código HTTP no basta; hay que leer el cuerpo.
`UPSTREAM_RATE_LIMITED` es de NCBI, `PROVIDER_RATE_LIMITED` es del ledger.

**Logs del Worker.** `npx wrangler tail --format json` emite objetos JSON
**multilínea concatenados**, no una línea por evento: parsearlo por líneas
devuelve cero resultados. Hay que recorrerlo con `JSONDecoder.raw_decode` en
bucle.

**Forzar fallos de caché.** Las rutas cachean en el borde 10–30 min, y un
acierto no gasta cuota ni llama al upstream. Para medir el camino real hay que
variar la consulta en cada llamada.

**La concurrencia es la variable.** Las mismas llamadas en serie y en paralelo
dan resultados opuestos en PubMed. Medir en serie oculta el problema por
completo.

**Verificar el frontend por contenido, no por hash.** Vercel construye este
proyecto en menos de un minuto, así que un hash capturado después del `push` ya
es el nuevo. Conviene bajar el bundle y buscar un literal que solo exista en el
cambio.

---

## Auditoría independiente — 2026-09-02

Verificación de cada hallazgo contra el código en `main` (`46d147f`) y contra
producción (`api.papertok.app`, `papertok.app`, upstreams directos). Método al
lado de cada cifra.

| # | Veredicto | Evidencia |
|---|---|---|
| B1 | **Confirmado y desplegado, con un residual nuevo** | Ver abajo |
| B2 | **Confirmado**, residual reproducido exacto | `/health` → `pubmedKeyConfigured: true`; 8 misses concurrentes → 5/8 200, 3/8 `UPSTREAM_RATE_LIMITED` |
| B3 | **Confirmado y desplegado** | Literal `failed: timed out` presente en `index-0BojMsas.js`; 101/101 tests |
| B4 | **Reproducido** | 10 llamadas concurrentes a `api.biorxiv.org`: 7 en 2,0–5,4 s, **3 colgadas >8 s** |
| B5 | **No reproducido** | 6 misses vía producción con `sort=recent`: 0,34–1,5 s; upstream directo 0,3–1,2 s |
| B6 | **Confirmado** | `report-api.js:2315` (`upstreamStatus` solo si `isScopus`); `domainSourceService.js:468` tira el cuerpo |
| B7 | **Confirmado** | `wrangler.toml:61-67`; 10 req/s × 60 s ÷ 3 = 200 |

### B1 — residual: el `sort` de api2 `/notes/search` es un no-op

`cdate:desc` ya no da 400, pero **tampoco ordena**. Medido contra
`api2.openreview.net/notes/search?query=…&source=forum&limit=36&offset=0`:

| `sort` | Respuesta | Orden de los primeros 5 `cdate` |
|---|---|---|
| *(ninguno)* | 200 | 2001, 2024-08, 2025-01, 2024-07, 2021 |
| `cdate:desc` | 200 | **idéntico** |
| `cdate:asc` | 200 | **idéntico** |
| `tmdate:desc` | 200 | **idéntico** |
| `tmdate:asc` | 200 | **idéntico** |
| `mdate:desc`, `pdate:desc` | 400 | `No mapping found` |
| `cdate:desc,tmdate:desc` | 400 | `No enum constant …SortOrder.DESC,TMDATE` |

Mismo resultado con `query=transformer` y `query=protein folding`: `asc`, `desc`
y sin `sort` devuelven la misma secuencia. Que `asc` y `desc` coincidan
descarta que sea una ordenación dentro de empates de relevancia: el parámetro
se acepta pero no altera el orden (hipótesis: el campo está en el mapping pero
vacío en los documentos indexados, así que todo empata y queda el orden de
relevancia).

Consecuencia: `sort=recent` en `/sources/openreview` devuelve hoy el orden de
**relevancia**, no el de recencia, y en silencio. El cliente no reordena por
fecha (`mapOpenReviewNote` mapea `published` desde `pdate`/`cdate`/`tcdate`,
pero ningún `.sort(` del feed lo usa). En producción,
`q=neuroscience&limit=12&sort=recent` devolvió 4 notas con `cdate` 2024-08,
2026-01, 2024-05 y 2025-01, en ese orden.

El estado de B1 debería leerse como «el 502 está corregido; la ordenación
reciente de OpenReview sigue sin existir». Si se quiere recencia real habría
que ordenar en el Worker tras recibir las notas (el `limit*3` ya trae margen),
o usar `/notes` con filtros en vez de `/notes/search`.

**Cerrado:** el Worker ordena el pool de relevancia por `pdate → cdate → tcdate` cuando `sort=recent`, y ya no manda el `sort` a api2.

### B4 — matiz sobre la cola sana

Dos de las siete respuestas sanas tardaron 4,0 s y 5,4 s: por debajo del
deadline de 6 s del Worker, pero por encima del presupuesto de 3,5 s por fuente
del cliente. Con la caché de borde fría, el primer lector pierde bioRxiv
también cuando **no** se cuelga; el siguiente la encuentra cacheada (TTL 10
min) porque la petición abandonada sigue viva (deadline del cliente 10 s >
6 s del Worker, y `cacheResponse` hace `put` antes de responder).

### B5 — no reproducido

Los 4,86 s medidos el 01-09 no aparecieron en seis fallos de caché seguidos vía
producción (0,34–1,5 s) ni en el upstream directo (0,3–1,2 s). Probable arranque
en frío del Worker sumado a un pico del upstream. Queda abierto como
intermitente no reproducible, no como latencia estructural. TTL de 30 min
confirmada en `SOURCE_CACHE_SECONDS.openreview`.

### Comprobaciones de detalle

- El corte interior de 3,5 s gana al exterior de 4 s: `fetchDomainPapers` no
  tiene ningún `await` antes de `settleDomainSources`, así que ambos
  temporizadores arrancan en el mismo tick.
- `settleWithin` engancha manejador de rechazo antes de la carrera, así que una
  fuente que rechaza después de `timed_out` no produce *unhandled rejection*.
- «Solo lanza cuando `discovered.length === 0`»: confirmado en
  `useGuestFeed.js:80`.
- Los tres puntos de `FEED_SOURCE_RENDER_BUDGET_MS` en `FeedContext.jsx` están
  en las líneas 1001, 1109 y 1185, y el default de 3,5 s de `fetchDomainPapers`
  los cubre sin cambios en los llamantes.
