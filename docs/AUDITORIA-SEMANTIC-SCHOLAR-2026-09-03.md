# Auditoría de la integración con Semantic Scholar — 2026-09-03

Alcance: las dos rutas del Worker que hablan con `api.semanticscholar.org`
(`/sources/s2` y `/related`), los tres puntos del navegador que las llaman, el
ledger de cuota que las acota, la caché de borde y los tests que las cubren.
Motivo: `SEMANTIC_SCHOLAR_API_KEY` se configuró el 02-09 a las 22:41 UTC y es la
primera vez que estas rutas responden; hasta ayer el pool anónimo las tenía
muertas (0/10 y 1/10 el 24-08), así que ningún defecto de esta capa se había
podido ver. Todo lo que dice «medido» se midió contra producción esta mañana
(03-09, 08:40–09:20 UTC).

---

## Veredicto

| Frente | Estado |
|---|---|
| La clave | **Funciona.** 5/6 por el Worker contra 0/6 anónimo en los mismos minutos. La diferencia es la clave, no una ventana de tráfico bajo. |
| El límite | **Es más estrecho de lo que el código asume.** Semantic Scholar concede **1 petición por segundo** y lo aplica por segundo: de una ráfaga de cinco pasa una. Nuestro techo es por minuto (60), que es la misma media pero no reparte dentro del minuto. Bajo presión sostenida el proveedor deja de rechazar y pasa a **colgar** la conexión hasta nuestro plazo de 6 s. |
| `/related` | **Aplasta el rechazo en un 502.** El 429 del proveedor llega al navegador como «Related papers unavailable» sin `code`, sin `retry-after` y sin `upstreamStatus`; el README dice que toda ruta de fuente relaya el 429, y esta es la que más lo necesita. Sin test que lo cubra. |
| El navegador | Dos formas de pedir dos veces lo mismo: la hoja de relacionados dispara **dos** `/related` concurrentes para cualquier paper sin DOI (los de arXiv, que son la mayoría del feed), y el feed y la hoja piden el mismo paper con `limit` distinto, que son dos claves de caché y dos llamadas al proveedor. A 1 RPS, cada duplicado es un rechazo. |

---

## 1. Mapa de la integración

| Pieza | Dónde | Qué hace |
|---|---|---|
| `/sources/s2` | `worker/report-api.js:1149` | `graph/v1/paper/search`, campos fijos, `limit ≤ 25`, `offset + limit ≤ 1000`, caché 30 min, origen exigido, sin identidad |
| `/related` | `worker/report-api.js:430` | `recommendations/v1/papers/forpaper/{id}`, `limit ≤ 20`, caché 24 h, **identidad Firebase exigida**, ids `DOI:10.…`, `ARXIV:…` o hash S2 de 40 hex |
| Techo compartido | `worker/report-api.js:191` | `S2_GLOBAL_MINUTE_LIMIT = 60`, un solo espacio `s2` para las dos rutas, reservado solo tras fallo de caché; sin variable en `wrangler.toml`, corre con el valor por defecto |
| Clave de caché | `worker/report-api.js:246` | parámetros canónicos **más `_origin`** |
| Adaptador de búsqueda | `src/services/adapters/SemanticScholarAdapter.js` | solo lo usa `EntityExplorer` para páginas de **autor** (`type: 'author'`), en paralelo con PubMed y Scopus |
| Recomendador del feed | `src/context/FeedContext.jsx:611` → `semanticScholarService.js` → `relatedPapersService.js` | `traverseAndExpandNetwork`: like, guardar, abrir PDF, o 10 s de lectura; serializado por `isTraversingNetwork`; solo usuarios con sesión; **solo papers con `arxivId`**; pide `limit = 20` |
| Hoja de relacionados | `src/components/Feed/RelatedPapersSheet.jsx:249,266` | pestaña «similares»; pide `limit = 8` (el valor por defecto) |
| Cliente de rutas de fuente | `src/services/workerApiClient.js` | sin reintento propio, a propósito: «a refusal arrives here already carrying its `retry-after`» |
| Tests | `worker/report-api.test.js:1833–1920` | cuatro: clave adjunta, clave ausente, techo compartido, `limit=20`. **Ninguno ejercita un rechazo ni un cuelgue** en ninguna de las dos rutas |

Nada en `src/` llama ya a `api.semanticscholar.org` directamente. Esa parte de la
migración está completa.

---

## 2. Medido en vivo

### 2.1 La clave hace efecto

Seis consultas distintas, espaciadas 3 s, y el control anónimo en los mismos
minutos:

| Camino | 200 |
|---|---|
| Por el Worker, con clave | **5 / 6** (el único 429 fue el primero, justo detrás de una ráfaga sin espaciar) |
| Directo a `api.semanticscholar.org`, sin clave | **0 / 6** |

### 2.2 El límite es por segundo, y de uno

| Prueba | Resultado |
|---|---|
| 6 consultas distintas **en paralelo** | 5 × 429 (`UPSTREAM_RATE_LIMITED`, en 0,3–0,6 s) + 1 × **`UPSTREAM_TIMEOUT`** (6,5 s) |
| 5 consultas distintas en paralelo | 4 × 429 + **1 × 200** |
| Una consulta ~1 s después de esa ráfaga | 200 |
| Una consulta 4 s y otra 6 s después de la ráfaga de seis (la del cuelgue) | 429, 429 |
| Tras ~30 peticiones en diez minutos: tres consultas seguidas | **502 `UPSTREAM_TIMEOUT` (6,6 s), 502 `UPSTREAM_TIMEOUT` (6,5 s), 429** |
| Misma consulta desde `www.papertok.app` | 429 (es otra clave de caché: ver S6) |
| Tras 30 s de pausa, tres consultas **espaciadas 10 s** | **200 (3,8 s), 429, 429** |
| 429 del proveedor, cabeceras | **sin `retry-after`**; el `60` que ve el navegador lo pone nuestro router (`error.retryAfter || '60'`) |

Lectura: es un cubo de un segundo. De cada segundo pasa exactamente una
petición y el resto se rechaza al instante. No hay ventana de castigo fija —la
primera petición tras una ráfaga pasa—, pero cuando la presión se sostiene el
proveedor deja de contestar 429 y **cuelga la conexión**, que en nuestro lado es
un 502 tras 6 s, o sea seis segundos de un lector esperando por una fuente que
no va a llegar. Las dos consultas rechazadas 4 y 6 s después de la ráfaga de
seis coinciden con el cuelgue de la sexta: mientras esa conexión seguía abierta,
la clave seguía ocupada.

La última fila es la que más pesa y la menos concluyente: dos rechazos con
diez segundos de separación no los explica un cubo de un segundo. O bien S2
aplica además una penalización deslizante tras el abuso de los minutos
anteriores, o bien **había lectores reales gastando el mismo segundo** —a las
11:15 hora peninsular es perfectamente posible—. No se sondeó más para
distinguirlo, porque cada sonda es un hueco que un lector no tiene. Las dos
lecturas llevan a lo mismo: el 1 RPS es el techo de **toda la aplicación**, no
de un lector, y ya se está tocando.

Nota de método: **la auditoría misma degradó la fuente** durante esos minutos.
Cada sonda consumía una reserva del ledger y un hueco del cubo de S2; con 1 RPS,
treinta peticiones en diez minutos son una carga real. Es la demostración más
clara de por qué el techo por minuto no basta.

---

## 3. Hallazgos

Severidad: **alta** = un lector lo ve como fuente muerta o espera inútil;
**media** = gasta cuota que no hay; **baja** = trampa latente o pulido.

### S1 — El techo protege el minuto, no el segundo *(alta)*

`S2_GLOBAL_MINUTE_LIMIT = 60` es 1 RPS de media, pero admite sesenta reservas
en el mismo segundo, y el proveedor solo deja pasar una. Los sesenta cuentan
contra el ledger igualmente: **una ráfaga de cinco gasta cinco reservas para
obtener una respuesta.** Fuentes reales de ráfaga hoy:

- dos lectores que abren la hoja de relacionados en el mismo segundo;
- un paper sin DOI en esa hoja (S4: dos peticiones en el mismo tick);
- el feed y la hoja pidiendo el mismo paper con `limit` distinto (S5);
- la propia página de autor, si dos lectores la abren a la vez.

El comentario de `reserveSharedMinuteQuota` dice que «NCBI and Semantic Scholar
publish a rate — requests per second — which a per-minute ceiling is the direct
expression of». Para NCBI es cierto porque `withPubmedRetry` absorbe la ráfaga.
Para S2 no hay nada que la absorba.

**Arreglo.** Un compás de un segundo en el Worker, no un techo más alto: antes
de salir hacia S2, reservar contra un `periodKey` de segundo (`s2:<segundo>`,
límite 1) además del de minuto, y si el segundo está ocupado **esperar** hasta
el siguiente (hasta ~1,5 s, con jitter) en vez de rechazar. El ledger ya sabe
hacer la reserva; lo que falta es que el rechazo de segundo se traduzca en
espera y no en 429. El presupuesto lo hay: la ruta tiene 6 s de plazo y el
navegador 4 s por fuente en el feed y 8 s en la hoja.

Y a medio plazo: **pedir a Semantic Scholar un límite mayor.** El formulario
dice que 1 RPS es el «introductorio»; con uso demostrado lo suben. Es la única
mejora que escala con los lectores.

### S2 — `/related` aplasta el 429 en un 502 mudo *(alta)*

`handleRelated` (`report-api.js:451`) lanza `new Error('Semantic Scholar error:
429')` sin `status` ni `retryAfter`, y el `catch` del router (`report-api.js:2364`)
responde `502 {"error":"Related papers unavailable"}` para cualquier fallo. Ni
`code`, ni `retry-after`, ni `upstreamStatus`. Contraste con `/sources/s2`, que
pasa por `fetchJsonUpstream` y por el mapeo de `DOMAIN_SOURCE_HANDLERS`, y
devuelve `429 UPSTREAM_RATE_LIMITED upstreamStatus:429 retry-after:60`.

Consecuencias: `relatedPapersService` lanza «Semantic Scholar API error: 502»,
que la hoja pinta como error de fuente; `getPaperRecommendations` lo traga con
un `warn` y el feed cree que S2 no tiene recomendaciones. El README de Worker
dice que «every `/sources/*` route does this now» — es literalmente cierto
porque `/related` no es `/sources/*`, y por eso engaña.

Además `handleRelated` usa `fetchWithDeadline` con el plazo general de **8 s**
(`UPSTREAM_TIMEOUT_MS`), no los 6 s de las fuentes, y el navegador aborta a los
8 s (`relatedPapersService.js:52`): un cuelgue de S2 termina exactamente cuando
el cliente ya se ha ido, y la respuesta —si llega— se cachea para nadie.

**Arreglo.** `handleRelated` → `fetchJsonUpstream` (6 s, `status` y
`retryAfter` en el error), y el `catch` de `/related` → el mismo mapeo que las
fuentes (429 con `code`, `upstreamStatus`, `retry-after`; `UPSTREAM_TIMEOUT` en
el cuelgue). Test: un mock que devuelva 429 sin cabecera y otro que cuelgue,
entrando por el router con identidad cacheada como hacen los cuatro que ya hay.

### S3 — Un rechazo no se reintenta, y S2 los reparte por segundo *(alta)*

PubMed tiene `withPubmedRetry`: un reintento con espera corta y jitter, porque
«what NCBI actually refuses is per-second bursts, which no per-minute ceiling
can see». Es **exactamente** el régimen de S2 medido en §2.2, y S2 no tiene
reintento. Un reintento único a ~1,1–1,5 s absorbe la colisión de dos lectores
en el mismo segundo; hoy esa colisión es un lector con la fuente muerta durante
los 60 s que le dice el `retry-after` inventado.

**Arreglo.** Si se hace S1 (el compás de segundo espera en vez de rechazar),
S3 cae solo. Si no, extraer `withPubmedRetry` a `withUpstreamRetry` y aplicarlo
a las dos rutas de S2 con la misma política: un reintento, no más; si el
proveedor nombra un `retry-after` mayor que el presupuesto, relayar.

### S4 — La hoja pide dos veces para cada paper sin DOI *(media)*

`RelatedPapersSheet.jsx:91` arranca en `mode = 'similar'` cuando no hay DOI, y
entonces **los dos** efectos se cumplen a la vez: el de `mode === 'similar'`
(`:249`) y el de `!hasGraphIdentifier` (`:266`). Ambos llaman
`getRelatedPapers(paper)` en el mismo tick; `relatedPapersService` solo escribe
su caché **después** de resolver y no deduplica peticiones en vuelo, así que
salen dos `/related` iguales, la caché de borde falla en las dos (son
concurrentes) y S2 recibe dos peticiones en el mismo segundo: **una se rechaza
por construcción.** Como cada efecto fija `relatedStatus` por su cuenta, si la
que falla resuelve después de la que acierta, la hoja pasa de `ready` a
`error` con la lista ya pintada.

Los papers sin DOI son los de arXiv, que es la mayoría del feed.

**Arreglo.** Un mapa de peticiones en vuelo en `relatedPapersService`, con el
mismo patrón que `openAlexEnrichmentRequests` en `FeedContext.jsx:586`, para
que dos llamadas concurrentes compartan una promesa. Y en la hoja, que el
segundo efecto no dispare cuando el primero ya lo ha hecho (o fusionarlos: la
condición real es «pestaña similares o sin grafo»).

### S5 — El mismo paper cuesta dos llamadas: `limit=20` y `limit=8` *(media)*

El feed pide `/related?limit=20` (`semanticScholarService.js:22`); la hoja pide
`/related?limit=8` (valor por defecto de `getRelatedPapers`). `limit` forma
parte de la clave canónica (`report-api.js:453`), así que para un paper que el
lector primero marca y luego abre en la hoja son **dos fallos de caché y dos
llamadas al proveedor** por la misma lista de recomendaciones, de la que la
segunda es un prefijo de la primera. La caché del navegador
(`relatedPapersService.js:24`) también se parte por `limit`.

**Arreglo.** Pedir siempre 20 arriba y recortar en el cliente: la clave de borde
solo con `paper_id`, y `getRelatedPapers(paper, limit)` cortando `slice(0,
limit)` sobre una única entrada de caché por paper.

### S6 — La caché de borde se parte por origen *(media)*

`canonicalCacheKey` añade `_origin` (`report-api.js:253`), así que la misma
consulta desde `papertok.app`, `www.papertok.app` y `mugar123.github.io` son
tres entradas y tres llamadas a S2 (medido: la consulta que acababa de fallar
desde el apex volvió a ir al proveedor desde `www`). El motivo es CORS: la
respuesta cacheada lleva `access-control-allow-origin` con un origen concreto.
Para fuentes baratas es un coste tolerable; a 1 RPS es un tercio del cubo.

**Arreglo.** Cachear el cuerpo sin origen y aplicar `corsHeaders(origin)` al
servir. Afecta a todas las rutas de `cacheResponse`, no solo a S2, y `www`
redirige al apex desde el 01-09, así que hoy el reparto real es pequeño;
prioridad por detrás de S1–S5.

### S7 — El `retry-after: 60` es inventado y es demasiado *(media)*

S2 no manda `retry-after` en sus 429 (medido), y el router rellena `60`
(`report-api.js:2420`). El comentario de `fetchJsonWithTimeout` dice que
«inventing a number here would be guessing at somebody else's window», y
justo eso hace el fallback: la ventana real es de **un segundo** (§2.2).
Un cliente que obedezca espera un minuto por un hueco que se abrió al segundo.
Hoy ningún cliente obedece —el adaptador y el feed tragan el error—, así que el
daño es nulo hasta que alguien lo lea; pero es la cifra que llegará al
navegador cuando S2 se relaye desde `/related` (S2 arriba).

**Arreglo.** Fallback por proveedor: `2` para S2 (el segundo siguiente, con
margen), y dejar `60` donde la ventana es por minuto (el ledger propio).

### S8 — `SemanticScholarAdapter` recorta `OR` y `AND` dentro de palabras *(baja)*

`query.replace(/OR|AND/g, ' ')` (`SemanticScholarAdapter.js:16`) no tiene
límites de palabra: «CORD-19» → «C D-19», «NAND» → «N », «ANDROID» → « ROID».
Hoy el adaptador solo se llama con `type: 'author'`, que salta esa línea, así
que el camino está muerto; pero el día que se enchufe a la búsqueda general
volverá con consultas mutiladas y sin aviso. `\b(?:OR|AND)\b` y listo.

### S9 — El feed solo pide recomendaciones para papers con `arxivId` *(baja)*

`getPaperRecommendations(paper.arxivId)` (`FeedContext.jsx:611`): un paper de
PubMed, OpenAlex o Scopus con DOI y sin arXiv **nunca** llega a S2, aunque
`getRelatedPapers` acepta DOI y `/related` también. Puede ser decisión de
producto —las recomendaciones se filtran a `arxivId` a la salida y el feed
resiembra desde arXiv— pero entonces la condición debería estar escrita, no
implícita en el tipo del argumento.

### S10 — Los tests de `/related` cubren solo el camino feliz *(baja)*

`/sources/s2` sí tiene su rechazo cubierto (`report-api.test.js:1955`, un 429
con `retry-after: 30` relayado tal cual) y el cuelgue está cubierto para las
fuentes en general (`:2013`, `UPSTREAM_TIMEOUT` vía OpenReview). Lo que no tiene
ningún test es **`/related` fallando**: los dos que la ejercitan
(`:1873`, `:1899`) devuelven siempre `recommendedPapers: []` con 200, así que el
aplastamiento de S2 no lo detecta nadie. Siguiendo la convención de `ce139ce`:
cada arreglo de arriba con un test que muera por mutación.

---

## 4. Lo que está bien y no hay que tocar

- **La clave nunca sale del Worker.** El navegador no tiene rama directa a S2;
  `vite build` rechaza un bundle sin `VITE_PAPER_API_BASE_URL`.
- **Un solo espacio de cuota para las dos rutas.** Lo que el 24-08 sustituyó
  —un limitador por pestaña— era el error de fondo; el techo compartido es la
  forma correcta aunque le falte el compás de segundo.
- **`offset + limit ≤ 1000`** (`report-api.js:1164`): S2 devuelve 400 pasado
  ese punto y la ruta lo evita en vez de reportar fuente muerta.
- **La clave canónica no incluye `sort`**, que S2 search no acepta.
- **`externalIds` en los campos** y el DOI/arXiv en `mapToStandard`: un paper
  guardado desde una tarjeta de S2 tiene dirección (arreglado el 01-09).
- **`/related` con identidad y `/sources/s2` sin ella** es la partición
  correcta: el feed de invitado no recomienda (`activeUserId` lo corta antes)
  y las páginas de autor son públicas.
- **`/health` dice si la clave está** (`semanticScholarKeyConfigured`, hoy).

---

## 5. Orden propuesto

1. **S2 + S7** — media hora y un test: `/related` relaya como las fuentes y el
   fallback de `retry-after` deja de ser un minuto. Sin esto los demás arreglos
   no se pueden ver desde el navegador.
2. **S1 (+ S3 de regalo)** — el compás de segundo en el Worker. Es el que cambia
   la experiencia: convierte «una de cinco» en «cinco de cinco, un segundo más
   tarde».
3. **S4 + S5** — el navegador deja de pedir dos veces. Con 1 RPS cada duplicado
   es un rechazo seguro; con el compás de S1 es solo un segundo perdido, pero
   sigue siendo un hueco del cubo que otro lector necesitaba.
4. **Pedir el límite ampliado a Semantic Scholar** con las cifras de este
   documento — y pedirlo **ya**, en paralelo con lo anterior, porque tarda
   días y la última fila de §2.2 dice que el segundo compartido ya se toca con
   el tráfico de una mañana. Todo lo anterior administra un segundo; esto es lo
   único que compra más.
5. S6, S8, S9, S10 cuando toque el fichero por otro motivo.

---

## Método

Lectura completa de `handleRelated`, `handleSemanticScholar`, `cacheResponse`,
`reserveSharedMinuteQuota`, `canonicalCacheKey`, el mapeo de errores del router
y `request-quota-ledger.js`; de `semanticScholarService`, `relatedPapersService`,
`SemanticScholarAdapter`, `workerApiClient` y los tres puntos de llamada; y de
los cuatro tests. Medición contra `api.papertok.app` con `curl` y origen
`papertok.app`, siempre con consultas distintas para no leer la caché, y con
control anónimo directo a `api.semanticscholar.org` en los mismos minutos.
`/related` no se sondeó: exige identidad Firebase y la sesión es del usuario.
Ningún cambio de código en este documento salvo `semanticScholarKeyConfigured`
en `/health`, hecho hoy con test que muere por mutación (95/95 → 94/95).
