# G2 — Plazos de red y manejo de errores · Plan de implementación

> **Para agentes:** los pasos usan casillas (`- [ ]`). Ejecutar tarea a tarea, con
> `npm test` entre tareas.

**Objetivo:** que ningún camino de red del Worker, del proxy Deno o del cliente
pueda esperar sin límite — ni en las cabeceras ni en el cuerpo — y que el único
handler sin try/catch deje de contestar sin CORS.

**Arquitectura:** un solo mecanismo, `AbortSignal.timeout(ms)`, sustituye al par
`AbortController` + `setTimeout` + `clearTimeout` en un `finally`. El motivo es
estructural, no estético: un temporizador que se limpia en `finally` deja de
cubrir la respuesta en cuanto `fetch` resuelve — es decir, al llegar las
**cabeceras** — mientras que `AbortSignal.timeout` no tiene temporizador que
limpiar y sigue armado hasta que el cuerpo se ha leído entero. Verificado con un
banco de pruebas (ver «Evidencia»).

**Stack:** Cloudflare Workers (`compatibility_date = 2026-07-16`), Deno Deploy,
navegador vía Vite 8. `AbortSignal.timeout` está en los tres.

## Evidencia recogida antes de tocar código

Servidor local que manda cabeceras y luego gotea el cuerpo para siempre, con un
plazo de 1 s:

| patrón | resultado |
|---|---|
| el de `fetchJsonWithTimeout` hoy (`return response.json()` + `finally { clearTimeout }`) | **sigue colgado a los 3000 ms** |
| cuerpo leído dentro del bloque cubierto | `AbortError` a los 1011 ms |
| `AbortSignal.timeout(800)`, cuerpo goteado | `TimeoutError` a los 806 ms |

El error de `AbortSignal.timeout` se llama `TimeoutError`, no `AbortError`.

## Restricciones globales

- No tocar `worker/email-notifications.js` ni `worker/email-delivery-ledger.js`
  (son de G1, ya arreglado).
- El plazo por defecto del cliente debe ser **sobrescribible**: la IA gasta 70 s
  legítimos y no puede quedar cortada a 15 s.
- El plazo del proxy Deno debe ser **más corto** que el peldaño del Worker que lo
  llama, para que conteste con un estado legible en vez de morir cortado.
- Cada arreglo lleva su test de regresión, y cada test se verifica por mutación:
  se comprueba que falla contra el código sin arreglar.

---

### Tarea 1 · F2 — un solo helper que cubra cabeceras y cuerpo (Worker)

**Ficheros:**
- Modificar: `worker/report-api.js` (`fetchJsonWithTimeout` ~:324, `handleArxiv` ~:654)
- Test: `worker/report-api.test.js`

**Interfaces producidas** (las consumen las tareas 2, 3 y 4, y los grupos G5/G8):
- `fetchWithDeadline(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<Response>`
  — devuelve el `Response` sin leer, con la señal aún armada, para quien necesita
  cabeceras o estado.
- `fetchJsonWithTimeout(url, options = {}, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<any>`
  — lanza `Error('Upstream error: <status>')` si no es `ok`.
- Ambos respetan un `options.signal` propio si el llamante lo trae.

- [ ] **Paso 1: test que falla** — un upstream que manda cabeceras y no cierra el
  cuerpo debe acabar en 502, no en espera infinita.
- [ ] **Paso 2: correrlo y verlo fallar** (`--test-timeout` corto para que la
  espera infinita se note como fallo, no como cuelgue del runner).
- [ ] **Paso 3:** implementar `fetchWithDeadline` y reescribir
  `fetchJsonWithTimeout` sobre él; `handleArxiv` lee su XML bajo la misma señal.
- [ ] **Paso 4:** correr el test y verlo pasar.
- [ ] **Paso 5:** `npm test`.

### Tarea 2 · F1 + F3 — aplicar el plazo a los caminos que faltan (Worker)

**Ficheros:**
- Modificar: `worker/report-api.js` (`fetchOpenAlexPeriod` ~:236, `/related` ~:319,
  `/oa` ~:617, `fetchAdsLiterature` ~:1005, `fetchScopusSearch` ~:1212,
  `handleOpenAlex` ~:1422, `checkOpenAlexHealth` ~:1451)
- Modificar: `worker/firebase-auth.js` (:32-39)
- Test: `worker/report-api.test.js`

**Plazos:** 8 s OpenAlex (`/report/trends` lanza sus dos periodos en paralelo, y
el cliente le da 10 s), 6 s el resto de upstreams, 4 s Identity Toolkit.

**Escalera Scopus:** una señal **por peldaño**, creada dentro del bucle. Un
peldaño colgado lanza y termina la escalera entera — que es lo correcto: un
peldaño que no contesta no dice nada sobre si otra vista sería aceptada. Así el
peor caso de un Scopus colgado es 6 s, no tres esperas encadenadas.

**ADS:** con plazo, un ADS colgado **lanza**, y por lo tanto el fallback a
INSPIRE de `:1126-1131` deja de ser letra muerta. El motivo se nombra:
`ads_timeout`, distinto de `ads_<status>`.

**Identity Toolkit:** su fallo tiene código propio, `AUTH_UNAVAILABLE` 503,
distinguible del `AUTH_REQUIRED` 401 de un token inválido. El cuerpo se lee
dentro del plazo y un cuerpo estancado **no** puede degradarse a 401: eso le
diría al usuario que su sesión caducó cuando lo que pasa es que el verificador
no contesta.

- [ ] **Paso 1: test paramétrico que falla** — las **once** rutas de
  `DOMAIN_SOURCE_HANDLERS` deben llevar señal, no solo `/sources/europepmc`.
- [ ] **Paso 2: test que falla** — ADS colgado (rechazo por plazo) cae a INSPIRE
  con motivo `ads_timeout`.
- [ ] **Paso 3: test que falla** — Identity Toolkit sin respuesta da 503
  `AUTH_UNAVAILABLE`, y un token inválido sigue dando 401 `AUTH_REQUIRED`.
- [ ] **Paso 4:** correrlos y verlos fallar.
- [ ] **Paso 5:** aplicar `fetchWithDeadline` / `AbortSignal.timeout` en los siete
  puntos de `report-api.js` y reescribir `verifyFirebaseIdentity`.
- [ ] **Paso 6:** correr los tests y verlos pasar. `npm test`.

### Tarea 3 · F4 — `/openalex/*` deja de contestar sin CORS

**Ficheros:**
- Modificar: `worker/report-api.js` (despacho ~:1656)
- Test: `worker/report-api.test.js`

- [ ] **Paso 1: test que falla** — `fetch` que rechaza por red al pedir
  `/openalex/works` debe dar 502 `OPENALEX_UNREACHABLE` **con**
  `access-control-allow-origin`.
- [ ] **Paso 2:** correrlo y verlo fallar (hoy la excepción sube sin capturar).
- [ ] **Paso 3:** envolver el despacho en try/catch como el de `/report/trends`.
- [ ] **Paso 4:** correr el test y verlo pasar. `npm test`.

### Tarea 4 · F1 + F36 — proxy Deno (un solo despliegue)

**Ficheros:**
- Modificar: `proxy/scopus-proxy.js` (`secretsMatch` :48-55, fetch a Elsevier :122)
- Test: `proxy/scopus-proxy.test.js`

**F36:** comparar digests SHA-256 de ambos valores con el mismo bucle. Los
digests miden siempre 32 bytes, así que el retorno temprano por longitud —
que filtraba por tiempo cuándo un atacante había acertado el largo del secreto —
desaparece por construcción.

**F1:** 5 s a Elsevier, cabeceras y cuerpo, y un try/catch que contesta
`504 SCOPUS_UPSTREAM_TIMEOUT`. Sin ese try/catch, ponerle plazo al fetch no
arregla el cuelgue: lo convierte en una excepción sin capturar.

- [ ] **Paso 1: test que falla** — un Elsevier que rechaza por plazo da 504
  `SCOPUS_UPSTREAM_TIMEOUT`, no una excepción.
- [ ] **Paso 2: test que falla** — el fetch a Elsevier lleva señal.
- [ ] **Paso 3: test que falla** — un secreto de longitud equivocada se rechaza
  igual que uno del largo correcto pero mal valor (401 en ambos casos).
- [ ] **Paso 4:** correrlos y verlos fallar.
- [ ] **Paso 5:** implementar ambos arreglos.
- [ ] **Paso 6:** correr los tests y verlos pasar. `npm test`.

### Tarea 5 · F5 — plazo por defecto en el cliente

**Ficheros:**
- Modificar: `src/services/workerApiClient.js` (:39-48)
- Modificar: `src/services/publicListService.js` (`callWorker` :112-127)
- Test: `src/services/publicListService.test.js`

**Por qué también `publicListService`:** poner el plazo por defecto sin tocar
`callWorker` cambia un cuelgue por algo peor — `response.json().catch(() => ({}))`
se traga el aborto del cuerpo y devuelve un payload vacío que el llamante trata
como respuesta buena (una publicación «correcta» sin `shareId`). El plazo y la
lectura del cuerpo se arreglan juntos o no se arregla nada.

- [ ] **Paso 1: test que falla** — `authenticatedWorkerFetch` sin señal propia
  pone una por defecto; con señal propia, respeta la del llamante.
- [ ] **Paso 2: test que falla** — un Worker que corta el cuerpo hace que
  `publishPublicList` lance `PUBLISH_UNREACHABLE`, no que devuelva `{}`.
- [ ] **Paso 3:** correrlos y verlos fallar.
- [ ] **Paso 4:** implementar el default sobrescribible y la lectura cubierta.
- [ ] **Paso 5:** correr los tests y verlos pasar. `npm test`.

### Tarea 6 · F2 — los tres puntos del cliente

**Ficheros:**
- Modificar: `src/services/domainSourceService.js` (`fetchJson` :436-453)
- Modificar: `src/services/arxivService.js` (`fetchWithTimeout` :53-72, usos :211/:225)
- Modificar: `src/services/openAlexClient.js` (`fetchOnce` :333-366)
- Test: `src/services/domainSourceService.test.js`, `src/services/arxivService.test.js`,
  `src/services/openAlexClient.test.js`

**`openAlexClient` es el delicado:** el cuerpo no se lee en `fetchOnce` sino en
`json()`, muy lejos. La respuesta se almacena en caché y se clona, así que no
basta con mover el `await`. Solución: `fetchOnce` **materializa** el cuerpo
dentro del plazo y devuelve un `Response` nuevo con el mismo estado y cabeceras.
Los estados sin cuerpo (204/205/304) se devuelven tal cual, porque el constructor
de `Response` los rechaza con cuerpo.

- [ ] **Paso 1: tres tests que fallan**, uno por punto: cuerpo que no termina →
  el plazo lo corta.
- [ ] **Paso 2:** correrlos y verlos fallar.
- [ ] **Paso 3:** implementar los tres.
- [ ] **Paso 4:** correr los tests y verlos pasar. `npm test`.

### Tarea 7 · Verificación del grupo

- [ ] `npm test` entero en verde.
- [ ] `npm run lint` en verde.
- [ ] `npm run build` en verde.
- [ ] `npx wrangler deploy --dry-run` en verde.
- [ ] Verificación por **mutación** de cada test nuevo: revertir el arreglo,
  comprobar que el test falla, restaurarlo.
- [ ] Barrido final: `grep` de `fetch(` en los cuatro ficheros de red para que no
  quede ninguna llamada sin señal.
- [ ] Regresión de G1: los tests de `email-notifications` y
  `email-delivery-ledger` siguen en verde.
- [ ] Marcar las casillas de G2 en `ERRORES.MD` y anotar en `STATE.md` el nombre y
  el contrato del helper, que G5 y G8 reutilizarán.
