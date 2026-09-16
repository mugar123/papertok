# Auditoría: arXiv sin compás — 2026-09-16

Continuación de `docs/AUDITORIA-3-FALLOS-2026-09-15.md` (apartado 2a) y de
`docs/AUDITORIA-FEED-ENTRADA-FRIA-2026-09-16.md`. Pregunta de Nicolás: «¿lo de
arXiv está resuelto?». Respuesta corta: no. El plazo del cliente ya está por
encima del del Worker (a3eaa83), pero la app sigue pidiendo a arXiv sin ningún
ritmo global, y eso es lo que arXiv castiga con 429 cuando le da por ahí.

## Estado de arXiv hoy

Sondeado a las 21:30, espaciando las peticiones 3 s como pide arXiv:

| Consulta | Respuesta |
|---|---|
| Directa a `export.arxiv.org`, tres consultas únicas (`x-cache: MISS, MISS, MISS`) | 200 en 0,33–0,39 s |
| Vía el Worker, `sortBy=submittedDate`, única | 200 en 0,44 s |
| Vía el Worker, `sortBy=relevance`, única | 200 en 0,35 s |

El 15-09 esas mismas formas daban 429 a todo MISS, y esta mañana el `relevance`
tardaba más de 5 s. Es un régimen de arXiv, no nuestro: aparece y desaparece.
La política publicada de arXiv es **una petición cada tres segundos y una sola
conexión**, por cliente. El Worker es, a sus ojos, un cliente.

## Lo que hay en el Worker

- **El compás existe y funciona para Semantic Scholar.** `worker/upstream-pace.js`
  (`awaitUpstreamSlot`) reserva un asiento por **segundo** en el Durable Object
  `REQUEST_QUOTA_LEDGER` (`periodKey` `<ns>:pace`, subject `<ns>:second:<n>`,
  límite 1), espera hasta 2,5 s por un segundo libre y, si no, refusa con
  `429 PROVIDER_RATE_LIMITED` y `retry-after: 3` sin tocar al proveedor. Se
  engancha en `reserveGates` → `awaitSharedPace` para las rutas con `paced:
  true` en `SHARED_MINUTE_CEILINGS` (`/sources/s2`, `/related`), todas ellas
  servidas por `cacheResponse`. El periodo de un segundo está **cableado**: no
  hay forma de pedir un asiento cada tres.
- **`/arxiv` no pasa por ahí.** `handleArxiv` tiene su propia caché
  (`ARXIV_CACHE_SECONDS` = 10 min en el borde, `max-age=120` en el navegador),
  su propio `fetchWithDeadline` a 5 s, y no entra en `SHARED_MINUTE_CEILINGS`
  ni en `reserveGates`. Un MISS sale a arXiv en el acto, tantas veces como
  peticiones lleguen.
- **Todo fallo es el mismo 502.** `handleArxiv` lanza `Error('arXiv error:
  429')` sin `status`, y el despachador contesta `502 {"error":"arXiv
  unavailable"}` para un 429, un cuelgue y un XML inválido por igual. El
  navegador no puede distinguirlos; `wrangler tail` sí.

## Lo que hay en el cliente

- `arxivService.js` serializa las peticiones de cada pestaña con **350 ms** de
  hueco (`ARXIV_REQUEST_GAP_MS`) y deduplica las idénticas en vuelo. Es un
  compás **por pestaña**: diez pestañas son diez compases, y todos desembocan
  en el mismo Worker, que suma sin límite.
- Peticiones a arXiv que puede disparar **una** carga del feed con sesión
  (contadas en la entrada en frío del 16-09): la consulta principal (1), la
  recuperación por tema seguido (`topicRetrievalService`: `arxiv-categories`
  **y** `arxiv-query`, hasta 2 por tema, 4 temas → hasta 8), autores seguidos
  por nombre (`getAuthorPapers`), proyectos seguidos (`fetchPapersByIds`), las
  novedades de *Following*, y aparte el informe de Research (1 por edición),
  el explorador y las páginas públicas (`fetchPapersByIds`). En la corrida
  natural de esta mañana salieron **5 peticiones a `/arxiv` en 2,5 s** desde
  una sola pestaña.
- Cuando una petición se queda en la cola de la pestaña más tiempo del que su
  llamante espera (los temas seguidos tienen 3,5 s de presupuesto), **se envía
  igual** cuando le toca: nadie la escucha ya, pero gasta su turno.

## Lo que implica un compás de 1 cada 3 s para toda la app

Veinte llamadas a arXiv por minuto **en total**, para todos los usuarios. La
caché del borde absorbe las repeticiones (misma consulta, misma página, mismo
orden), pero las consultas del feed llevan página y orden aleatorios, así que
casi todas son únicas. Consecuencias que hay que asumir, no esconder:

1. Con varias cargas simultáneas, **algunas peticiones a arXiv serán
   rechazadas** por el propio Worker con un 429 inmediato. El feed ya no falla
   por ello (auditoría del feed en frío): arXiv pasa a «no disponible en esta
   carga» y las demás fuentes pintan. El informe de Research lo marca en su
   tira de cobertura, que es la verdad.
2. Las peticiones que más se rechazarán son las **opcionales** (temas seguidos,
   novedades), porque desde a709e8e la principal sale primero en cada pestaña.
3. Hay que **alargar la caché** del borde: las listas de arXiv cambian una vez
   al día (los anuncios salen a las 20:00 ET), así que diez minutos tiran seis
   llamadas por hora donde una vale. Con una hora, una categoría popular la
   pagan sus lectores una vez.
4. Hay que **no gastar turnos en zombis**: una petición que ha esperado en la
   cola de su pestaña más que el plazo de la ruta no debe salir.

## Plan

`docs/superpowers/plans/2026-09-16-arxiv-compas.md`. En una línea: el compás
del Worker aprende a latir a un periodo distinto de un segundo, `/arxiv` toma
un asiento cada 3 s con hasta 4 s de espera y refusa con `429
PROVIDER_RATE_LIMITED` si no lo hay, sus fallos llegan al navegador con el
código que les corresponde, la caché del borde pasa a una hora, y la cola de
cada pestaña deja caer lo que ya nadie espera y respeta el `retry-after` de un
429 en vez de insistir.

## Verificación en producción (Worker `c4ee773b`, 16-09 por la noche)

Sonda `arxiv-beat-probe.sh` (scratchpad): seis consultas únicas a `/arxiv`
en paralelo, dos veces, con cinco segundos entre ráfagas.

| | Antes (sin compás) | Ráfaga 1 con compás | Ráfaga 2 con compás |
|---|---|---|---|
| 200 | 6, todas en 0,43–0,56 s | 2 (a los 1,0 s y 2,8 s) | 3 (a los 0,35 s, 0,98 s y 3,9 s) |
| 429 `PROVIDER_RATE_LIMITED`, `retry-after: 4` | 0 | 4, en 0,68 s | 3, en 0,2 s |
| Misma URL repetida | 200 en 0,12 s | — | 200 en 0,087 s (caché, sin asiento) |

Antes, seis llamadas a arXiv en medio segundo; ahora, una por periodo de tres
segundos y el resto rechazado en el Worker sin tocar a arXiv, con el mismo
reparto (dos o tres por ráfaga según la fase) que dio la simulación.

### Entrada en frío con sesión, build nuevo contra el Worker con compás

Sonda `cold-entry-probe.mjs` (`nosnapshot`): el feed pinta a los **3,75 s sin
error**. De las peticiones a `/arxiv` de la pestaña, ocho salieron a la red;
tres tomaron asiento y cinco recibieron `429` del compás sin tocar a arXiv. En
cuanto un 429 llegó a la página, el carril rechazó en local la siguiente
(5,34 s) en vez de enviarla.

**Un matiz que la sonda dejó claro.** Las peticiones de la pestaña al Worker
pueden seguir saliendo en ráfaga de 350 ms aunque el carril las serialice:
el Worker manda `stale-while-revalidate=3600`, así que para una URL que el
navegador ya tiene de hace menos de una hora contesta **al instante con la
copia caducada** (el carril avanza) y **revalida en segundo plano** por su
cuenta, fuera de cualquier cola del cliente. Esas revalidaciones son las que
chocan con el compás. No importa para arXiv —el Worker es la puerta, y ya
está medido que deja pasar una cada tres segundos—, pero sí para leer una
traza: en una pestaña con caché caliente, los 429 de `/arxiv` que se ven en
la consola son casi siempre revalidaciones de páginas que el lector ya tiene,
no consultas que le falten.

**Un fallo que salió de esta verificación y no de los tests:**
`fetchArxivDataNow` atrapaba el error del Worker y lanzaba uno nuevo sin
`status`, así que el carril nunca veía el 429 y la pestaña enviaba otra
petición 420 ms después del rechazo. `arxivUnreachableError` copia ahora
`status` y `retryAfterMs` de la causa, con su test.
