# Auditoría: el feed falla al entrar en frío y «Try again» lo cura — 2026-09-16

Síntoma reportado por Nicolás: al abrir PaperTok tras mucho tiempo sin entrar,
el feed «está un rato cargando», da error, y al pulsar *Try again* carga bien.
Teme que todo usuario nuevo lo vea.

**Veredicto:** el error es un falso negativo de la carga del feed. Las fuentes
sí contestan, pero contestan **después** del presupuesto de 4 s que el feed usa
para pintar pronto, y ese presupuesto hace también de plazo de fallo: lo que
llega a los 4,3 s se tira, la carga se declara fallida, el reintento automático
(uno, a los 2,5 s, con el mismo presupuesto) fracasa igual, y la pantalla se
queda en «Error loading papers» aunque un segundo después todas las respuestas
estén en el navegador. *Try again* funciona porque para entonces la caché del
borde está caliente y la cola de OpenAlex, vacía.

Nada de esto ocurre en el servidor: el Worker contesta bien. Es el cliente el
que se rinde antes de tiempo, y por tres razones acumuladas.

## Lo que se midió

Método: build de producción servido en `localhost:5174`, Chrome headless por
CDP con el perfil que tiene la sesión de Nicolás (35 h sin abrir la app: token
de Firebase caducado, snapshot del feed caducado, cachés de fuente caducadas),
contra el Worker y Firestore reales. Sonda en el scratchpad
(`cold-entry-probe.mjs`), que registra red, consola, línea de tiempo del DOM y
capturas.

### 1. Latencia en frío de cada fuente, medida contra el Worker de producción

| Fuente | Frío | Caliente | Tamaño |
|---|---|---|---|
| arXiv (`sortBy=submittedDate`) | 0,53 s (HIT de Fastly) | 0,09 s | 50 KB |
| arXiv (`sortBy=relevance`) | **502 a los 5,07 s** (plazo del Worker) | — | — |
| OpenAlex `works?filter=default.search:…` | **2,0–3,2 s** | 0,11 s | **546 KB** sin comprimir (65–82 KB en el cable) |
| PubMed (cadena en el Worker) | 2,7 s | 0,15 s | 256 KB |
| OpenReview | 2,8 s | — | 15 KB |
| Hugging Face | 0,5 s | — | 47 KB |
| Europe PMC | 502 en 0,5 s | — | — |

Un OpenAlex de medio megabyte (sin comprimir) en 2–3 s **desde un Mac con
fibra**. En el cable va comprimido a 65–82 KB, que en un 4G flojo (1,6 Mb/s)
son 0,3–0,4 s más; lo que pesa es el tiempo de la búsqueda en OpenAlex.

### 2. La entrada en frío con sesión (red rápida)

`loadPapers` arranca a los 0,68 s. Peticiones de OpenAlex, en orden de salida:

```
 676 ms  works?filter=author.id:A5034580028        51 ms   ← entidad seguida
 676 ms  works?filter=institutions.ror:02f40zc51  1140 ms  ← entidad seguida
 729 ms  works?filter=institutions.ror:013meh722  1034 ms  ← entidad seguida
1764 ms  works?filter=institutions.ror:00971b260    85 ms  ← entidad seguida
1818 ms  works?filter=institutions.id:I4210124779 1769 ms  ← entidad seguida
1851 ms  works?filter=institutions.id:I4210090411 1151 ms  ← entidad seguida
3002 ms  works?filter=default.search:"Strongly…"  2636 ms  ← LA BÚSQUEDA DEL FEED
```

La búsqueda del feed **sale 2,3 s después de que empiece la carga** y contesta a
los 5,64 s: fuera del presupuesto (0,68 + 4 = 4,68 s). El cliente de OpenAlex
(`openAlexClient.js`) admite **2 peticiones en vuelo** y encola el resto en
orden de llegada; `loadPapers` crea los candidatos opcionales (entidades
seguidas, grafo) **antes** que las fuentes principales, así que la búsqueda del
feed entra la última en la cola. En esta corrida el feed se salvó porque arXiv
acertó en Fastly y los temas seguidos trajeron papers.

Con la misma sesión bajo 3G emulado y localStorage vacío (dispositivo nuevo),
las búsquedas de OpenAlex del feed tardaron 5,2 s y 3,8 s: fuera del
presupuesto las dos. Lo que pintó fueron los seguidos. **Una cuenta sin
seguidos, sin likes y sin snapshot —un usuario nuevo— no tiene ese rescate.**

### 3. Reproducción determinista (control sobre el código actual)

Arnés CDP: `/arxiv` contesta 502 al instante (lo que devuelve el Worker cuando
arXiv da 429, ver `docs/AUDITORIA-3-FALLOS-2026-09-15.md`) y cada petición de
fuente al Worker se retiene N ms antes de salir.

Con N = 5000 y también con **N = 4300** (todas las fuentes contestan 300 ms
después del presupuesto):

```
t=   96  velo «Searching for discoveries...»
t= 4848  «Error loading papers»                      ← guillotina de 4 s
t= 7349  reintento automático (2,5 s después)
t=11362  «Error loading papers»                      ← el reintento, igual
         (nada se cura solo; la búsqueda de OpenAlex del feed no SALIÓ del
          navegador hasta t=11294, encolada tras seis consultas de entidad)
t=17207  clic en Try again, con el borde ya caliente
t=21261  primera tarjeta
```

Es exactamente la secuencia descrita: un rato cargando, error, y *Try again*
funciona.

## Causas raíz

1. **El presupuesto de primer pintado es una guillotina.** En
   `settleSourcesForFirstPaint` (`src/utils/asyncTiming.js`), `all` es
   `Promise.all` de las mismas promesas ya acotadas a 4 s, así que cuando el
   primer pintado sale vacío, `await all` no espera nada: `shouldAbortFeedLoad`
   ve cuatro `timed_out` y lanza. Las peticiones siguen vivas en la red (sus
   plazos propios son 6–15 s) y su respuesta se tira.
2. **La búsqueda del feed hace cola detrás de lo opcional.** `loadPapers`
   crea `graphCandidatesPromise` y `followedCandidatesPromise` antes que las
   fuentes principales, y el cliente de OpenAlex es una cola FIFO de dos
   plazas compartida con las consultas de entidades seguidas, las novedades de
   *Following* y el enriquecimiento. Medido: 2,3 s de espera en la corrida
   natural, 10 s en el control.
3. **arXiv tiene el plazo al revés**: el cliente se rinde a los 4 s
   (`arxivService.js:206`) y el Worker a los 5 s (`report-api.js:75`), así que
   un `sortBy=relevance` —la mitad de las cargas, por el modo aleatorio— no
   puede contestar nunca, y sobre eso está el 429 de arXiv en todo MISS de
   Fastly.

El reintento automático único (2,5 s, página 0, misma guillotina) no arregla
nada de esto: vuelve a pedir a un borde frío con el mismo plazo.

## Lo que no era

- **No es la puerta del perfil** (`ProtectedRoute`, «Your profile could not be
  loaded»). En las seis entradas medidas —fibra, 4G lento, 3G con 400 ms de
  RTT, con y sin localStorage— el perfil, el agregado de interacciones y el
  stream de Firestore contestaron dentro de sus presupuestos (lookup 185–605
  ms, canal de Firestore 220–513 ms). La patada de `patientRead` a los 3 s no
  se disparó.
- **No es el service worker** ni un chunk 404: la entrada con el SW viejo hizo
  su recarga forzada (workbox, `controllerchange`) y el feed cargó después.
  (El `Uncaught SyntaxError: Unexpected token '<'` de las corridas locales es
  `/_vercel/insights/script.js`, que `vite preview` no sirve; en Vercel existe.)

## Arreglo

Ver `docs/superpowers/plans/2026-09-16-feed-entrada-fria-error.md`:

1. `all` de `settleSourcesForFirstPaint` se asienta bajo un techo propio
   (12 s), no bajo el de primer pintado: un primer pintado vacío espera a las
   respuestas reales.
2. Las fuentes principales se piden antes que los candidatos opcionales, y la
   búsqueda de OpenAlex del feed entra por un carril prioritario de la cola.
3. El plazo del cliente para la ruta `/arxiv` pasa a 6 s, por encima de los
   5 s del Worker.

Y una cuarta pieza que salió de la verificación: saltar la cola no bastaba
cuando las dos plazas las ocupaban consultas opcionales *en vuelo* (la
búsqueda del feed aún esperaba sus 3,5 s de presupuesto por una plaza), así
que el carril prioritario tiene una plaza propia por encima de
`maxConcurrent`.

## Verificación (mismo arnés, mismo perfil, build de producción con el arreglo)

| Corrida | Antes (control) | Después |
|---|---|---|
| Fuentes retenidas 5 s + arXiv 502 | «Error loading papers» a los 4,8 s, reintento automático, error otra vez a los 11,4 s, pantalla muerta hasta *Try again* | **Sin error.** Velo «Searching for discoveries…» hasta la primera tarjeta a los **6,0 s** |
| Fuentes retenidas 4,3 s + arXiv 502 | Igual: error a los 4,9 s y a los 11,4 s | **Sin error.** Primera tarjeta a los 8,6 s (antes de la plaza extra) |
| Entrada natural en frío, sin snapshot | Primera tarjeta a los 4,7 s | Primera tarjeta a los **4,3 s** |
| Salida de la búsqueda de OpenAlex del feed tras la primera petición de fuente | +2,3 s (natural), +10 s (control) | **+8 a +37 ms** |

Suite de tests de las zonas tocadas en verde (`asyncTiming`, `openAlexClient`,
`OpenAlexAdapter`, `arxivService`, `scientificReportService`, los tests de
fuente de `FeedContext`), y `npm test` completo antes de subir.

## Lo que sigue abierto (no es de este arreglo)

- arXiv devuelve **429 a todo lo que no acierta en la caché de Fastly**
  (auditoría del 15-09, apartado 2a): la fuente sigue muerta para consultas
  únicas hasta que la ruta `/arxiv` entre en el compás de `upstream-pace.js`.
- ~~OpenAlex contesta medio megabyte por página~~ Hecho el mismo día: la
  búsqueda del feed pide con `select=` los dieciséis campos que lee el
  mapeador (`OPENALEX_WORK_SEARCH_FIELDS`, `OpenAlexAdapter.js`). Medido
  por página de 25 obras: 455 KB → 326 KB sin comprimir, **65–82 KB → 45–49
  KB en el cable**. El «medio megabyte» de arriba era el tamaño sin
  comprimir; lo que viaja va comprimido, así que el ahorro real es un
  tercio, y la latencia en frío la sigue marcando la búsqueda de OpenAlex
  (1,8–2,2 s con o sin `select`), no la transferencia. Lo que queda pesa en
  `authorships` (108 KB de los 455) y `locations`, que OpenAlex no permite
  seleccionar por dentro.
- El reintento automático sigue siendo uno, a los 2,5 s y a la página 0.
  Con `all` esperando a las respuestas reales ya solo se alcanza cuando
  todas las fuentes han fallado de verdad.
