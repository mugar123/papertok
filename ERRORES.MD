# ERRORES.MD — Fallos del sistema de APIs y plan de resolución

**Auditoría del 2026-08-23.** 42 fallos numerados (F1–F42), ninguno arreglado al
escribir esto. Informe navegable con el mismo contenido:
https://claude.ai/code/artifact/a613c6d3-c496-474a-bba9-ccefb0cd5f7f

**Cómo usar este documento (para la sesión que arregla un grupo):**

1. Trabaja **un grupo entero** (G1–G8), no fallos sueltos: los grupos están
   cortados para que dos sesiones no editen los mismos ficheros a la vez.
   Comprueba primero la sección «Dependencias entre grupos».
2. **Re-verifica cada fallo antes de arreglarlo** releyendo el código en las
   líneas citadas. Las líneas pueden haberse desplazado desde la auditoría; el
   diagnóstico describe el patrón exacto para reencontrarlo. Si un fallo ya no
   existe o resulta ser incorrecto, márcalo y dilo — no arregles fantasmas.
3. Cada arreglo lleva su **test de regresión** (los planes lo especifican).
   Suite: `npm test` (unitarios, ~880), `npm run lint`, `npm run build`.
   Los tests del Worker viven junto a cada módulo en `worker/*.test.js`.
4. **Ojo con las sesiones concurrentes**: otra sesión de Claude puede estar
   editando este mismo árbol. Antes de commitear, revisa el diff fichero a
   fichero — stagear por nombre de fichero NO aísla tu trabajo (ya rompió main
   una vez). Está documentado en STATE.md.
5. Al terminar, marca los checkboxes de este fichero y anota en STATE.md lo
   hecho, con la verificación que lo respalda.
6. Despliegues: el Worker se despliega con `wrangler deploy` desde la raíz
   (config en `wrangler.toml`, entry `worker/report-api.js`). El frontend se
   despliega por GitHub Actions (`.github/workflows/deploy.yml`) al hacer push.
   El proxy Deno (`proxy/scopus-proxy.js`) vive en Deno Deploy, aparte.

**Estado de los grupos:** G1 arreglado el 23-08-2026 (F24, F25, F26, F27, F28 y
la parte email de F3), con tests de regresión verificados por mutación y
`npm run check` en verde. G2 arreglado el 23-08-2026 (F1, F2, F4, F5, F36 y la
parte no-email de F3), 21 tests nuevos verificados por mutación, 980 en verde.
Pendiente el despliegue del Worker y del proxy Deno.

**Estado en vivo al auditar** (23-08-2026): `/health` todo en verde; OpenAlex
$0,97/1,00 de presupuesto diario; Scopus servidor disponible (19.988/20.000).
Casi todo lo de abajo es latente — salvo F24 (activo en producción) y F40
(discrepancia de despliegue activa).

---

## Índice de fallos

| # | Sev. | Grupo | Título corto |
|---|---|---|---|
| F1 | ALTA | G2 | Scopus y NASA ADS sin plazo (Worker y proxy Deno) |
| F2 | media | G2 | El plazo solo cubre cabeceras, no el cuerpo (5 puntos) |
| F3 | media | G2/G1 | Ocho fetch más sin plazo (OpenAlex, auth Firebase, sondas email) |
| F4 | media | G2 | `/openalex/*` sin try/catch → 500 sin CORS |
| F5 | media | G2 | `publicListService` llama al Worker sin plazo |
| F6 | media | G3 | Fallo de Modal liquida la reserva Kimi completa como gasto |
| F7 | media | G3 | `classifyKimiError` por substring: 5xx → «presupuesto agotado» |
| F8 | media | G3 | Cuota diaria IA cobrada antes del proveedor, sin devolución |
| F9 | media | G3 | Cadena IA serial ~105 s vs 70 s del navegador |
| F10 | media | G3 | Reservas Kimi huérfanas sin expiración |
| F11 | baja | G3 | Reserve y settle en DOs de meses distintos |
| F12 | baja | G3 | 400 de Gemini reintentado en flash-lite |
| F13 | baja | G3 | Cliente: error de auth → «IA no disponible» |
| F14 | baja | G3 | Saldo Kimi cacheado 7 días para todos |
| F15 | baja | G3 | Cap Kimi clampado al default; ledger caído → «no configurado» |
| F16 | media | G4 | `/lists/unpublish` confía en el `listId` del body |
| F17 | media | G4 | Merge de sync sin precondición: pérdida persistente de papers |
| F18 | media | G4 | Cuota de publicación cobrada antes de validar, sin devolución |
| F19 | media | G4 | Doble publish concurrente crea huérfano público |
| F20 | baja | G4 | Tokens basura → llamada a Identity Toolkit cada vez |
| F21 | baja | G4 | Token OAuth de service account no invalidado tras 401 |
| F22 | baja | G4 | `requireListId` acepta `.` y `..` |
| F23 | baja | G4 | `readBody` mide en UTF-16, no en bytes |
| F24 | ALTA | G1 | Digests diarios llegan en días alternos (ACTIVO EN PROD) |
| F25 | media | G1 | No se exige `emailVerified`: suscripción de terceros |
| F26 | baja | G1 | `/health/email` sin caché → agota rate limit de Brevo |
| F27 | baja | G1 | Ledger KV de respaldo no atómico (latente) |
| F28 | baja | G1 | Brevo sin cabecera `List-Unsubscribe` |
| F29 | media | G5 | 200 degradados cacheados a TTL completo (6 h / 7 días) |
| F30 | media | G5 | Clave de caché cruda en `/report/trends`: quema presupuesto |
| F31 | media | G6 | `x-ratelimit-reset` como delta sin tope: bloqueo hasta recargar |
| F32 | media | G5 | Gate de Origin consultivo; gasto OpenAlex fuera del ledger |
| F33 | baja | G5 | Trim asimétrico en la clave de caché |
| F34 | baja | G6 | Fallos de fuentes del feed tragados sin log |
| F35 | baja | G6 | Parámetro muerto `schema: 4` |
| F36 | baja | G2 | Bearer del proxy Deno con retorno temprano por longitud |
| F37 | baja | G6 | Comillas dobles corrompen la query de arXiv |
| F38 | media | G6 | Feed de invitado llama a `/sources/physics` (protegida) |
| F39 | baja | G6 | `q-bio.NC` entra literal como término basura en OpenAlex |
| F40 | media | G7 | Scopus apagado en el bundle de producción |
| F41 | media | G8 | PubMed/Europe PMC/S2 directos del navegador |
| F42 | baja | G6 | Europe PMC mapeado dos veces |

## Dependencias entre grupos

- **G2 y G5 tocan los dos `worker/report-api.js`.** No los corras en paralelo.
  Orden recomendado: G2 primero (crea el helper de fetch-con-plazo que G5 puede
  reutilizar).
- **G3 (F8) y G4 (F18) necesitan los dos una acción `release` en
  `worker/request-quota-ledger.js`.** El primero que llegue la implementa (una
  sola vez, genérica); el segundo la consume. Anotad en STATE.md quién la hizo.
- **F3 se reparte**: los fetch sin plazo de `email-notifications.js` los arregla
  G1 (para no pisar el fichero); el resto, G2.
- **G7 (F40) es solo configuración + redeploy del frontend** — puede hacerse en
  cualquier momento, pero verifica el bundle después (el plan dice cómo).
- **G8 (F41) crea rutas nuevas en `report-api.js`** — hazlo después de G2/G5, y
  reutiliza su helper de plazos y el patrón de las nueve rutas existentes.
- Orden global sugerido por daño: **G1 → G7 → G2 → G4 → G3 → G5 → G6 → G8**.

---

# G1 — Notificaciones por email

**Ficheros:** `worker/email-notifications.js`, `worker/email-delivery-ledger.js`,
`worker/report-api.js` (solo la ruta `/health/email`), tests
`email-notifications.test.js`, `email-delivery-ledger.test.js`.

## Fallos

- [x] **F24 · ALTA · La reconciliación del día anterior se traga el digest de hoy — ACTIVO EN PRODUCCIÓN**
  `worker/email-notifications.js:1763-1794` (el `return { reconciled }`), consumido en `processScheduledSubscription` (`:2188-2199`).
  `resumeScheduledDelivery` inspecciona la reserva de hoy y la de ayer
  (`ledgerTimes = [now, now - DAY_MS]`). Si la de ayer está `committed`
  devuelve `{reconciled: true}` **sin comprobar si el estado de entrega ya
  refleja ese envío**. Como el llamante consulta resume **antes** de
  `isSubscriptionDue` y corta en cuanto devuelve algo, el día siguiente a
  cualquier envío correcto se pasa entero «reconciliando»: el digest de hoy no
  sale en ninguna de las 21 ventanas del cron. Reproducido empíricamente con
  script (KV en memoria, código real): día D `sent:1`; D+1 con papers nuevos
  `sent:0, reconciled:1`, cero llamadas a Brevo; D+2 `sent:1`. **Los diarios
  llegan en días alternos.** El único test entre días
  (`email-notifications.test.js:1359`) cubre justo el caso en que la escritura
  de estado del día D falló, donde reconciliar sí es lo deseado. La rama
  `retryExpired` (`:1784-1787`) tiene el mismo defecto y pierde el digest de
  ayer **y** el de hoy.
  **Arreglo:** antes de devolver `reconciled`, comparar con el estado ya
  cargado: si `Date.parse(subscription.lastSentAt || '') >=
  Date.parse(existing.delivery.sentAt || existing.committedAt || '')`, el envío
  ya está asentado → `continue` (y devolver `null` al agotar el bucle) para que
  siga el flujo normal. **Test obligatorio:** dos días consecutivos con envío
  correcto el primero → el segundo también envía. Revisar `retryExpired` con el
  mismo criterio.
  **HECHO (23-08-2026).** Reproducido antes de tocar nada con el módulo real y
  KV en memoria: `D sent:1` · `D+1 reconciled:1, 0 llamadas al proveedor` ·
  `D+2 sent:1`. Arreglado con `deliveryAlreadySettled()`: las ramas `committed`
  y `retryExpired` hacen `continue` cuando `lastSentAt` ya cubre el `sentAt` de
  la reserva, el bucle se agota y devuelve `null`. `retryExpired` sigue
  commiteando (contabilidad honesta de una entrega incierta) pero ya no puede
  empujar `lastSentAt` hacia atrás. Simulación de cinco días tras el arreglo:
  cinco envíos, cero reconciliaciones. Tests nuevos: «a settled digest yesterday
  does not swallow today digest» y «an expired reservation already reflected in
  delivery state does not replace today digest»; el test de reconciliación
  legítima sigue verde sin tocarlo.

- [x] **F25 · media · No se exige `emailVerified`: se puede suscribir la dirección de un tercero**
  `worker/email-notifications.js:700-708` (`verifyFirebaseIdentity`).
  Acepta cualquier cuenta con `localId` + `email` sin mirar `emailVerified`.
  La `FIREBASE_WEB_API_KEY` es pública: si la consola Firebase tiene (o algún
  día tiene) email/contraseña o un IdP que entregue emails sin verificar, un
  atacante registra `victima@ejemplo.com` sin demostrar posesión y el cron le
  envía correos diarios desde el remitente verificado de PaperTok (más
  `/notifications/test` una vez por minuto). La UI solo ofrece Google/GitHub,
  pero el Worker no puede asumir la configuración de la consola.
  **Arreglo:** rechazar con 403 si `account.emailVerified !== true`. Una línea
  más su test.
  **HECHO (23-08-2026).** `accountOwnsEmail()` + 403 `EMAIL_ADDRESS_NOT_VERIFIED`
  en el `verifyFirebaseIdentity` **local** del módulo (el de `firebase-auth.js`
  es de G2 y no se ha tocado). Criterio acordado con el usuario: `emailVerified
  === true` **o** un `providerUserInfo` de `google.com`/`github.com` con el mismo
  email — Firebase no siempre marca como verificados los accesos federados y un
  403 estricto habría dejado sin digest a usuarios legítimos de GitHub. Copy
  bilingüe añadida en `EmailNotificationModal.jsx`: sin ella el código nuevo caía
  en «el servicio no está disponible», que mentiría.

- [x] **F26 · baja · `/health/email` sin caché convierte cada hit anónimo en una llamada a Brevo**
  `worker/report-api.js:1631-1642` + `email-notifications.js:1983-2015`.
  La ruta no exige sesión y responde `no-store`; cada hit llama a
  `GET /v3/senders` de Brevo. El rate limit de la API de Brevo es **compartido
  con el envío real**: martillear la ruta puede hacer que los digests fallen
  con `EMAIL_PROVIDER_LIMIT`. `/health/scopus` y `/health/openalex` llevan
  caché de borde exactamente por esto (comentario en `report-api.js:1665-1666`).
  **Arreglo:** caché de borde como sus hermanas (`s-maxage=300`) o cachear la
  sonda en KV unos minutos.
  **HECHO (23-08-2026).** Caché de borde con el patrón literal de
  `/health/scopus`: `canonicalCacheKey` → `caches.default`, `public, max-age=60,
  s-maxage=300`. Test: dos peticiones seguidas → **una** llamada a Brevo.

- [x] **F27 · baja · El ledger KV de respaldo no es atómico entre isolates (latente)**
  `worker/email-notifications.js:1285, 1320-1370`.
  Sin el binding del DO `EMAIL_DELIVERY_LEDGER`, el ledger diario se emula con
  get→apply→put sobre una clave KV, serializado con un lock en `WeakMap` que
  solo existe dentro del isolate: dos isolates pueden duplicar envíos y romper
  el límite de 290. En producción no está activo (el DO existe, migración v2,
  y usa `storage.transaction`), pero un despliegue sin el binding degradaría
  en silencio a un modo sin garantías.
  **Arreglo:** fallar en alto — si hay proveedor de email configurado y no hay
  binding DO, abortar el cron con error visible en `/health/email`; marcar el
  fallback KV como solo-tests.
  **HECHO (23-08-2026).** `emailDeliveryLedgerMode(env)` →
  `durable` | `kv` | `missing`. El fallback KV exige ahora el opt-in explícito
  `EMAIL_DELIVERY_LEDGER_FALLBACK = 'kv'` (tests y local). Sin binding y sin
  opt-in: `callEmailDeliveryLedger` lanza 503 (falla cerrado también en
  `/notifications/test`), el cron aborta antes de escanear con
  `EMAIL_DELIVERY_LEDGER_MISSING` y `console.error`, y `/health/email` gana un
  campo `ledger` que entra en el criterio de operatividad. `health.available`
  sigue siendo solo la sonda del proveedor.

- [x] **F28 · baja · El envío por Brevo no lleva `List-Unsubscribe`**
  `worker/email-notifications.js:1566-1577` (Brevo) vs `:1612-1615` (Resend).
  La rama Resend añade `List-Unsubscribe` + one-click RFC 8058; la de Brevo
  — la de producción (`EMAIL_PROVIDER=brevo`) — solo pone el enlace en el pie
  del HTML. Gmail/Yahoo puntúan la reputación sin one-click. El endpoint
  `/notifications/unsubscribe` ya acepta POST sin cuerpo: el soporte servidor
  existe.
  **Arreglo:** añadir las dos cabeceras al payload de Brevo reutilizando la URL
  que ya construye la rama Resend.
  **HECHO (23-08-2026).** `sendWithBrevo` recibe `unsubscribeUrl` como su
  hermana y manda `List-Unsubscribe` + `List-Unsubscribe-Post` junto al
  `idempotencyKey`. Test sobre el cuerpo enviado a Brevo.

- [x] **F3 (parte email) · media · Tres fetch sin plazo en este módulo**
  `email-notifications.js:694-698` (identitytoolkit), `:1985-1991` (sonda
  Brevo), `:2019-2025` (sonda Resend). Las fuentes del digest sí tienen
  timeout (5–8 s) y el proveedor de envío 12 s; estos tres no llevan
  `AbortController`. **Arreglo:** reutilizar el patrón de
  `fetchEmailProvider` con ~8 s.
  **HECHO (23-08-2026).** `fetchWithDeadline(input, init, timeoutMs)` extraído
  de `fetchEmailProvider` (que conserva sus 12 s) y aplicado a los tres puntos
  con 8 s. Test: los tres `fetch` reciben `AbortSignal`. La parte no-email de F3
  sigue pendiente en G2.

## Plan de implementación G1

1. F24 primero: escribir el test de dos días consecutivos (debe fallar), aplicar
   el arreglo en `resumeScheduledDelivery`, ver el test pasar. Revisar
   `retryExpired` con el mismo criterio y testearlo.
2. F25: una línea + test (cuenta con `emailVerified: false` → 403).
3. F3-email, F26, F28: mecánicos, cada uno con su test.
4. F27: decisión de fail-fast; test de que sin binding DO y con proveedor
   configurado el cron aborta con error registrado.
5. Verificación: suite completa del módulo
   (`node --test worker/email-notifications.test.js` o como corra la suite),
   `wrangler deploy`, y al día siguiente comprobar en producción que un
   suscriptor diario que recibió ayer **también recibe hoy** (o simular las
   dos ventanas contra el código desplegado si hay arnés). `/health/email`
   debe seguir en verde.

---

# G2 — Plazos de red y manejo de errores (Worker + proxy + cliente)

**Ficheros:** `worker/report-api.js` (helpers de fetch y rutas), `worker/firebase-auth.js`,
`proxy/scopus-proxy.js`, `src/services/domainSourceService.js`,
`src/services/arxivService.js`, `src/services/openAlexClient.js`,
`src/services/workerApiClient.js`, `src/services/publicListService.js`.
**No toques `email-notifications.js` (eso es G1).**

## Fallos

- [x] **F1 · ALTA · Scopus y NASA ADS siguen sin plazo — el fix b295e6f no los cubre**
  `worker/report-api.js:1210` (`fetchScopusSearch`), `:1003-1009`
  (`fetchAdsLiterature`), `proxy/scopus-proxy.js:122`.
  Dos rutas `/sources/*` no pasan por `fetchJsonUpstream`: `fetchScopusSearch`
  hace `fetch(url, { headers })` sin señal, y la escalera de vistas
  (COMPLETE→STANDARD→default) puede encadenar hasta **tres** esperas ilimitadas
  en serie — afecta también a `/health/scopus`. `fetchAdsLiterature` (camino
  primario de `/sources/physics`) tampoco lleva plazo, y su fallback a INSPIRE
  solo se activa si ADS **lanza** (`:1126-1131`): un ADS colgado nunca lanza,
  así que el fallback es letra muerta justo en el escenario que lo motiva. El
  propio proxy Deno llama a Elsevier sin plazo: la cadena se cuelga eslabón a
  eslabón. El test «gives every source upstream a deadline»
  (`report-api.test.js:126`) solo cubre Europe PMC — ese hueco ocultó el fallo.
  **Arreglo:** `AbortSignal.timeout(6000)` por peldaño de la escalera Scopus
  (conservando el objeto `Response`), lo mismo en ADS, y en el fetch a Elsevier
  del proxy Deno (`AbortSignal.timeout` está soportado en Deno). Activar el
  fallback INSPIRE también ante timeout. **Test:** paramétrico sobre TODAS las
  rutas `/sources/*`, no una.

- [x] **F2 · media · El plazo solo cubre cabeceras: el cuerpo se lee sin límite (5 puntos)**
  `worker/report-api.js:323-333` (`fetchJsonWithTimeout`), `:654-669`
  (`handleArxiv`), `src/services/domainSourceService.js:436-454`,
  `src/services/arxivService.js:211-216`, `src/services/openAlexClient.js:339-365`.
  El patrón `try { return response.json() } finally { clearTimeout(id) }`
  limpia el temporizador en cuanto se evalúa la expresión de retorno — al
  llegar las **cabeceras**, antes de descargar el cuerpo. Un upstream que envía
  cabeceras y gotea el cuerpo cuelga igual que antes del fix. En el cliente,
  una fuente estancada así congela el `Promise.allSettled` de
  `fetchDomainPapers` entero. (Contraste útil: `ScopusAdapter.search` sí lee el
  cuerpo dentro del `try`.)
  **Arreglo:** consumir el cuerpo dentro del bloque cubierto
  (`const data = await response.json(); return data;`) en los cinco puntos.
  **Test:** un cuerpo que nunca termina (stream sin cierre) debe abortar.

- [x] **F3 (parte no-email) · media · Fetch sin plazo restantes en el Worker**
  `report-api.js:234` (`fetchOpenAlexPeriod`, usada ×2 por `/report/trends`),
  `:317` (`/related`, Semantic Scholar), `:615` (`/oa`, Unpaywall), `:1420`
  (`/openalex/*`), `:1449` (`checkOpenAlexHealth`), y
  `worker/firebase-auth.js:32-39` (Identity Toolkit).
  El de `firebase-auth.js` es el más delicado: está **delante** de toda ruta
  protegida en cada miss de la caché de identidad (60 s) — un Identity Toolkit
  colgado cuelga seis rutas a la vez, con la cuota de `/report/trends` ya
  reservada.
  **Arreglo:** un único helper de fetch-con-plazo (cuerpo incluido, ver F2)
  reutilizado en todos los puntos. Para la verificación Firebase, plazo corto
  (3–5 s) con error propio `AUTH_UNAVAILABLE` 503, distinguible de token
  inválido.

- [x] **F4 · media · `/openalex/*` es la única ruta sin try/catch: error de red → 500 sin CORS**
  `worker/report-api.js:1643-1645` (despacho), `:1420-1423` (fetch).
  Todas las rutas envuelven su handler y devuelven JSON con `corsHeaders`;
  esta no: `return handleOpenAlex(request, env);` a pelo. Un reset de conexión
  o DNS transitorio sube sin capturar → «Worker threw exception» sin
  `access-control-allow-origin`: el navegador lo ve como fallo CORS opaco y se
  pierde el relay de 429 + `retry-after` que la ruta se esfuerza en dar.
  **Arreglo:** envolver como `/report/trends`:
  `try { return await handleOpenAlex(...) } catch { return json({code:'OPENALEX_UNREACHABLE'}, 502, corsHeaders(origin, env)) }`.
  **Test:** fetch que rechaza por red → verificar estado y cabeceras CORS.

- [x] **F5 · media · `publicListService` llama al Worker sin plazo — el único cliente que no lo hace**
  `src/services/publicListService.js:111-128`, `workerApiClient.js:39-48`.
  `callWorker` usa `authenticatedWorkerFetch` sin `AbortController`, y este no
  impone plazo por defecto. Todos los demás llamantes pasan señal (email 25 s,
  trends 10 s, IA 70 s, citation-graph 12 s, related 8 s, scopus 12 s,
  sources 10 s). Con el Worker estancado, publicar/sincronizar una lista
  cuelga indefinidamente.
  **Arreglo:** plazo por defecto (15 s) en `authenticatedWorkerFetch`,
  sobrescribible por llamante — cierra este hueco y previene el siguiente
  olvido.

- [x] **F36 · baja · La comparación del bearer del proxy Deno no es del todo constante**
  `proxy/scopus-proxy.js:49`.
  `if (candidate.length !== expected.length) return false;` retorna temprano,
  filtrando por timing la longitud del secreto, contra lo que promete el
  comentario adyacente. Impacto práctico despreciable con secreto ≥32 chars.
  **Arreglo:** comparar digests SHA-256 de ambos valores con el mismo bucle.

## Plan de implementación G2

1. Crear (o consolidar) UN helper `fetchConPlazo` en el Worker que cubra
   cabeceras + cuerpo, y otro equivalente en el cliente si no se puede
   compartir. Todo lo demás del grupo lo consume.
2. F2 primero (corrige el patrón del helper existente), luego F1 y F3
   (aplicarlo a los caminos que faltan), F4 (try/catch), F5 (default en
   `authenticatedWorkerFetch` — cuidado con no romper el presupuesto de 70 s
   de la IA: el default debe ser sobrescribible y la IA ya pasa señal propia).
3. F36 en el proxy Deno junto con su parte de F1 (mismo fichero, un deploy).
4. Tests: el paramétrico de rutas `/sources/*`, el de cuerpo-sin-fin, el de
   CORS en error de `/openalex/*`. Los tests del proxy están en
   `proxy/scopus-proxy.test.js` (11 existentes).
5. Verificación: `npm test`, `wrangler deploy`, redeploy del proxy en Deno
   Deploy, y sondear `/health/scopus` y `/health/openalex` en producción.
   G5 y G8 reutilizan el helper: dejar su nombre y contrato anotados en
   STATE.md.

**Hecho el 23-08-2026.** Helper del Worker: `fetchWithDeadline(url, options = {},
timeoutMs = UPSTREAM_TIMEOUT_MS)` en `worker/report-api.js` — devuelve el
`Response` sin leer con la señal **aún armada**, así que el cuerpo también queda
cubierto; `fetchJsonWithTimeout` se construye sobre él. Constantes:
`UPSTREAM_TIMEOUT_MS` 8 s, `SOURCE_UPSTREAM_TIMEOUT_MS` 6 s,
`ARXIV_UPSTREAM_TIMEOUT_MS` 5 s, `IDENTITY_TOOLKIT_TIMEOUT_MS` 4 s
(`firebase-auth.js`), `UPSTREAM_TIMEOUT_MS` 5 s en el proxy Deno. Equivalente en
el cliente: `withRequestDeadline(options, timeoutMs)` en
`src/utils/requestDeadline.js`, con su test. **G5 y G8: usad `fetchWithDeadline`,
no `fetch` a pelo.** Códigos nuevos: `AUTH_UNAVAILABLE` 503,
`OPENALEX_UNREACHABLE` 502, `SCOPUS_UPSTREAM_TIMEOUT` / `SCOPUS_UPSTREAM_UNREACHABLE`
504, motivo de fallback `ads_timeout`.

**Despliegue: completo el 23-08-2026.** Las tres piezas —frontend (Action en
verde, arreglos comprobados en el bundle servido), Worker (`wrangler deploy`
16:56Z, confirmado porque `/health/email` ya responde con la caché de F26) y
proxy Deno (Playground, pegado a mano; no está enlazado al repo, así que ningún
push lo redespliega)— están en producción, con los cuatro `/health` en verde y la
cadena Scopus completa respondiendo.

**Fuera del alcance de G2, encontrado al barrer:** el patrón exacto de F2 —
`return response.json()` con `clearTimeout` en un `finally` — vive también en
`src/services/rorService.js:150-165`, `src/services/dataCiteService.js:166-176` y
`src/services/orcidService.js:7-21`, y con forma parecida en `openAireService.js`
y `openAlexService.js`. Ninguno está en la lista de ficheros de G2, así que se
dejan sin tocar para no pisar a otra sesión. Merecen su propio grupo.

---

# G3 — Explicaciones de IA (Gemini → Kimi)

**Ficheros:** `worker/ai-explanation.js`, `worker/kimi-budget-ledger.js`,
`worker/request-quota-ledger.js` (acción `release`, compartida con G4),
`src/services/aiExplanationService.js`. Tests: `ai-explanation-fallback.test.js`,
`ai-explanation-security.test.js`, `kimi-budget-ledger.test.js`,
`request-quota-ledger.test.js`.

**Patrón común del grupo:** la contabilidad (cuota diaria y presupuesto mensual
Kimi) se cobra de forma pesimista en todos los caminos de fallo y no existe
mecanismo de devolución. Las averías de proveedores se pagan como consumo real.

## Fallos

- [ ] **F6 · media · Cualquier fallo de Modal liquida la reserva completa como gasto del mes**
  `worker/ai-explanation.js:830` y `:870-874`.
  `chargedMicros` se inicializa con la reserva completa (~$0,15: prompt ~8 KB +
  4.200×2 tokens de salida) y solo se sustituye por el coste medido si la
  respuesta es `ok` con `usage`. En el `finally`, todo fallo — 404, 500 de
  Modal, timeout de 52 s, red caída — liquida la reserva íntegra como
  `spentMicros` sin haber facturado un token. ~180 intentos fallidos agotan el
  cap de $27: una avería sostenida de Modal deja el fallback muerto el resto
  del mes. El test lo reconoce como trampa
  (`ai-explanation-fallback.test.js:293-295`: «silently eats the monthly
  safety budget») sin arreglarlo.
  **Arreglo:** si el proveedor respondió con HTTP no-ok, liquidar
  `chargedMicros = 0` (o el `usage` del payload de error si viene). Cargo
  íntegro solo para abort/timeout/red, donde el consumo es desconocido.
  Convertir el test-lamento en test de regresión.

- [ ] **F7 · media · `classifyKimiError` clasifica por substring: un 5xx → «presupuesto agotado hasta el mes que viene»**
  `worker/ai-explanation.js:685-694` y `:848-849`.
  `if (status === 402 || /credit|balance|billing|budget|quota.+month|monthly.+quota/.test(detail))`
  corre sobre `JSON.stringify(payload)` completo, para cualquier status y
  **antes** de mirar 429/503. Un 500 cuyo JSON mencione «load **balanc**er» o
  «billing service unreachable» se clasifica `AI_FALLBACK_BUDGET_EXHAUSTED` →
  el cliente recibe 429 con `resetAt` el día 1 del mes siguiente por un error
  transitorio.
  **Arreglo:** limitar el sniffing de texto a 4xx (idealmente 402/403), con
  límites de palabra; todo 5xx → `AI_BUSY`/`AI_UNAVAILABLE` con retry corto.
  **Test:** un 500 con «balancer» en el cuerpo no debe clasificarse como
  presupuesto.

- [ ] **F8 · media · La cuota diaria se consume antes de llamar al proveedor y no se devuelve nunca**
  `worker/ai-explanation.js:1071-1078`; `worker/request-quota-ledger.js:33`
  (solo existe `action: 'reserve'`).
  `reserveAIQuota` incrementa el contador (10/día) y después vienen la
  descarga del PDF, Gemini y Kimi. Si todo falla, el uso queda gastado: una
  caída de proveedores de una hora funde los 10 usos de quien reintenta.
  Agravante: un paper solo-PDF cuya descarga falla transitoriamente devuelve
  `AI_INVALID_PAPER` 400 — cuota gastada y código que culpa al paper.
  **Arreglo:** (1) añadir `action: 'release'` al `RequestQuotaLedger`
  (genérica — G4/F18 también la usa; coordinar). (2) Liberar en fallos no
  atribuibles al usuario (`AI_BUSY`, `AI_UNAVAILABLE`, PDF caído). (3) Mover
  el caso «sin abstract y sin PDF» delante de la reserva. (4) Código
  `AI_SOURCE_UNAVAILABLE` para el PDF inaccesible.

- [ ] **F9 · media · El peor caso serial (~105 s) revienta el presupuesto del navegador (70 s)**
  `worker/ai-explanation.js:25-31` y `:833`;
  `src/services/aiExplanationService.js:103`.
  Encadenado posible: PDF 4,5–9 s + Gemini 12 s + flash-lite 32 s + Kimi 52 s
  ≈ 105 s contra los 70 s de `browserMs`. El usuario recibe `AI_TIMEOUT` con
  la cuota consumida y la reserva Kimi en vuelo; el abort del cliente puede
  cancelar la invocación con el settle pendiente (alimenta F10). El timeout de
  Kimi está hardcodeado (`52_000`) fuera de `AI_REQUEST_BUDGETS`.
  **Arreglo:** presupuesto global decreciente — calcular el margen restante
  frente a `browserMs` y pasarlo como `timeoutMs` a cada etapa, saltando
  etapas sin margen. Mover el 52 s a la constante.

- [ ] **F10 · media · Reservas Kimi huérfanas sin expiración: restan presupuesto todo el mes**
  `worker/kimi-budget-ledger.js:95-153` (sin `alarm()` ni TTL);
  `ai-explanation.js:789-794`.
  El único camino que borra una `reservation:<id>` es el settle. Si la
  invocación muere entre reserve y settle (cancelación del cliente, eviction,
  límite de CPU), la reserva (~$0,15) descuenta del cap hasta fin de mes.
  (La carrera de reservas concurrentes en sí está bien: la comprobación corre
  en `storage.transaction`, el cap no es sobrepasable.)
  **Arreglo:** guardar `{amountMicros, expiresAt}` por reserva y, en cada
  reserve, descartar y borrar las caducadas (>5 min); o un `alarm()` que las
  barra.

- [ ] **F11 · baja · Reserve y settle pueden caer en DOs de meses distintos**
  `worker/ai-explanation.js:730-748`. `callKimiBudgetLedger` recalcula
  `kimiPeriod()` por llamada: reservar a las 23:59:59 UTC del día 31 y
  liquidar tras medianoche liquida contra el DO del mes nuevo (la reserva no
  existe ahí; el gasto real no se contabiliza).
  **Arreglo:** calcular el periodo una vez en `explainWithKimi` y pasarlo a
  ambas llamadas.

- [ ] **F12 · baja · Un 400 permanente de Gemini se reintenta en flash-lite**
  `worker/ai-explanation.js:503-511` y `:608-611`. Un `INVALID_ARGUMENT` sin
  patrón de api-key/permiso/modelo cae en `AI_UNAVAILABLE` (reintentable): se
  repite la misma petición inválida contra flash-lite (hasta 32 s más), y el
  cliente recibe 502 para una condición determinista, quemando el uso diario.
  **Arreglo:** código no reintentable `AI_INVALID_REQUEST_UPSTREAM` excluido
  de `shouldRetryGeminiWithFallback`.

- [ ] **F13 · baja · El cliente convierte el fallo de autenticación en «IA no disponible»**
  `src/services/aiExplanationService.js:123-126`. El `catch` no distingue
  `WorkerApiAuthError` y lo reduce a `AI_UNAVAILABLE`: sesión expirada con la
  sheet abierta → «servicio no disponible» en vez de invitar a re-login.
  **Arreglo:** mapear a `AI_AUTH_REQUIRED` con su copy.

- [ ] **F14 · baja · El saldo mensual de Kimi se cachea 7 días y se sirve a todos**
  `worker/ai-explanation.js:872-873` y `:1088-1100`. `result.budget`
  (cap $27 + saldo) entra en `cacheableResponse` una semana: detalle
  financiero del operador, obsoleto, servido a cualquiera.
  **Arreglo:** excluir `budget` del objeto cacheado.

- [ ] **F15 · baja · Config confusa (dos puntos)**
  (a) `ai-explanation.js:704-709`: `KIMI_MONTHLY_HARD_CAP_USD` se clampa con
  máximo = 27 (el default) — subirla en `wrangler.toml` se ignora en silencio.
  Si es techo deliberado, comentarlo; si no, constante de máximo aparte.
  (b) `:1023-1024`: `QUOTA_LEDGER_UNAVAILABLE` (transitorio) se traduce a
  `AI_NOT_CONFIGURED` 503. Mapear a `AI_UNAVAILABLE`.

## Plan de implementación G3

1. Coordinar con G4 la acción `release` del `RequestQuotaLedger` (ver
   Dependencias).
2. Orden: F6+F7 (liquidación y clasificación — el corazón del grupo), F8
   (release), F10 (expiración de reservas), F9 (presupuesto decreciente),
   F11–F15 en una pasada.
3. Lo que NO hay que tocar (verificado en buen estado): el contrato de campos
   Gemini/Kimi (`buildJsonContractInstruction` derivado del mismo esquema,
   con tests), la distinción 429-diario/429-ráfaga, la atomicidad del cap, la
   mitigación de prompt-injection y la no-fuga de claves en errores.
4. Verificación: suites de `ai-explanation-fallback`, `kimi-budget-ledger` y
   `request-quota-ledger` en verde con los tests nuevos; `wrangler deploy`;
   probar en producción una explicación real y comprobar que `/health` sigue
   en verde.

---

# G4 — Listas públicas y autenticación

**Ficheros:** `worker/public-list-api.js`, `worker/firebase-auth.js`,
`worker/firestore-admin.js`, `worker/request-quota-ledger.js` (release,
compartida con G3). Tests: `public-list-api.test.js`, `firestore-admin.test.js`.

## Fallos

- [ ] **F16 · media · `/lists/unpublish` confía en el `listId` del body: estado atascado permanente**
  `worker/public-list-api.js:493-509` (lee `body.listId` en 495, lo usa en
  `clearFieldsWrite` en 507; `requireOwnedShare` devuelve `owner.listId` y se
  descarta).
  `update` usa `owner.listId` (`:425`); `unpublish` limpia los campos de la
  lista que diga el body. Con dos listas publicadas (A→S, B→T), la llamada
  `{shareId: S, listId: B}` — basta un cliente con estado desincronizado —
  borra `publicLists/S` y `publicListOwners/S` pero limpia
  `publicShareId/onProfile/publicSyncedAt` de **B**. Resultado: A queda con
  `publicShareId` colgando — no se puede borrar (`firestore.rules:799-800` lo
  veta), no se puede despublicar (`requireOwnedShare(S)` da 404) y ningún sync
  vuelve a funcionar; y `publicLists/T` queda huérfano público. Irreversible
  sin admin. Solo daña datos del propio uid. Los tests
  (`public-list-api.test.js:435-461`) solo cubren el caso coincidente.
  **Arreglo:** ignorar `body.listId` y usar `owner.listId` como hace `update`
  (o 400 si difieren). Una línea + test del caso no coincidente.

- [ ] **F17 · media · Dos syncs concurrentes del mismo dueño pueden perder un paper de forma persistente**
  `worker/public-list-api.js:432` (lee `existing` sin `withMeta`) y `:449`
  (`mergeWrite` solo con `exists: true`); `src/services/publicListSync.js:141`.
  El merge de `/lists/update` es read-modify-write sin precondición de versión
  (el write de la vitrina sí va pineado, `:248-253`). Pestaña A añade el paper
  X y sincroniza con X hidratado; B sincroniza a la vez sin X hidratado y con
  lectura del documento público anterior al commit de A: X «no casa con nada»
  (`buildMergedPayload:213-216`), se salta, y el write de B pisa al de A sin X.
  No se autorrepara: tras el éxito, el motor cliente vacía la hidratación
  (`job.papers.clear()`), así que los syncs siguientes nombran X solo por id y
  se vuelve a saltar siempre. Es la tercera aparición de la familia
  «pérdida silenciosa de papers publicados». Único síntoma: `skipped > 0`.
  **Arreglo:** leer `publicLists/{shareId}` con `withMeta: true` y pinear el
  `mergeWrite` a su `updateTime`, con retry desde lectura fresca ante 409 —
  el patrón ya existe en el fichero (`projectionWrite`, `refreshPinnedCard`,
  test `:663-665`).

- [ ] **F18 · media · La cuota se cobra antes de validar y no se devuelve: DoS del global**
  `worker/public-list-api.js:603` (`reservePublishQuota`, antes de
  `OPERATIONS[pathname]` en `:611`).
  Un `LIST_NOT_FOUND`, body inválido o `PUBLISH_CONFLICT` consume una unidad
  (60/día/usuario, 2000 global) — y el diseño pide reintentar los 409, con el
  motor cliente reintentando cada fallo (2 por edición). Con ~34 cuentas de
  Firebase mandando fallos baratos se apaga la publicación de todos por un día
  sin coste en Firestore.
  **Arreglo:** mover la reserva tras la validación sintáctica y de propiedad
  (o no cobrar los 4xx que no tocaron Firestore); `release` en el ledger para
  los 409 de carrera. Cobrar-antes puede seguir siendo la política para lo que
  sí llega a Firestore (protege el presupuesto Spark, es deliberado).

- [ ] **F19 · media · Doble publish concurrente crea un documento público huérfano**
  `worker/public-list-api.js:380-413`. El check `ALREADY_PUBLISHED` (`:381`)
  es check-then-act y el `mergeWrite` del puntero (`:395-397`) no lleva
  precondición: dos publish concurrentes generan shareIds distintos, ambos
  commits pasan, el puntero queda en el último y el otro share queda huérfano
  público legible. Intentar limpiarlo con unpublish dispara F16. El test de
  `:321` solo cubre el caso secuencial.
  **Arreglo:** leer la lista privada con `withMeta` y pinear el write del
  puntero a su `updateTime`: el perdedor falla el commit entero (ya mapeado a
  `PUBLISH_CONFLICT` 409). Mismo patrón que F17.

- [ ] **F20 · baja · Cada token basura de ≤8 KB dispara una llamada a Identity Toolkit**
  `worker/firebase-auth.js:20-43`. No hay ni un check de forma JWT
  (`[^\s]+` hasta 8192): peticiones anónimas con strings basura consumen una
  llamada upstream cada una. (El diseño de delegar la verificación en
  `accounts:lookup` es correcto; no cambiarlo.)
  **Arreglo:** pre-filtro local sin verificar firma — tres segmentos
  base64url, `exp` no vencido, `aud` = projectId.

- [ ] **F21 · baja · El token OAuth de la service account no se invalida tras un 401 de Firestore**
  `worker/firestore-admin.js:125-149` (cache por isolate, margen 300 s) y
  `:222-228` (`authorizedFetch` no reacciona al status). Tras rotar la clave,
  el token cacheado sigue sirviéndose hasta ~55 min: cada petición 401 → 502
  sin re-mint.
  **Arreglo:** ante 401/403, `tokenCache.delete(email)` y reintentar una vez
  con token fresco.

- [ ] **F22 · baja · `requireListId` acepta `.` y `..`**
  `worker/public-list-api.js:87-93`; `firestore-admin.js:210-217`
  (`documentName` rechaza `/` pero no segmentos-punto). Con `listId: '..'` la
  URL del GET de propiedad se normaliza a `…/documents/users/{uid}`:
  comprobación contra documento equivocado (contenido al propio subárbol; el
  write posterior falla) + cuota quemada.
  **Arreglo:** rechazar `.` y `..` en `requireListId` y, en defensa en
  profundidad, en `documentName`.

- [ ] **F23 · baja · `readBody` mide el límite en UTF-16, no en bytes**
  `worker/public-list-api.js:95-99`. `text.length` cuenta code units: un body
  de caracteres de 3 bytes pasa con ~3× el tamaño real (y `content-length`
  puede faltar con chunked). Solo memoria/CPU: el saneado posterior acota lo
  que llega a Firestore.
  **Arreglo:** `new TextEncoder().encode(text).length` o
  `request.arrayBuffer()` + `byteLength`.

## Plan de implementación G4

1. F16 primero (una línea, desactiva el estado atascado y la trampa de
   recuperación de F19).
2. F17 y F19 juntos: mismo patrón de precondición `updateTime` + retry, ya
   presente en el fichero. Tests de concurrencia: dos updates simultáneos no
   pierden el paper; dos publish simultáneos no dejan huérfano.
3. F18 con la acción `release` (coordinar con G3, ver Dependencias).
4. F20–F23 en una pasada, cada uno con test.
5. Lo que NO hay que tocar (verificado en buen estado): la verdad de membresía
   en el servidor, el saneado idempotente (tiene tests de regresión de los dos
   bugs históricos), shareIds de 128 bits, el flujo despublicar-antes-de-borrar
   del cliente, y la no-vía de XSS almacenado.
6. Verificación: suite de `public-list-api` y `firestore-admin` en verde,
   `wrangler deploy`, y una pasada real en producción: publicar, editar,
   sincronizar, despublicar una lista de prueba con cuenta propia.

---

# G5 — Caché, cuotas y presupuesto facturado (Worker)

**Ficheros:** `worker/report-api.js`. **Correr después de G2** (mismo fichero;
reutiliza su helper de plazos).

## Fallos

- [ ] **F29 · media · Resultados degradados se cachean a TTL completo**
  `worker/report-api.js:1123-1137` (physics, TTL 6 h) y `:551-601`
  (citation-graph, TTL 7 días).
  En `/sources/physics`, un 500 transitorio de ADS hace servir el fallback
  INSPIRE o un 200 vacío — y `cacheResponse` lo cachea con `s-maxage=21600`:
  un hipo de un segundo deja esa query vacía 6 horas para todos. En
  `/citation-graph`, un fallo de OpenCitations produce `partial: true`…
  cacheado 7 días (`resolveCitationConnections` traga errores con
  `allSettled` y `.catch(() => [])`).
  **Arreglo:** cuando `fallback === true`, `partial === true` o
  vacío-por-fallo-upstream → TTL corto (60–300 s) o `no-store`.
  `cacheResponse` puede aceptar un TTL calculado por el fetcher.

- [ ] **F30 · media · `/report/trends`: clave de caché cruda vs filtro normalizado — quema presupuesto facturado**
  `worker/report-api.js:106-107` (params de clave), `:256-259`
  (normalización), `:261-270` (clave con crudos, 2 fetch por miss).
  La clave usa `categories`/`countries` tal cual; el filtro upstream sale de
  `normalizeReportFilters`, que descarta lo que no esté en
  `REPORT_OPENALEX_FIELDS` o no sea ISO-2. `categories=zzz1`, `zzz2`… →
  misma query upstream, claves distintas: cada variante es un miss con **dos**
  llamadas OpenAlex facturadas ($1/día). Un usuario autenticado sostiene ~120
  llamadas/min, y ninguna pasa por el ledger `openalex:*` (ese techo solo
  cubre `/openalex/*`). El presupuesto diario se agota en decenas de minutos.
  **Arreglo:** (1) clave de caché con los valores ya normalizados (o 400 a
  valores fuera de lista); (2) que trends/citation-graph reserven también
  contra el ledger `openalex:*` proporcionalmente a sus llamadas.

- [ ] **F32 · media · El gate de Origin es consultivo (verificado en vivo)**
  Sondeado contra producción: `/sources/europepmc` y `/openalex/*` devuelven
  200 sin cabecera `Origin` y 403 con Origin no permitido. Un curl sin
  `Origin` (o falsificándolo, que cualquiera puede) atraviesa el gate: la
  única protección real del presupuesto es el techo por minuto — y F30
  muestra rutas fuera de él. A 300/min, las 10.000 llamadas diarias son
  drenables en ~34 min de script.
  **Arreglo:** asumirlo como decisión explícita y compensar: (1) cerrar F30
  para que TODO el gasto facturado pase por el ledger; (2) techo **diario**
  además del por-minuto (el presupuesto es diario, el techo no); (3) opcional,
  exigir la cabecera Origin en rutas de navegador (disuasorio, no frontera).

- [ ] **F33 · baja · Trim asimétrico en la clave de caché**
  `worker/report-api.js:175-178` vs `:1346-1349`. La clave hace
  `value.trim()` pero la URL upstream lleva el valor sin recortar:
  `?filter=x` y `?filter=%20x%20` colisionan en una entrada; gana la primera
  todo el TTL, y el Origin espoofable permite sembrarla desde fuera.
  **Arreglo:** recortar una vez y usar el mismo valor para clave y URL.

## Plan de implementación G5

1. F30 primero (es el agujero facturable), después F32 (techo diario +
   ledger), F29, F33.
2. Cuidado con la claveada por `_origin` de la caché: está bien hecha, no
   romperla al tocar `canonicalCacheKey`.
3. Verificación: tests de clave de caché (misma clave ⇔ misma query upstream),
   `wrangler deploy`, y `/health/openalex` mostrando el presupuesto estable
   tras una tanda de peticiones con parámetros basura (antes del fix, cada
   una costaría dinero).

---

# G6 — Capa cliente y feed

**Ficheros:** `src/services/openAlexClient.js`, `src/services/domainSourceService.js`,
`src/services/arxivService.js`, `src/services/europePmcService.js`,
`src/hooks/useGuestFeed.js`, `src/data/categories.js`.

## Fallos

- [ ] **F31 · media · `x-ratelimit-reset` interpretado como delta sin tope: un epoch bloquearía OpenAlex hasta recargar**
  `src/services/openAlexClient.js:60-62` y `:180-188`;
  `worker/report-api.js:83-90` (relay tal cual).
  `getOpenAlexRateLimitDelay` hace `resetSeconds * 1000` asumiendo
  segundos-hasta-reset; la convención con prefijo `x-` (estilo GitHub) es
  epoch en segundos, y ni un test fija la unidad. Si llega un epoch (~1,77e9),
  el delay resulta ~56 años: `rateLimitedUntil` queda en el futuro remoto y
  TODAS las llamadas OpenAlex del cliente fallan sin salir a red, sin vía de
  limpieza (el reset a 0 solo corre tras una respuesta ok que ya no puede
  producirse). Condicional (requiere 429/403 sin `retry-after`), pero el modo
  de fallo es caída total silenciosa.
  **Arreglo:** tope defensivo `Math.min(delay, 24*3600*1000)` + detección de
  epoch (`> 1e9` → restar `now`), y un test que fije la semántica.

- [ ] **F38 · media · El feed de invitado llama a `/sources/physics`, que exige sesión**
  `src/hooks/useGuestFeed.js:16-23`, `domainSourceService.js:83`
  (`isPhysicsCategory`), `:445-447` (protectedPath), `:537-539`.
  `GUEST_CATEGORIES` incluye `astro-ph.CO` y `quant-ph`, que casan con el
  regex de física, así que `plan.physics` nunca está vacío para invitados.
  Pero `/sources/physics` es `protectedPath`: `authenticatedWorkerFetch` sin
  sesión lanza `WorkerApiAuthError` localmente y el
  `settleWithin`/`allSettled` se lo traga (agravado por F34). Los invitados
  nunca ven física de ADS/INSPIRE pese a pedirla; la rama corre, falla y no
  aporta nada, en cada carga.
  **Arreglo:** condicionar la rama physics a que haya sesión (como ya hace la
  de Scopus con `isScopusEnabled()`), y decidir producto: o quitar las
  categorías de física de `GUEST_CATEGORIES`, o abrir `/sources/physics` a
  invitados con techo por minuto. **Test:** el plan de invitado sin sesión no
  produce ninguna petición a rutas protegidas.

- [ ] **F39 · baja · `q-bio.NC` no existe en el esquema: término basura en la query OpenAlex del invitado**
  `src/hooks/useGuestFeed.js:20` y `:36-45`; `src/data/categories.js:288`.
  El esquema interno usa `bio.neuro`; `q-bio.NC` solo aparece en el mapa de
  prefijos de área, no como subcategoría, así que `categoryLabel('q-bio.NC')`
  devuelve el id literal y la query de descubrimiento busca `"q-bio.NC"` como
  texto — término muerto en una llamada facturada. Tampoco activa ninguna
  fuente bio del plan de dominio.
  **Arreglo:** sustituir por `bio.neuro` en `GUEST_CATEGORIES` (la rama
  PubMed del invitado ya usa esa forma) y hacer que `categoryLabel` avise en
  dev cuando devuelve el id literal.

- [ ] **F34 · baja · Los fallos de fuentes del feed se tragan sin dejar rastro**
  `src/services/domainSourceService.js:575-578`. El `Promise.allSettled`
  descarta los `rejected` sin log: un 401 sistemático, un 429 de cuota o una
  caída de `/sources/*` son indistinguibles de «esa fuente no tenía
  resultados». Es lo que ocultaba F38.
  **Arreglo:** loggear los `rejected` con path de fuente y código.

- [ ] **F35 · baja · Parámetro muerto `schema: 4` hacia `/sources/physics`**
  `src/services/domainSourceService.js:541`. El Worker no lo lee y no figura
  en `CACHE_PARAMS_BY_PATH['/sources/physics']`.
  **Arreglo:** eliminarlo del cliente (o implementarlo y añadirlo a los cache
  params, si era un versionado pendiente).

- [ ] **F37 · baja · Comillas dobles corrompen la sintaxis de consulta de arXiv**
  `src/services/arxivService.js:305` (`au:"${authorName}"`) y `:341`
  (`all:"${queryStr}"`). No es inyección de URL (`URLSearchParams` codifica),
  pero un `"` en el nombre o la búsqueda rompe el emparejado de comillas de
  la query de arXiv → resultados vacíos o erróneos en silencio.
  **Arreglo:** `.replace(/"/g, '')` antes de interpolar.

- [ ] **F42 · baja · Europe PMC mapeado dos veces con dos formas de paper**
  `src/services/europePmcService.js:114-137` vs
  `domainSourceService.js` (`mapEuropePmcSearchResult`). La misma API mapeada
  por dos funciones independientes que pueden divergir — la forma exacta de
  deuda que ya mordió dos veces (el filtro `openalex:` roto años, el índice
  invertido ×4).
  **Arreglo:** extraer un `mapEuropePmcRecord` común (como se hizo con
  `buildOpenAlexIdFilter` y `openAlexAbstract.js`).

## Plan de implementación G6

1. F38+F39 juntos (mismo fichero, misma causa de fondo: el routing por Sets
   hardcodeados no avisa de olvidos). F34 en la misma pasada — es lo que
   habría hecho visibles a los otros dos.
2. F31 con su test de unidades; F35, F37, F42 mecánicos.
3. Verificación: `npm test` + `npm run build`, y en vivo con el dev server:
   cargar el feed **como invitado** con la consola abierta — cero
   `WorkerApiAuthError`, y la query OpenAlex del invitado sin `"q-bio.NC"`
   (mirar la petición en la pestaña Network).

---

# G7 — Despliegue: encender Scopus de verdad

**Ficheros:** ninguno del repo (variables de GitHub) + verificación del bundle.

- [ ] **F40 · media · Scopus está apagado en el bundle de producción pese a la decisión registrada de encenderlo**
  Verificado en vivo el 23-08-2026: el bundle desplegado
  (`assets/index-DU0AKCXZ.js` en `mugar123.github.io/papertok`) compila
  `isScopusEnabled` a `false` constante (`ag=!1`). STATE.md registra la
  decisión del 22-08 de encender Scopus en todas las superficies, y el lado
  servidor funciona (`/health/scopus`: `available: true`). El flag viene de
  `vars.VITE_SCOPUS_ENABLED` en `.github/workflows/deploy.yml:44`
  (`.env.example` lo tiene a `false`): o la variable de repo nunca se puso, o
  un despliegue posterior la perdió. Toda la rama Scopus del cliente
  (`ScopusAdapter`, la rama `plan.scopus` de `getDomainSourcePlan`) es código
  muerto en producción — la integración que costó el proxy en Deno no corre.
  **Plan:** (1) poner `VITE_SCOPUS_ENABLED=true` en las Variables del
  repositorio de GitHub (Settings → Secrets and variables → Actions →
  Variables) — esto tiene que hacerlo alguien con acceso al repo, no una
  sesión de Claude sin gh auth con permisos. (2) Redesplegar el frontend
  (push o re-run del workflow). (3) **Verificar el bundle**: descargar el
  `assets/index-*.js` nuevo y comprobar que el flag ya no compila a `!1`
  (buscar el contexto de `scopus` minificado), o directamente cargar el feed
  con sesión y ver peticiones a `/sources/scopus` en Network. (4) Añadir un
  check post-deploy (paso del workflow o script) que compare el flag esperado
  con el bundle publicado — esta clase de discrepancia ya ha pasado dos veces
  en dos direcciones y no se detecta sola.

---

# G8 — PubMed y Semantic Scholar detrás del Worker

**Ficheros:** `worker/report-api.js` (rutas nuevas), `wrangler.toml`,
`src/services/adapters/PubmedAdapter.js`, `src/services/semanticScholarService.js`,
`src/services/europePmcService.js` (opcional). **Correr después de G2/G5**
(reutiliza el helper de plazos y no pisar el fichero).

- [ ] **F41 · media · PubMed, Europe PMC y Semantic Scholar se llaman directo del navegador**
  `src/services/adapters/PubmedAdapter.js:127-197`,
  `src/services/europePmcService.js:137`,
  `src/services/semanticScholarService.js:10-24`.
  Trece fuentes pasan por el Worker; estas tres no. PubMed E-utilities va sin
  API key de NCBI (3 req/s por IP: usuarios tras la misma salida NAT comparten
  el límite y se provocan 429 mutuamente) y sus tres fetch encadenados no
  llevan señal de aborto. El limitador de Semantic Scholar es una variable de
  módulo (`lastRequestTime`): serializa por pestaña, no global — N pestañas
  son N veces el límite de S2 — y su `fetch(url)` tampoco lleva plazo. Nada
  de esto tiene caché de edge ni pasa por los ledgers de cuota.
  **Plan:**
  1. Ruta `/sources/pubmed` en el Worker con el patrón de las nueve
     existentes: lista de parámetros en `CACHE_PARAMS_BY_PATH`, caché de
     edge, plazo (helper de G2), techo por minuto en el ledger. Sacar una API
     key de NCBI (gratuita, sube el límite a 10 req/s) y ponerla como secreto
     de wrangler — la pide @mugar, no va en el repo.
  2. Ruta `/sources/s2` (o `/related` ampliada) para las recomendaciones de
     Semantic Scholar, con el rate limit en el Worker (global de verdad) en
     vez de la variable de módulo.
  3. Migrar `PubmedAdapter` y `semanticScholarService` a las rutas nuevas.
     Mantener el contrato de campos (los mappers no cambian).
  4. Europe PMC es opcional en esta tanda (al menos lleva AbortController);
     migrarla iguala la simetría y le da caché. Si se hace, aprovechar para
     F42 (mapper común).
  5. Verificación: feed en dev server con Network abierto — cero llamadas
     directas a `eutils.ncbi.nlm.nih.gov` ni `api.semanticscholar.org`;
     tests de contrato de las rutas nuevas; `wrangler deploy` antes que el
     frontend (orden: Worker primero, como siempre).

---

# Observaciones de arquitectura (sin número — contexto para cualquier grupo)

- **El fan-out del feed (~13 upstreams para quedarse con 15 papers)** es
  decisión de producto (diversidad de fuentes), no un bug — pero hace el
  sistema caro en rate limits ajenos. Si algún día se recorta, el prerequisito
  es el punto siguiente.
- **El routing categoría→fuente vive en cinco Sets hardcodeados más dos regex**
  (`BIORXIV_CATEGORIES`, `OSTI_CATEGORIES`, `NASA_CATEGORIES`,
  `INSPIRE_PHYSICS_CATEGORIES`, `HUGGING_FACE_CATEGORIES` en
  `domainSourceService.js`). Añadir una categoría obliga a tocar varios sitios
  sin aviso si falta uno — F38 y F39 son exactamente dos olvidos de esa forma.
  Un plan declarativo por fuente (tabla única: categoría → fuentes → auth
  requerida → mapper) los habría hecho imposibles. Candidato natural si G6 o
  G8 tocan mucho ese fichero.
- **OpenAlex hace tres trabajos bajo un solo techo global de 300/min**
  (descubrimiento, enriquecimiento por página, entidades seguidas), sin
  reparto invitados/autenticados. Recogido operativamente en F30+F32: primero
  que todo el gasto facturado pase por el ledger con techo diario; el reparto
  fino es decisión posterior.
- **Áreas verificadas y en buen estado** (no re-auditar sin motivo): contrato
  de campos Gemini↔Kimi, atomicidad de los tres Durable Objects, lista blanca
  de `/openalex/*`, saneado anti-inyección de Scopus/emails/listas públicas,
  CORS sin reflejo arbitrario, tokens de unsubscribe, deduplicación de
  peticiones del cliente, cascada de proxies CORS muertos ya eliminada.
