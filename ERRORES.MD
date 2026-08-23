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

**G4 arreglado el 23-08-2026** (F16, F17, F18, F19, F20, F21, F22, F23): los
ocho re-verificados y los ocho reales, con dos correcciones de diagnóstico
propias (F16 es más grave, F19 más estrecho) y **la mitad `release` de F18
rechazada por análisis** — ver F18. 30 tests nuevos (1.001 → 1.031), cada uno
verificado por mutación, `npm run check` en verde y la suite en verde bajo Node
22, que es lo que corre CI.

**G5 cerrado el 24-08-2026** (F29, F30, F32, F33): los cuatro re-verificados y
los cuatro reales, con **dos ampliaciones de diagnóstico** (F30 no son dos
parámetros de `/report/trends` sino las trece rutas cacheadas; F29 no puede usar
`partial` como señal y su peor caso ni siquiera la enciende) y **el punto 3 de
F32 —exigir la cabecera `Origin`— analizado y rechazado**, ver F32. 21 tests
nuevos (1.067 → 1.088), 18 mutaciones y 18 mutantes muertos, `npm run check` en
verde y la suite en verde bajo Node 22. Verificado en producción con número:
20 variantes de espacios de una misma query costaban **21** llamadas facturadas
antes del deploy y **2** después.

**G8 cerrado el 24-08-2026** (F41): re-verificado y real, con cuatro correcciones
de diagnóstico propias y el punto 4 (Europe PMC) declarado fuera de alcance por
solaparse con G6. 24 tests nuevos (1.106 → 1.132), cada arreglo verificado por
mutación sin mutantes vivos, `npm run check` en verde y la suite en verde bajo
Node 22. Worker desplegado antes que el frontend y las dos rutas sondeadas en
vivo. **Pendiente de @mugar:** los secretos
`SEMANTIC_SCHOLAR_API_KEY` (que nunca se configuró y sin la cual S2 no responde)
y `NCBI_API_KEY` (opcional, sube PubMed a 10 req/s).

**G3 arreglado el 23-08-2026** (F6, F7, F8, F9, F10, F11, F12, F13, F14, F15):
los diez re-verificados y los diez reales, con dos correcciones de diagnóstico
propias (el punto 3 de F8 ya estaba hecho; la fuga de F14 no era solo de caché).
25 tests nuevos (33 → 58 en las suites del grupo), cada arreglo verificado por
mutación sin mutantes vivos, `npm run check` en verde y 1.064 tests en verde
bajo Node 22, que es lo que corre CI.

**G6 arreglado el 24-08-2026** (F31, F34, F35, F37, F38, F39, F42): los siete
re-verificados y los siete reales, con tres correcciones de diagnóstico propias
(F38 es más ancho — son tres rutas protegidas, no una; F31 tenía un gemelo en
`retry-after`; F39 cuesta la precisión `cat:` de arXiv, y se aceptó a
sabiendas). 16 tests nuevos (1.088 → 1.104 al apilarse sobre G5), cada arreglo
verificado por mutación sin mutantes vivos, `npm run check` en verde y la suite
entera en verde bajo Node 22 —que es lo que corre CI— y verificación en vivo del
feed de invitado con el dev server: cero `WorkerApiAuthError`, cero peticiones a
rutas protegidas y la query de OpenAlex sin `"q-bio.NC"`.

G7 cerrado el 23-08-2026: **F40 re-verificado y RECHAZADO** por mal
diagnosticado (el bundle apagado era la decisión vigente, no una deriva). Se
arregló en su lugar la causa raíz que el propio F40 nombra en su punto 4 — nada
ataba el estado previsto del flag al bundle publicado. 7 tests nuevos, 1.001 en
verde, guarda verificada por mutación en las dos direcciones.

**Verificación independiente del 24-08-2026 (G3, G4, G7):** los 18 fallos de
G3+G4 re-verificados de forma adversaria contra main — **los 18 ARREGLADOS**
(G3: 6 mutaciones, 6 mutantes muertos; G4: 10 mutaciones, 9 muertos — el vivo
es un hueco de test, no de código, anotado abajo). Las correcciones de
diagnóstico de ambas sesiones se sostienen contra el código pre-arreglo, y el
rechazo de la mitad `release` de F18 es sólido (un 409 reembolsable daría
reintentos gratis contra lecturas reales de Firestore). **El rechazo de F40
(G7) es CORRECTO y verificado**: la decisión de apagar Scopus (`b26418a`,
22-08 02:14) es 62 min posterior a la de encender (`ad4dcd5`, 01:12) — la
auditoría leyó la vieja; `gh variable list` confirma que la variable nunca
existió, y la guarda de build nueva verificada en vivo
(`VITE_SCOPUS_ENABLED=true npm run build` falla con «declared false, this
build would ship true»). 1.064 tests en verde. Despliegue verificado: Worker
con G4+G3 (deploys 23:25 y 23:57 del 23-08, `/health/ai` en verde según
STATE.md, y cubren también el `55444c6` pendiente de la verificación
anterior); frontend con F13 y todo lo de cliente (Action en verde del 24-08
00:14). Huecos menores anotados por los verificadores, ninguno bloqueante:
(G3) el éxito con `usage` ausente cobra la reserva íntegra sin test ni
documentación, el settle no-op de una reserva barrida sin test, el fallback
tras cooldown no respeta `minGeminiFallbackMs`; (G4) ningún test fija que el
retry del merge relee la membresía fresca (el código sí lo hace), y los datos
ya corrompidos por el F16 pre-arreglo no se curan (previene, no repara).

**Verificación independiente del 23-08-2026 (tarde):** los 12 fallos de G1+G2
re-verificados de forma adversaria contra el código de main — los 12 ARREGLADOS,
con mutation testing confirmando que cada test de regresión falla al revertir su
arreglo. 994 tests en verde. Despliegue verificado en vivo: Worker y proxy Deno
desplegados con G1+G2 (`/health/email` sirve con `s-maxage=300`), frontend
desplegado con `55444c6` (Action en verde, bundle `index-BFoeehHB.js`). **El
Worker de producción NO incluye `55444c6`** (el endurecimiento de
`fetchWithDeadline` con `AbortSignal.any`; el último deploy es de las 18:56 y el
commit de las 19:34) — no es un agujero vivo (ningún llamante actual pasa señal),
pero conviene un `wrangler deploy` antes de que G5/G8 usen el helper.

**Residuo detectado en la verificación — CERRADO el 24-08-2026**, y con él una
segunda instancia del mismo patrón que ninguna ficha había visto (ver abajo):

- [x] **F2-residuo · baja · `fetchDigestSource` conserva el patrón viejo de plazo solo-cabeceras**
  `worker/email-notifications.js:527-552`: `clearTimeout` en `finally` y
  devuelve el `Response` **sin leer**; los llamantes hacen `response.json()`
  fuera del bloque cubierto (p. ej. `:1007`). Es la única instancia viva del
  patrón F2 en todo el repo: quedó fuera de G2 (fichero vetado por ser de G1) y
  fuera del alcance declarado de la parte email de F3 (que solo cubría
  identitytoolkit y las dos sondas). Impacto acotado: corre dentro del cron con
  presupuesto propio de 12 min, no en el camino de una petición de usuario.
  **Arreglo:** el mismo de F2 — leer el cuerpo dentro del bloque cubierto o
  usar `AbortSignal.timeout` sin `clearTimeout`.

  **Cerrado el 24-08-2026, con una corrección al diagnóstico: NO era la única
  instancia.** Había una **segunda** en el mismo fichero, sin documentar en
  ninguna ficha y de impacto **mayor** que la que sí lo estaba: un
  `fetchWithDeadline` local en `:1596-1603`, con la forma vieja exacta
  (`return await fetch(...)` en el `try`, `clearTimeout` en el `finally`,
  `Response` sin leer) y cinco llamantes que leen el cuerpo ya fuera de
  cobertura — el lookup de Identity Toolkit de `:714`, que está **delante de
  toda ruta de email protegida** (justo el escenario que F3 llamó «el más
  delicado»), los envíos Brevo (`:1612`) y Resend (`:1658`), y las dos sondas
  que respaldan `/health/email` (`:2064`, `:2098`). El argumento de impacto
  acotado de esta ficha —«corre dentro del cron»— solo describía
  `fetchDigestSource`.

  **Por qué sobrevivió al barrido:** no es un resto de nada, lo **introdujo** el
  propio arreglo email de F3 (G1), escrito con la forma vieja; y se llama igual
  que el helper *correcto* de `report-api.js:382`, así que al barrer se lee como
  ya arreglado. Su test de G1 (`gives the identity lookup and both provider
  probes a deadline`) solo comprobaba `signal instanceof AbortSignal` — que se
  pasara una señal, no que siguiera armada al leer el cuerpo. Ese es el hueco
  exacto por el que pasó.

  Los dos usan ya `AbortSignal.timeout`; el helper local es ahora idéntico al de
  `report-api.js`, `AbortSignal.any` incluido, para que compartir el nombre deje
  de significar contratos distintos. Se ajustó además la clasificación de
  `:544`: `AbortSignal.timeout` levanta `TimeoutError`, no `AbortError`, así que
  sin tocarla un plazo agotado real habría pasado a codificarse
  `EMAIL_SOURCE_*_UNAVAILABLE` en vez de `_TIMEOUT`. 5 tests nuevos
  (1.104 → 1.109), 4 mutaciones y 4 mutantes muertos —una de ellas, dejar que
  una señal del llamante *reemplace* el plazo, sobrevivió a la primera tanda y
  obligó a añadir un quinto test—, `npm run check` en verde y la suite entera en
  verde bajo Node 22, que es lo que corre CI. **Pendiente de `wrangler deploy`:
  el cambio es del Worker.**

  **Verificado también:** los cinco puntos originales de F2 siguen arreglados, y
  ya no queda ninguna instancia del patrón en `src/`, `worker/` ni `proxy/` — se
  revisaron los ~20 `clearTimeout` restantes uno a uno, y todos leen el cuerpo
  dentro del bloque cubierto, que es el discriminante real (no la presencia del
  `clearTimeout`).

**Estado en vivo al auditar** (23-08-2026): `/health` todo en verde; OpenAlex
$0,97/1,00 de presupuesto diario; Scopus servidor disponible (19.988/20.000).
Casi todo lo de abajo es latente — salvo F24 (activo en producción). ~~y F40
(discrepancia de despliegue activa)~~ **F40 no era una discrepancia**: ver G7.

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
| F40 | ~~media~~ | G7 | ~~Scopus apagado en el bundle de producción~~ — **RECHAZADO**: mal diagnosticado |
| F41 | media | G8 | PubMed/Europe PMC/S2 directos del navegador |
| F42 | baja | G6 | Europe PMC mapeado dos veces |

## Dependencias entre grupos

- **G2 y G5 tocan los dos `worker/report-api.js`.** No los corras en paralelo.
  Orden recomendado: G2 primero (crea el helper de fetch-con-plazo que G5 puede
  reutilizar).
- ~~**G3 (F8) y G4 (F18) necesitan los dos una acción `release` en
  `worker/request-quota-ledger.js`.**~~ **G4 pasó por aquí el 23-08-2026 y NO la
  implementó**, a propósito: en la ruta de listas el reembolso desacota las
  lecturas de Firestore (razonamiento completo en F18). El ledger sigue con solo
  `reserve`. **G3 la añadió el 23-08-2026** (`action: 'release'` +
  `releaseRequestQuota`, con suelo en 0 y el `periodKey` viajando con la
  reserva), para F8 —donde el reembolso
  es por fallo de proveedor, no por una carrera que el llamante puede provocar—
  y en ese caso la implementa entera, sin nadie con quien coordinarse.
- **F3 se reparte**: los fetch sin plazo de `email-notifications.js` los arregla
  G1 (para no pisar el fichero); el resto, G2.
- ~~**G7 (F40) es solo configuración + redeploy del frontend**~~ — resultó no
  serlo: F40 estaba mal diagnosticado y no había nada que configurar. G7 acabó
  tocando `vite.config.js` y añadiendo `src/utils/deployFlags.js`; ningún otro
  grupo toca esos ficheros.
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

- [x] **F6 · media · Cualquier fallo de Modal liquida la reserva completa como gasto del mes**
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

- [x] **F7 · media · `classifyKimiError` clasifica por substring: un 5xx → «presupuesto agotado hasta el mes que viene»**
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

- [x] **F8 · media · La cuota diaria se consume antes de llamar al proveedor y no se devuelve nunca**
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

- [x] **F9 · media · El peor caso serial (~105 s) revienta el presupuesto del navegador (70 s)**
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

- [x] **F10 · media · Reservas Kimi huérfanas sin expiración: restan presupuesto todo el mes**
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

- [x] **F11 · baja · Reserve y settle pueden caer en DOs de meses distintos**
  `worker/ai-explanation.js:730-748`. `callKimiBudgetLedger` recalcula
  `kimiPeriod()` por llamada: reservar a las 23:59:59 UTC del día 31 y
  liquidar tras medianoche liquida contra el DO del mes nuevo (la reserva no
  existe ahí; el gasto real no se contabiliza).
  **Arreglo:** calcular el periodo una vez en `explainWithKimi` y pasarlo a
  ambas llamadas.

- [x] **F12 · baja · Un 400 permanente de Gemini se reintenta en flash-lite**
  `worker/ai-explanation.js:503-511` y `:608-611`. Un `INVALID_ARGUMENT` sin
  patrón de api-key/permiso/modelo cae en `AI_UNAVAILABLE` (reintentable): se
  repite la misma petición inválida contra flash-lite (hasta 32 s más), y el
  cliente recibe 502 para una condición determinista, quemando el uso diario.
  **Arreglo:** código no reintentable `AI_INVALID_REQUEST_UPSTREAM` excluido
  de `shouldRetryGeminiWithFallback`.

- [x] **F13 · baja · El cliente convierte el fallo de autenticación en «IA no disponible»**
  `src/services/aiExplanationService.js:123-126`. El `catch` no distingue
  `WorkerApiAuthError` y lo reduce a `AI_UNAVAILABLE`: sesión expirada con la
  sheet abierta → «servicio no disponible» en vez de invitar a re-login.
  **Arreglo:** mapear a `AI_AUTH_REQUIRED` con su copy.

- [x] **F14 · baja · El saldo mensual de Kimi se cachea 7 días y se sirve a todos**
  `worker/ai-explanation.js:872-873` y `:1088-1100`. `result.budget`
  (cap $27 + saldo) entra en `cacheableResponse` una semana: detalle
  financiero del operador, obsoleto, servido a cualquiera.
  **Arreglo:** excluir `budget` del objeto cacheado.

- [x] **F15 · baja · Config confusa (dos puntos)**
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
`worker/firestore-admin.js`, ~~`worker/request-quota-ledger.js` (release,
compartida con G3)~~ — el ledger no se tocó. Tests:
`public-list-api.test.js`, `firestore-admin.test.js`, y dos nuevos:
`worker/firebase-auth.test.js` y `src/test-support/firebaseIdToken.js`.
El pre-filtro de F20 obligó además a actualizar los fixtures de token de
`worker/report-api.test.js` (G2/G5) y `worker/ai-explanation-fallback.test.js`
(G3) — cuatro líneas, solo el literal del token.

## Fallos

- [x] **F16 · media · `/lists/unpublish` confía en el `listId` del body: estado atascado permanente**
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

- [x] **F17 · media · Dos syncs concurrentes del mismo dueño pueden perder un paper de forma persistente**
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

- [x] **F18 · media · La cuota se cobra antes de validar y no se devuelve: DoS del global**
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
  **HECHO (23-08-2026), con la segunda mitad RECHAZADA.** La reserva va ahora
  tras una validación pura por ruta (`OPERATIONS` pasó a `{validate, run}`), así
  que nada que no llegue a Firestore cobra. La acción `release` **no se
  implementó**: reabre un agujero peor que el que cierra. `/lists/update`
  conserva un write con `mustExist: true` sobre la lista privada, así que una
  lista privada borrada hace que todas sus sincronizaciones den 409 para
  siempre — cada una gastando 3-4 lecturas de Firestore y recuperando la unidad;
  y un atacante puede provocar 409 de carrera contra su propia lista a voluntad.
  Reembolsar los deja gratis y desacota las lecturas del plan gratuito, que es
  exactamente lo que el cobro protegía. **G4 no añadió la acción compartida ni
  la consume**; si G3 (F8) la implementa para su caso —donde el reembolso es por
  fallo de proveedor y no por una carrera que el llamante provoca— la ruta de
  listas seguirá sin llamarla, a propósito.

- [x] **F19 · media · Doble publish concurrente crea un documento público huérfano**
  `worker/public-list-api.js:380-413`. El check `ALREADY_PUBLISHED` (`:381`)
  es check-then-act y el `mergeWrite` del puntero (`:395-397`) no lleva
  precondición: dos publish concurrentes generan shareIds distintos, ambos
  commits pasan, el puntero queda en el último y el otro share queda huérfano
  público legible. Intentar limpiarlo con unpublish dispara F16. El test de
  `:321` solo cubre el caso secuencial.
  **Arreglo:** leer la lista privada con `withMeta` y pinear el write del
  puntero a su `updateTime`: el perdedor falla el commit entero (ya mapeado a
  `PUBLISH_CONFLICT` 409). Mismo patrón que F17.

- [x] **F20 · baja · Cada token basura de ≤8 KB dispara una llamada a Identity Toolkit**
  `worker/firebase-auth.js:20-43`. No hay ni un check de forma JWT
  (`[^\s]+` hasta 8192): peticiones anónimas con strings basura consumen una
  llamada upstream cada una. (El diseño de delegar la verificación en
  `accounts:lookup` es correcto; no cambiarlo.)
  **Arreglo:** pre-filtro local sin verificar firma — tres segmentos
  base64url, `exp` no vencido, `aud` = projectId.

- [x] **F21 · baja · El token OAuth de la service account no se invalida tras un 401 de Firestore**
  `worker/firestore-admin.js:125-149` (cache por isolate, margen 300 s) y
  `:222-228` (`authorizedFetch` no reacciona al status). Tras rotar la clave,
  el token cacheado sigue sirviéndose hasta ~55 min: cada petición 401 → 502
  sin re-mint.
  **Arreglo:** ante 401/403, `tokenCache.delete(email)` y reintentar una vez
  con token fresco.

- [x] **F22 · baja · `requireListId` acepta `.` y `..`**
  `worker/public-list-api.js:87-93`; `firestore-admin.js:210-217`
  (`documentName` rechaza `/` pero no segmentos-punto). Con `listId: '..'` la
  URL del GET de propiedad se normaliza a `…/documents/users/{uid}`:
  comprobación contra documento equivocado (contenido al propio subárbol; el
  write posterior falla) + cuota quemada.
  **Arreglo:** rechazar `.` y `..` en `requireListId` y, en defensa en
  profundidad, en `documentName`.

- [x] **F23 · baja · `readBody` mide el límite en UTF-16, no en bytes**
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
3. ~~F18 con la acción `release` (coordinar con G3, ver Dependencias).~~ F18 se
   cerró con la validación por delante de la reserva; la acción `release` quedó
   rechazada (ver F18) y el ledger no se tocó.
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

- [x] **F29 · media · Resultados degradados se cachean a TTL completo** — REAL,
  arreglado el 24-08-2026, con dos correcciones de diagnóstico:
  `worker/report-api.js:1123-1137` (physics, TTL 6 h) y `:551-601`
  (citation-graph, TTL 7 días).
  En `/sources/physics`, un 500 transitorio de ADS hace servir el fallback
  INSPIRE o un 200 vacío — y `cacheResponse` lo cachea con `s-maxage=21600`:
  un hipo de un segundo deja esa query vacía 6 horas para todos. En
  `/citation-graph`, un fallo de OpenCitations produce `partial: true`…
  cacheado 7 días (`resolveCitationConnections` traga errores con
  `allSettled` y `.catch(() => [])`).
  **Corrección 1: `partial === true` no sirve como señal.** También se pone a
  `true` en un camino sano y deliberado —`cited_by_count > 300` va a OpenAlex a
  propósito—, así que la regla propuesta habría acortado el TTL de los papers
  más citados sin que nada fallara. Hay ahora un campo aparte, `degraded`, que
  solo enciende un fallo real; `partial` conserva su significado (el cliente lo
  lee en `citationGraphService.js`).
  **Corrección 2: el peor caso ni siquiera encendía `partial`.**
  `fetchOpenAlexCurrentWork` tragaba cualquier error y devolvía `null`; con
  OpenCitations vacío, la ruta respondía `{references: [], citations: [],
  partial: false}` y lo cacheaba 7 días. Igual con los `allSettled` de
  `fetchOpenAlexWorksByFilter`: un lote rechazado devolvía menos papers sin
  dejar rastro.
  **Arreglo:** `cacheResponse` acepta un TTL calculado sobre el payload y
  `DEGRADED_CACHE_SECONDS = 120` sustituye al TTL completo cuando la respuesta
  es degradada: en physics, `fallback === true` salvo `ads_not_configured`
  (sin ADS, INSPIRE *es* la respuesta buena y merece sus 6 h); en
  citation-graph, `degraded === true`. Un TTL corto tampoco arrastra ya
  `stale-while-revalidate=86400`, ni deja el `max-age` del navegador por
  encima del `s-maxage` del edge. Los errores upstream llevan ahora su
  `status`, para distinguir un 404 de OpenAlex (una respuesta) de una caída
  (un fallo).

- [x] **F30 · media · `/report/trends`: clave de caché cruda vs filtro normalizado — quema presupuesto facturado** — REAL y **más amplio**, arreglado el 24-08-2026:
  `worker/report-api.js:106-107` (params de clave), `:256-259`
  (normalización), `:261-270` (clave con crudos, 2 fetch por miss).
  La clave usa `categories`/`countries` tal cual; el filtro upstream sale de
  `normalizeReportFilters`, que descarta lo que no esté en
  `REPORT_OPENALEX_FIELDS` o no sea ISO-2. `categories=zzz1`, `zzz2`… →
  misma query upstream, claves distintas: cada variante es un miss con **dos**
  llamadas OpenAlex facturadas ($1/día). Un usuario autenticado sostiene ~120
  llamadas/min, y ninguna pasa por el ledger `openalex:*` (ese techo solo
  cubre `/openalex/*`). El presupuesto diario se agota en decenas de minutos.
  **Ampliación de diagnóstico: no son dos parámetros, son las trece rutas
  cacheadas.** El mismo desajuste está en `/citation-graph` (`normalizeCitationDoi`
  pasa a minúsculas y quita el prefijo `doi.org`: 2ⁿ claves por query), en todas
  las `/sources/*` y `/related` (`limit=11..99` y `page` fuera de rango se
  recortan upstream y se guardan crudos), en `/enrich/icite` (`pmids` se
  deduplica) y en `/resources/huggingface` (`2401.1234v2` ≡ `2401.1234`).
  Medido: `/report/trends` sí exige sesión (401 sin token), pero la cuenta es
  autoservicio y sostiene 60 misses/min × 2 llamadas; `/citation-graph` gasta
  hasta 9 por miss.
  **Arreglo:** (1) `canonicalCacheKey` se construye ahora **solo** con los
  valores que el handler va a mandar upstream —la lista blanca
  `CACHE_PARAMS_BY_PATH` desaparece y cada una de las quince llamadas a
  `cacheResponse` declara los suyos—, así que `categories=zzz1` y `zzz2`
  colapsan en la misma entrada y no hace falta el 400 a valores fuera de lista;
  `/arxiv` y `/openalex/*` derivan la clave de la URL upstream ya construida,
  que es la única forma de que las dos no puedan divergir. Sale `sort` de la
  clave en core, scopus y biorxiv: esos upstreams no lo leen. (2) trends y
  citation-graph reservan contra el ledger `openalex:*` por lo que gastan (2 y
  9), lo que obligó a añadir un `amount` al Durable Object — la única salida
  deliberada de los ficheros declarados para G5. G3 aterrizó en main con su
  `release` mientras esto se escribía, y las dos mitades se fusionaron a mano en
  el rebase: el `release` devuelve ahora `amount` unidades y no una, con su test,
  porque devolverle una a quien reservó nueve fuga ocho en cada reembolso.

- [x] **F32 · media · El gate de Origin es consultivo (verificado en vivo)** — CONFIRMADO otra vez en vivo el 24-08-2026 y compensado; **el punto 3 rechazado por análisis**:
  Sondeado contra producción: `/sources/europepmc` y `/openalex/*` devuelven
  200 sin cabecera `Origin` y 403 con Origin no permitido. Un curl sin
  `Origin` (o falsificándolo, que cualquiera puede) atraviesa el gate: la
  única protección real del presupuesto es el techo por minuto — y F30
  muestra rutas fuera de él. A 300/min, las 10.000 llamadas diarias son
  drenables en ~34 min de script.
  **Arreglo:** asumido como decisión explícita y compensado. (1) y (2) hechos:
  todo el gasto facturado pasa por el ledger (ver F30) y hay techo **diario**,
  `OPENALEX_GLOBAL_DAILY_LIMIT = 8000`, reservado antes del trabajo. La
  aritmética, medida ese día en `/health/openalex`: $1/día = 10.000 llamadas,
  menos el cron de digests —que gasta fuera de este ledger, es fichero de G1— y
  la sonda de salud (≤144/día) → ~2.000 de margen. El `retry-after` del techo
  diario es 300 s a propósito y no los segundos que faltan hasta medianoche UTC:
  un `retry-after` de horas es un cliente que deja de preguntar hasta que
  alguien recarga la pestaña.
  **(3) RECHAZADO por análisis.** Exigir `Origin` no es una frontera —cualquiera
  la pone con `curl -H`—, así que lo único que compraría es romper el ops
  legítimo (incluida la sonda en vivo que verificó este mismo grupo) a cambio de
  cero seguridad. La frontera es el techo diario, y ya está puesta. Queda
  documentado en `worker/README.md` para que no se vuelva a contar el gate de
  origen como una de las protecciones del presupuesto.

- [x] **F33 · baja · Trim asimétrico en la clave de caché** — REAL, arreglado el 24-08-2026 y **medido en producción**:
  `worker/report-api.js:175-178` vs `:1346-1349`. La clave hace
  `value.trim()` pero la URL upstream lleva el valor sin recortar:
  `?filter=x` y `?filter=%20x%20` colisionan en una entrada; gana la primera
  todo el TTL, y el Origin espoofable permite sembrarla desde fuera.
  El mismo desajuste estaba en `/arxiv` (`safeArxivParam` no recortaba) y en
  `/related` (`paper_id` iba crudo upstream).
  **Medido contra producción**, 20 variantes de espacios de una misma query
  contra `/openalex/works`, leyendo `x-ratelimit-remaining` antes y después:
  **21 llamadas facturadas antes del deploy, 2 después** (las 20 variantes
  colapsan en 1, más la sonda).
  **Arreglo:** recortado una vez, en `openAlexTargetUrl` y en `safeArxivParam`,
  y la clave se deriva de la URL upstream ya construida. Un valor que queda
  vacío al recortar ya no se manda: colisiona con no mandar nada, que es lo que
  significa.

## Plan de implementación G5 — ejecutado el 24-08-2026

1. Hecho en ese orden. F30 y F33 resultaron ser el mismo defecto visto desde
   dos lados, y se arreglaron con un solo mecanismo.
2. La claveada por `_origin` sigue intacta.
3. Verificación: 21 tests nuevos (1.067 → 1.088), **18 mutaciones y 18 mutantes
   muertos** —dos de ellos sobrevivieron a la primera pasada porque sus tests
   pasaban por el motivo equivocado (uno lo mataba la ruta de citing-works, no
   el lote; el otro el techo global, no el de sujeto) y hubo que afilarlos—,
   `npm run check` en verde, suite en verde bajo Node 22, `wrangler deploy`
   (versión `85c79bc6`, ver la nota de despliegue en STATE.md) y la medida en vivo de F33: 21 llamadas facturadas
   antes, 2 después. Barrido de las veinte rutas en producción: todas responden
   lo que deben. Dos 502 comprobados como caídas ajenas y no regresiones —
   Hugging Face devuelve 404 para un `arxiv_id` que no indexa (con uno real,
   200, y su variante `v3` comparte entrada) y OSTI no responde ni a un `curl`
   directo de 25 s.
   `/health/openalex` no sirve para esta medida: está cacheado 10 min en el
   edge, así que el contador se lee en `x-ratelimit-remaining`, que
   `/openalex/*` ya relaya.

---

# G6 — Capa cliente y feed

**Ficheros:** `src/services/openAlexClient.js`, `src/services/domainSourceService.js`,
`src/services/arxivService.js`, `src/services/europePmcService.js`,
`src/hooks/useGuestFeed.js`, `src/data/categories.js`.

## Fallos

- [x] **F31 · media · `x-ratelimit-reset` interpretado como delta sin tope: un epoch bloquearía OpenAlex hasta recargar** — arreglado el 24-08-2026
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

  **Re-verificado y arreglado, con un gemelo que la ficha no nombraba:**
  `retry-after` (`:57-58`) tampoco tenía tope, así que un
  `retry-after: 999999999` de cualquier intermediario abría el mismo circuito
  irrecuperable. Las dos ramas salen ahora por el mismo clamp
  (`boundRateLimitDelay`), un delay que quede en cero o negativo cae al default
  de 60 s en vez de decir «no limitado», y el epoch se detecta por umbral. 4
  tests nuevos, incluido uno que comprueba que el circuito **se cierra solo**
  al pasar el instante — antes no se cerraba nunca. El relay del Worker
  (`worker/report-api.js:83-90`) se deja como está: es fichero de G5, y el
  arreglo del cliente vale para cualquier unidad que llegue.

- [x] **F38 · media · El feed de invitado llama a `/sources/physics`, que exige sesión** — arreglado el 24-08-2026
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

  **Re-verificado, y es más ancho de lo que decía la ficha.** El Worker protege
  tres rutas de fuentes (`report-api.js:136-142`: `/sources/core`,
  `/sources/physics` y `/sources/scopus`), no una: la rama de ingeniería tiene
  la misma precondición incumplida y hoy no muerde solo porque
  `GUEST_CATEGORIES` no lleva ingeniería. El gate se puso a las tres, en una
  función pura y exportada (`getEligibleDomainSources`) que es donde vive ahora
  la invariante. **Producto, decidido:** la rama se condiciona a que haya
  sesión y las categorías de física **se quedan** — el invitado sigue viendo
  física por arXiv (`cat:`) y OpenAlex; solo pierde ADS/INSPIRE, que hoy
  tampoco recibía. Nada que tocar en el Worker. Verificado en vivo: el feed de
  invitado ya no pide `/sources/physics` ni `/sources/core`, y no hay ni un
  `WorkerApiAuthError` en consola.

- [x] **F39 · baja · `q-bio.NC` no existe en el esquema: término basura en la query OpenAlex del invitado** — arreglado el 24-08-2026
  `src/hooks/useGuestFeed.js:20` y `:36-45`; `src/data/categories.js:288`.
  El esquema interno usa `bio.neuro`; `q-bio.NC` solo aparece en el mapa de
  prefijos de área, no como subcategoría, así que `categoryLabel('q-bio.NC')`
  devuelve el id literal y la query de descubrimiento busca `"q-bio.NC"` como
  texto — término muerto en una llamada facturada. Tampoco activa ninguna
  fuente bio del plan de dominio.
  **Arreglo:** sustituir por `bio.neuro` en `GUEST_CATEGORIES` (la rama
  PubMed del invitado ya usa esa forma) y hacer que `categoryLabel` avise en
  dev cuando devuelve el id literal.

  **Re-verificado y arreglado, con un coste que la ficha no nombraba:**
  `q-bio.NC` **sí** es categoría real de arXiv (`ARXIV_PREFIXES` incluye
  `q-bio`), así que la rama arXiv del invitado sí funcionaba con
  `cat:q-bio.NC`; lo roto era la query de OpenAlex y el plan de dominio. Al
  sustituir por `bio.neuro`, arXiv pasa a `all:"Neuroscience"` — decidido
  aceptarlo: a cambio la query facturada deja de buscar un id, y bioRxiv y
  Europe PMC de neurociencia (rutas públicas) se activan para el invitado.
  Verificado en vivo, en la petición: `default.search:"Cosmology" OR "Quantum
  Physics" OR "Artificial Intelligence" OR "Neuroscience" OR "Probability" OR
  "General Economics"`. La parte pura del hook vive ahora en
  `src/utils/guestFeedPlan.js` con la invariante en un test: **toda categoría
  de invitado existe en el esquema interno**.

- [x] **F34 · baja · Los fallos de fuentes del feed se tragan sin dejar rastro** — arreglado el 24-08-2026
  `src/services/domainSourceService.js:575-578`. El `Promise.allSettled`
  descarta los `rejected` sin log: un 401 sistemático, un 429 de cuota o una
  caída de `/sources/*` son indistinguibles de «esa fuente no tenía
  resultados». Es lo que ocultaba F38.
  **Arreglo:** loggear los `rejected` con path de fuente y código.

- [x] **F35 · baja · Parámetro muerto `schema: 4` hacia `/sources/physics`** — arreglado el 24-08-2026
  `src/services/domainSourceService.js:541`. El Worker no lo lee y no figura
  en `CACHE_PARAMS_BY_PATH['/sources/physics']`.
  **Arreglo:** eliminarlo del cliente (o implementarlo y añadirlo a los cache
  params, si era un versionado pendiente).

  Re-verificado: ningún handler del Worker lee `schema` y no está en
  `CACHE_PARAMS_BY_PATH['/sources/physics']` (`report-api.js:127`). Eliminado
  del cliente. **Sin test**, a propósito: es el borrado de un parámetro muerto y
  no hay comportamiento que fijar; lo que lo respalda es la lectura de las dos
  puntas.

- [x] **F37 · baja · Comillas dobles corrompen la sintaxis de consulta de arXiv** — arreglado el 24-08-2026
  `src/services/arxivService.js:305` (`au:"${authorName}"`) y `:341`
  (`all:"${queryStr}"`). No es inyección de URL (`URLSearchParams` codifica),
  pero un `"` en el nombre o la búsqueda rompe el emparejado de comillas de
  la query de arXiv → resultados vacíos o erróneos en silencio.
  **Arreglo:** `.replace(/"/g, '')` antes de interpolar.

- [x] **F42 · baja · Europe PMC mapeado dos veces con dos formas de paper** — arreglado el 24-08-2026
  `src/services/europePmcService.js:114-137` vs
  `domainSourceService.js` (`mapEuropePmcSearchResult`). La misma API mapeada
  por dos funciones independientes que pueden divergir — la forma exacta de
  deuda que ya mordió dos veces (el filtro `openalex:` roto años, el índice
  invertido ×4).
  **Arreglo:** extraer un `mapEuropePmcRecord` común (como se hizo con
  `buildOpenAlexIdFilter` y `openAlexAbstract.js`).

  **Re-verificado: no era deuda teórica, ya habían divergido en cuatro puntos
  medibles** — qué cuenta como acceso abierto (`OA` a secas frente a `OA`/`F`
  más la bandera `isOpenAccess`), si se decodifican las entidades HTML del
  resumen, si los términos se deduplican ignorando mayúsculas, y de qué formas
  de `descriptorName` se leen los MeSH. `src/utils/europePmcRecord.js` es ahora
  el único lector; donde discrepaban gana la unión. Los dos tests que ya
  existían siguen verdes **sin tocarlos**, que es la prueba de que no cambió
  ningún comportamiento observado.

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

# G7 — Despliegue: ~~encender Scopus de verdad~~ atar el flag al bundle

**Ficheros:** `src/utils/deployFlags.js` (nuevo), `src/utils/deployFlags.test.js`
(nuevo), `vite.config.js`, `proxy/README.md`, `docs/DEVELOPMENT.md`. Las
Variables de GitHub **no se han tocado**, y el porqué está en F40.

- [x] **F40 · RECHAZADO · el hecho es cierto, el diagnóstico no** — re-verificado el 23-08-2026
  F40 decía: Scopus apagado en el bundle «**pese a la decisión registrada de
  encenderlo**», y mandaba poner `VITE_SCOPUS_ENABLED=true` en las Variables del
  repo. **El hecho se confirma; la premisa es falsa, y ejecutar el plan habría
  metido la regresión en vez de arreglarla.**

  **El hecho, confirmado hoy:**

  | Comprobación | Resultado |
  | --- | --- |
  | Bundle vivo `assets/index-BFoeehHB.js` | `og=!1`, `function cg(){return og}` → Scopus apagado |
  | `gh variable list` | solo `VITE_PAPER_API_BASE_URL`; `VITE_SCOPUS_ENABLED` nunca se puso |
  | `gh auth status` | `mugar123`, scopes `repo`+`workflow` — **sí** había acceso, al revés de lo que F40 suponía |
  | `/health/scopus` | `available: true`, `view: STANDARD`, `hasAbstract: false`, cuota 19.983/20.000 |

  (F40 cita `index-DU0AKCXZ.js` y `ag=!1`; en el bundle actual `ag` es la URL del
  Worker y el flag es `og`. El nombre minificado cambia en cada build — detalle
  que importa justo para el punto 4 de abajo.)

  **Por qué la premisa es falsa.** Hay **dos** decisiones del 22-08 en STATE.md,
  y el fichero va de más nuevo a más viejo, así que F40 leyó la más antigua:

  - `ad4dcd5` — 22-08 **01:12:39** — «Encendido… @mugar decidió encenderlo
    igualmente en todas las superficies, feed incluido».
  - `b26418a` — 22-08 **02:14:15** (62 min después) — «`VITE_SCOPUS_ENABLED` se
    queda en `false`, **y esta vez con la medida delante**»: de 75 papers de
    Scopus en tres áreas, OpenAlex ya tenía **75**. «Ni un solo paper que
    OpenAlex no tuviera… Retirado como inversión, no como código.»

  `git log -S 'SCOPUS_ENABLED'` desde esa fecha no devuelve nada que lo
  revierta. **El bundle apagado es la decisión vigente correctamente
  desplegada.** La variable de repo no se ha tocado.

  **Lo que sí se arregló: el punto 4 de F40**, que era la causa raíz real. Nada
  ataba el estado *previsto* del flag al bundle publicado: el previsto vivía en
  prosa, en un fichero ordenado por fecha descendente, y el efectivo en una
  variable de repo que se cambia sin commit y sin revisión. Por eso la
  discrepancia ocurrió «dos veces en dos direcciones», y por eso una auditoría
  acaba de leerla al revés una tercera.

  - `src/utils/deployFlags.js` (nuevo): la intención declarada
    (`VITE_SCOPUS_ENABLED: false`) junto a su porqué, y la coerción que espeja
    exactamente la de `ScopusAdapter.js` (`=== 'true'`, sin `trim`).
  - `vite.config.js`: `requireDeclaredDeployFlags`, hermana de la
    `requireWorkerBaseUrl` que ya existía (`aa84d6b`). `vite build` se para si el
    entorno discrepa de lo declarado. `vite dev` no se ve afectado.
  - `src/utils/deployFlags.test.js` (nuevo): 7 tests, incluida una guarda de
    acoplamiento que falla si `ScopusAdapter` deja de leer el flag como la
    guarda supone — lo único que podría volverla silenciosamente falsa.
  - `proxy/README.md` y `docs/DEVELOPMENT.md` ya no mandan encenderlo.

  **Verificado por mutación, en las dos direcciones:**

  | Caso | Resultado |
  | --- | --- |
  | `VITE_SCOPUS_ENABLED=true npm run build` | **falla**: «declared false, this build would ship true» |
  | `npm run build` y `VITE_SCOPUS_ENABLED='' npm run build` (estado real del CI) | pasan; bundle con `og=!1`, idéntico al de producción |
  | declaración volteada a `true` + estado real del CI | **falla**: «declared true, this build would ship false» — *literalmente el escenario que describe F40*, ahora detectado antes de desplegar |
  | declaración volteada a `true` | 4 de los 7 tests fallan |

  Se descartó el script post-deploy que pedía la letra del punto 4: compara
  contra un bundle ya servido, depende de red en CI, y tendría que reconocer el
  flag en código minificado cuyo nombre cambia en cada build. La guarda de build
  bloquea antes de publicar y no tiene ninguna de esas tres fragilidades.


---

# G8 — PubMed y Semantic Scholar detrás del Worker

**Ficheros:** `worker/report-api.js` (rutas nuevas), `wrangler.toml`,
`src/services/adapters/PubmedAdapter.js`, `src/services/semanticScholarService.js`,
`src/services/europePmcService.js` (opcional). **Correr después de G2/G5**
(reutiliza el helper de plazos y no pisar el fichero).

- [x] **F41 · media · PubMed, Europe PMC y Semantic Scholar se llaman directo del navegador**
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

  **Cerrado el 24-08-2026.** Puntos 1, 2, 3 y 5 hechos; el 4 (Europe PMC) se deja
  fuera a propósito: ya lleva plazo, `/sources/europepmc` ya existía, y su
  consolidación es F42, que es de G6 y aterrizó el mismo día sobre esos mismos
  ficheros. Cuatro correcciones al diagnóstico, todas ampliando el fallo:

  1. El limitador de S2 no serializaba **ni dentro de una pestaña**: leía
     `lastRequestTime`, esperaba, y solo entonces lo escribía. El informe decía
     «serializa por pestaña»; no serializaba en absoluto.
  2. F41 se dejaba fuera un tercer llamante directo,
     `src/services/adapters/SemanticScholarAdapter.js`, con `fetch(url)` pelado y
     sin señal ninguna, usado por las páginas de autor —que son públicas—. Sin
     él, el criterio de aceptación del propio F41 fallaba al abrir una.
  3. `getPaperCitationsAndReferences` y `getSimilarAuthors` no tenían ni un
     llamante: dos URLs directas a S2 más en el bundle. Borradas.
  4. El `throw` del error no-429 de S2 caía en el `catch` de su propia función,
     así que un 500, un fallo de red y «no hay resultados» eran indistinguibles.

  **Y un hallazgo que no es de G8 pero lo condiciona:**
  `SEMANTIC_SCHOLAR_API_KEY` **nunca se ha configurado** en el despliegue, pese a
  figurar en `worker/README.md` (`wrangler secret list` no la muestra). Medido el
  24-08: el pool anónimo de S2 rechazó 10 de 10 peticiones desde una IP
  residencial y 9 de 10 desde el Worker. O sea que S2 llevaba roto desde antes
  —`/related` incluido— y migrarlo no es una regresión, pero **sin la clave
  `/sources/s2` no sirve de nada**. Igual con `NCBI_API_KEY`, que sube PubMed de
  3 a 10 req/s; esa sí es opcional de verdad, y PubMed funciona sin ella.
  Las dos las tiene que sacar @mugar.

  El **F2-residuo** que el informe dejaba «al primero de G5/G8 que pase por aquí»
  lo arregló una sesión en paralelo mientras esta trabajaba; el arreglo duplicado
  se descartó al rebasar, porque el suyo va más lejos —encontró una segunda
  instancia que ninguna ficha recogía—.

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
