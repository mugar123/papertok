# 04 — Fases de implementación

Cada fase cabe en una sesión de trabajo y deja la app desplegable. El orden
F1→F7 dado se respeta; única observación sobre ese orden (sin cambiarlo):
es internamente correcto — F1 debe ir antes que F3 porque los comentarios
denormalizan `authorHandle`, y F5 antes que F6 porque la verificación ORCID
cuelga de una sesión ya iniciada. Se añade una fase de infraestructura (P10)
que el listado F1–F7 no menciona pero F6 y F7 exigen.

**Bloqueo global previo**: hay un compañero rediseñando la UI en local; hasta
que ese trabajo aterrice, no se toca `src/`. Las fases marcadas `[rules]` o
`[worker]` no tocan `src/` y podrían adelantarse, coordinándolo.

Convención de despliegue (ya documentada en `docs/ARCHITECTURE.md`): rules con
`firebase deploy --only firestore:rules`; frontend por push a `main`; Worker
con `npm run worker:deploy` después de verificar Pages. Las rules de
colecciones nuevas son aditivas: pueden desplegarse antes de que exista UI que
las use sin romper nada existente.

---

## F1 — Perfiles públicos

### P1 `[rules]` — Rules y servicio de perfil
- **Entra**: bloques de rules para `userProfiles/` y `handles/` (patrón
  `getAfter` calcado de `publicListOwners`), función `isAdmin()`, y
  `src/services/userProfileService.js` (crear/editar perfil, reclamar/cambiar
  handle en batch, leer perfil por uid y por handle) con inyección de
  dependencias como `publicListService`.
- **Toca**: `firestore.rules`, servicio nuevo, tests del servicio.
- **Depende de**: nada.
- **Tests que la cierran**: unitarios del servicio (batch correcto, handle
  inválido rechazado, cambio de handle atómico); validación manual de rules
  contra emulador o proyecto de prueba (intentar robar un handle ajeno,
  escribir `verified` desde cliente → denegado).
- **Despliegue**: rules solas. Nada las usa aún; riesgo cero.

### P2 — UI de perfil propio
- **Entra**: pantalla de edición (handle, nombre, bio, foto recomprimida
  ≤60 KB reutilizando `src/utils/profileImage.js`), alta de perfil desde
  ajustes. Sin página pública todavía.
- **Toca**: componentes nuevos en `src/components/Profile/`, `App.jsx`
  (ruta), `SettingsPage`.
- **Depende de**: P1.
- **Tests**: unitarios de validación de handle; flujo manual crear→editar→
  cambiar handle.
- **Despliegue**: seguro — funcionalidad nueva opt-in, no toca el feed.

### P3 — Página pública de perfil + listas pineadas
- **Entra**: ruta pública `/public/user/:handle` (patrón `PublicListPage`),
  resolución handle→uid, render de perfil + listas pineadas; pineo/despineo
  desde `ListsPage` (batch con el perfil); al despublicar una lista, quitarla
  del perfil en el mismo batch.
- **Toca**: `src/components/Public/`, `ListsPage.jsx`,
  `publicNavigation.js` (helper de URL de perfil), `userProfileService`.
- **Depende de**: P2.
- **Tests**: unitario del helper de URL; manual: perfil visible sin sesión
  (HashRouter), lista despineada desaparece del perfil.
- **Despliegue**: seguro; cierra F1 entera.

## F2 — Seguimiento entre usuarios

### P4 — Grafo de follows
- **Entra**: rules de `follows/` + dos índices compuestos; `followUserService`
  (follow/unfollow por ID compuesto, páginas de seguidores/seguidos,
  `count()`); botón seguir en el perfil público; listas de
  seguidores/seguidos en el perfil.
- **Toca**: `firestore.rules`, `firestore.indexes.json` (si no existe, se
  crea y se documenta el deploy de índices), servicio nuevo, componentes de
  perfil.
- **Depende de**: P3.
- **Tests**: unitarios del servicio (idempotencia del ID compuesto, cursor de
  paginación); manual de contadores.
- **Despliegue**: rules+índices primero, UI después. Cierra F2 (el "feed de
  seguidos" queda excluido a propósito — `01-DATA-MODEL.md`).

## F3 — Comentarios — **HECHA** (2026-08-19; P5+P6+P7 en una sesión)

Dos desviaciones al implementar, argumentadas en `STATE.md`: los contadores
del stub son `count()` acotado (el increment del boceto es incompatible con
el borrado en cascada de hilos), y la hoja se estrenó en la página del paper
porque `PaperCard.jsx` estaba vetado — veto ya levantado: el botón vive en
el carril de la tarjeta, en los tres feeds, con la hoja alojada en App.jsx
para que nada social entre en el grafo de módulos del feed.

### P5 `[rules]`-parcial — Stubs de paper
- **Entra**: `src/utils/paperCanonicalKey.js` **puro** (derivación de clave:
  DOI>arXiv>crudo, minúsculas, sin versión, base64url, decodificación) +
  tests exhaustivos (DOI con `/`, arXiv `v3`, ids prefijados de los 14
  proveedores del reconocimiento); rules de `papers/` reutilizando
  `validPublicPaper`; `paperStubService` (create-if-missing con fallback a
  lectura, consulta de clave dual).
- **Toca**: `firestore.rules`, util + servicio + tests nuevos.
- **Depende de**: nada de F1/F2 (paralelizable).
- **Tests que la cierran**: los del util son la puerta de la fase — la clave
  canónica es la decisión más difícil de revertir de todo el plan.
- **Despliegue**: rules solas, inertes hasta P6.

### P6 — Comentarios: escritura y lectura
- **Entra**: rules de `comments/` + `users/{uid}/rateLimits/` (throttle
  declarativo en batch) + increment validado del contador; índice compuesto y
  collection-group; `commentService` (crear con batch de 3, editar, borrar,
  paginar); hoja de comentarios en la tarjeta (lazy: el stub se lee al
  abrirla, jamás en el render del feed); "mis comentarios" en ajustes.
- **Toca**: `firestore.rules`, índices, servicio, `PaperCard.jsx` (punto de
  entrada), componentes nuevos.
- **Depende de**: P5 y P2 (necesita `authorHandle`).
- **Tests**: unitarios del servicio (batch completo, throttle respetado,
  cursor); manual: dos cuentas comentando el mismo paper llegado por rutas
  distintas (verifica la convergencia de clave).
- **Despliegue**: rules+índices, luego UI. La carga de feed debe seguir
  costando 1 lectura — verificarlo explícitamente antes de cerrar.

### P7 — Moderación mínima viable
- **Entra**: rules de `reports/` y `config/moderation` (killswitch leído en
  los creates); botón reportar; cola de admin (ruta oculta, query FIFO,
  acciones ocultar/borrar/descartar); filtrado de `status:'hidden'` en
  cliente.
- **Toca**: `firestore.rules`, `reportService`, componentes de admin.
- **Depende de**: P6. **Bloquea el anuncio público de comentarios**: F3 no se
  considera desplegada de verdad sin esto.
- **Tests**: manual con dos cuentas + la de admin: reportar → ocultar →
  desaparece; killswitch congela creates (rules lo deniegan).
- **Despliegue**: seguro.

## F4 — Anotaciones públicas

### P8 — Anotaciones
- **Entra**: rules de `annotations/` (kind, anchorType `paper|section|quote`,
  texto ≤8000 con render markdown restringido + KaTeX ya presente en la
  app); servicio y UI (pestaña junto a comentarios); anclaje por cita
  textual copiada. **Sin anclaje posicional a PDF** (por qué: `05-RISKS.md`).
- **Toca**: `firestore.rules`, índices, servicio, componentes de la hoja.
- **Depende de**: P6 (infra idéntica), P7 (moderación cubre anotaciones desde
  el día uno).
- **Tests**: unitarios de sanitización del markdown restringido (XSS);
  manual de anclaje por cita.
- **Despliegue**: seguro.

## F5 — Login con GitHub — **HECHA** (2026-08-20)

Desbloqueada: la OAuth App y el proveedor ya estaban puestos. Detalle y
desviaciones en `STATE.md`. Una nota al plan: `03-AUTH.md` daba por hecho que
existía login de correo/contraseña, y no existe — los métodos eran Google y
navegación de invitado, así que la única colisión posible es Google↔GitHub.

### P9 — GitHub + vinculación — **HECHA**
- **Necesitaba antes**: OAuth App creada en GitHub y proveedor activado en la
  consola de Firebase (`03-AUTH.md`, acciones 1). Hecho por el usuario.
- **Entra**: botón GitHub en login; manejo de
  `account-exists-with-different-credential`; "vincular GitHub" en ajustes
  (`linkWithPopup`); política de cuenta-accidental-vacía (`03-AUTH.md`).
- **Toca**: `AuthContext.jsx`, `firebase.js`, pantalla de login, ajustes.
- **Depende de**: independiente de F1–F4.
- **Tests**: 21 unitarios con inyección de dependencias (alta, login,
  colisión en sus tres formas, vinculación, identidad ocupada, y estructurales
  que fijan que entrar no escribe perfil y que la credencial pendiente no se
  guarda). La pasada manual con cuenta GitHub real queda para el usuario:
  requiere autenticarse.
- **Fuera**: el borrado de la cuenta accidental vacía. Se detecta la colisión
  de identidad y se explica, pero liberar la identidad exige borrar esa cuenta
  y **la app no tiene borrado de cuenta**; sería una fase propia. Razonado en
  `STATE.md`.
- **Despliegue**: solo la app. **Cero cambios en `firestore.rules`**: F5 vive
  entera en Firebase Auth.

## Infraestructura para F6/F7

### P10 `[worker]` — Identidad de servicio del Worker ⛔ BLOQUEADA por acción humana
- **Necesita antes**: service account creada con rol mínimo de Firestore y
  clave en `wrangler secret` (`03-AUTH.md`, acción 3).
- **Entra**: módulo del Worker para obtener token OAuth2 de la SA (JWT
  RS256 con WebCrypto, grant jwt-bearer) y cliente REST mínimo de Firestore
  (get/patch/commit de docs concretos); tests del módulo (los del Worker ya
  existen como precedente). Endurecimiento: las rutas nuevas verifican token
  de Firebase sin el cache de 60 s.
- **Depende de**: nada del frontend.
- **Tests que la cierran**: leer y escribir un doc de prueba en una colección
  `serviceSmoke/` con rules `write: false` para clientes (demuestra que el
  acceso privilegiado funciona y que el cliente no puede).
- **Despliegue**: Worker solo; inerte para la app.

## F6 — ORCID + investigador

### P11 `[worker]`+rules — Verificación ORCID ⛔ BLOQUEADA por acción humana
- **Necesita antes**: cliente del API público de ORCID registrado con
  redirect a la URL del Worker; secrets cargados (`03-AUTH.md`, acción 2).
- **Entra**: rutas `/verify/orcid/start` y `/verify/orcid/callback` en el
  Worker (code flow, validación real del id_token contra JWKS, nonce);
  escritura de `researcherClaims`/`researcherVerifications`/flags de perfil
  vía P10; rules `write: false` de esas colecciones; manejo de iD ya
  reclamado.
- **Depende de**: P10, P2 (existe perfil donde poner la insignia).
- **Tests**: unitarios de validación de JWT (token caducado, iss falso, aud
  ajeno, nonce reutilizado); manual contra el sandbox de ORCID si el
  registro lo permite (pregunta abierta).
- **Despliegue**: Worker + rules; el botón en UI puede llegar en la misma
  sesión o la siguiente.

### P12 — Página de investigador
- **Entra**: ruta pública `/public/researcher/:orcid` — resuelve
  `researcherClaims/{orcidId}`, muestra perfil vinculado + obras pedidas en
  vivo a OpenAlex filtrando por ORCID (cero papers almacenados, coherente con
  toda la app); insignia en comentarios/anotaciones (lee el perfil del autor,
  cacheado en cliente).
- **Toca**: componentes públicos, `publicNavigation.js`, servicio de perfil.
- **Depende de**: P11.
- **Tests**: manual: página visible sin sesión; iD no reclamado → mensaje
  honesto sin heurísticas de nombre.
- **Despliegue**: seguro. Cierra el núcleo de F6.

### P13 `[worker]` — Afiliación por correo universitario
- **Entra**: rutas `/verify/edu/start` y `/verify/edu/confirm` (token KV TTL
  24 h, mismo patrón que unsubscribe); lista de dominios en KV con semilla
  del dataset abierto; cola `pending-domain` hacia el digest del admin; ruta
  admin para aprobar dominio; caducidad a 12 meses.
- **Depende de**: P10. Independiente de P11/P12.
- **Tests**: unitarios de matching de dominio (sufijos, casos alumni);
  manual del flujo completo con un email real.
- **Despliegue**: Worker; UI mínima en ajustes.

## F7 — Contacto por correo

### P14 `[worker]`+UI — Relay de correo
- **Entra**: `POST /relay/contact` según `02-SECURITY.md` §4 (opt-in
  `allowContact`, cuotas en el ledger existente, plantilla, Reply-To
  consentido, token de opt-out en KV, killswitch `relayFrozen`); toggle de
  opt-in en ajustes; botón "contactar" en perfiles con `allowContact`.
- **Depende de**: P10, P3. No depende de F6.
- **Tests**: unitarios de cuotas y plantilla en el Worker; manual: envío
  real, opt-out de un clic, cuota agotada → error claro en UI.
- **Despliegue**: Worker primero (ruta inerte), UI después. Cierra F7.

---

## F8 — Privacidad del perfil

### P15 `[rules]`+UI — Perfil público o privado — **HECHA** (2026-08-19)

No estaba en el plan original: F1 asumió que todo perfil creado es público, y
esta fase deshace esa suposición sin romper nada de lo que F1/F2 construyeron.

- **Entra**: campo `visibility: 'public'|'private'` en `userProfiles/{uid}`,
  con **la ausencia del campo significando público** (los perfiles escritos
  antes de esta fase no cambian de estado); `allow get` acotado a perfiles
  públicos más el dueño; elección obligatoria y sin preselección al crear el
  perfil, y como pregunta única para las cuentas que ya existían; interruptor
  de listas fijadas que **saca las entradas** del documento público y las
  guarda en `users/{uid}/profileStash/pinnedLists` (Firestore no tiene
  seguridad por campo); seguir a un perfil privado denegado en rules, sin
  tocar las aristas que ya existen.
- **Decisiones** (detalle en `STATE.md`): el handle sigue reservado, la página
  de un perfil privado dice lo mismo que un handle libre, las listas ya
  publicadas siguen públicas, y no hay nivel "solo seguidores" porque el
  seguimiento es unilateral e instantáneo — sería "todo el mundo con un clic
  de más" hasta que exista aprobación de solicitudes.
- **Depende de**: P1, P3, P4.
- **Tests**: 61 contra el emulador (14 nuevos), pasada de mutación de 14
  cláusulas con 14 muertas; 531 unitarios.
- **Despliegue**: rules (permitir + imponer lectura) → app → rules (exigir la
  elección en el create). Dos despliegues de rules a propósito, para que no
  haya ventana en la que un bundle cacheado no pueda crear un perfil.

---

## F9 — Búsqueda de usuarios

### P16 `[rules]`+UI — Buscar usuarios sin abrir el volcado — **HECHA** (2026-08-20)

F1 cerró `list` en `userProfiles/` y `handles/` a propósito (revisión de
seguridad: nadie vuelca el directorio con sus fotos, a tu cuota), y esta fase
**no lo reabre**. Firestore no busca texto, pero sí hace queries de rango, y
eso basta para "encontrar a alguien por su handle o su nombre": la búsqueda
lee una colección nueva, `userSearch/{uid}` (`01-DATA-MODEL.md`), un índice
mínimo — handle y nombre en minúsculas, sin foto ni bio — donde **los
perfiles privados no existen**. "No aparecer en resultados" no es un filtro
de UI: es ausencia a nivel de datos, verificable contra el emulador. El
análisis de por qué buscar es enumerar, y qué se le concede a cambio, está en
`02-SECURITY.md` §7.

- **Entra**: colección `userSearch/{uid}` con `allow list` acotado
  (autenticado + `request.query.limit <= 20`, el patrón de techo de
  `follows/`) y `get`/escritura ajena cerrados; escritura del dueño **en el
  mismo batch** que el perfil, con coherencia por `getAfter` (handle
  idéntico, `nameLower == displayName.lower()`, perfil público tras el
  batch); cláusula nueva en `userProfiles/`: toda escritura que deje el
  perfil privado —y el delete— exige `!existsAfter(userSearch/{uid})`, que es
  la dirección a prueba de fallos; `userSearchService` (dos queries de
  prefijo —handle y nombre— fusionadas y deduplicadas por uid en cliente,
  mínimo 2 caracteres, disparo al enviar o con debounce ≥400 ms, nunca por
  tecla); ruta `/search/users` —`/search` ya es la búsqueda de papers— con filas
  nombre+handle+monograma — sin foto: la
  foto es exactamente lo que la revisión de F1 cerró — que navegan al perfil
  público, donde la privacidad ya la imponen las rules de F8.
- **Motor de búsqueda**: **ninguno**, y no solo por ahorrar sino porque no
  encaja: sin Cloud Functions (plan Blaze) no hay triggers de sincronización,
  y el Worker no ve las escrituras de perfil (van directas cliente→Firestore
  por diseño, `00-ARCHITECTURE.md`), así que Algolia/Typesense obligarían a
  sincronizar desde el cliente con una clave de escritura expuesta. Coste si
  algún día hiciera falta typo-tolerance de verdad: Algolia da del orden de
  10k búsquedas/mes gratis y ~0,50 $/1.000 después, más resolver el problema
  de sync; Typesense/Meilisearch Cloud parten de ~20–30 $/mes. La alternativa
  gratis es esta fase; sus límites (prefijo, no substring ni typos) y la
  escalada **sin** motor están en `02-SECURITY.md` §7.
- **Coste en lecturas**: una búsqueda ejecutada = 2 queries acotadas
  (facturadas por resultado, mínimo 1 cada una): 2–20 lecturas, típicamente
  <6. Cero lecturas por fila pintada (nombre y handle viajan en el doc del
  índice). Abrir un resultado = el coste normal de un perfil (F1/F2). Cada
  guardado de perfil gana ~1 lectura de rules por el `existsAfter`/`getAfter`
  nuevo. **La carga del feed sigue costando 1**: nada de esto entra en su
  camino, y el test estructural lo fija.
- **Toca**: `firestore.rules`, servicio nuevo + tests,
  `userProfileService.js` (los batches de crear / guardar / renombrar handle /
  despublicar ganan el doc de búsqueda), componente de búsqueda, `App.jsx`
  (ruta). Punto de entrada provisional fuera de `Navbar.jsx` (rama del
  compañero, STATE.md); el icono en la Navbar llega cuando esa rama aterrice.
- **Depende de**: P3, P15. Paralelizable con F3: no comparte ficheros con
  P6–P8 salvo `firestore.rules`, que es aditivo.
- **Medido al implementar**: `.lower()` del motor de rules es **solo ASCII**
  (`"MUÑOZ"` → `"muÑoz"`), así que la derivación del cliente tiene que ser
  también solo ASCII o la igualdad falla y el perfil deja de poder guardarse.
  El tope de pines se re-midió y **sigue en 6**.
- **Presupuesto de expresiones**: la cláusula nueva de `userProfiles/` gasta
  el margen que F1 dejó medido (7 pines pasan, 8 fallan; el tope de 6 "deja
  una entrada de margen para la próxima cláusula" — esta fase ES esa
  cláusula). Obligatorio re-ejecutar el test de límite con 6 pines contra el
  emulador; si deja de pasar, el tope de pines baja a 5 en esta misma fase.
- **Migración**: los perfiles públicos anteriores a la fase no tienen doc de
  búsqueda. Reparación perezosa en el editor (detectar público-sin-doc y
  escribirlo al guardar, patrón `partitionStalePins`); opcional, un backfill
  único con Admin SDK en local (gratis; salta las rules, así que no necesita
  P10). A la escala actual, la perezosa basta.
- **Tests que la cierran**: emulador — `list` sin `limit`, con `limit(21)` o
  sin auth denegados; crear doc de búsqueda con perfil privado denegado;
  dejar el perfil privado (o borrarlo) con doc de búsqueda vivo denegado, y
  el batch correcto permitido; `nameLower` o handle discordantes con el
  perfil denegados; escribir el doc de otro denegado; forma cerrada y
  `createdAt` de servidor; **coste del feed sigue en 1 documento**.
  Unitarios del servicio (fusión/dedupe, mínimo de caracteres, debounce).
  Estructural: ningún módulo del camino del feed importa `userSearchService`
  (el patrón de P4). Pasada de mutación de todas las cláusulas nuevas. La
  copy de `VisibilityChoice` gana una línea ("un perfil público aparece en la
  búsqueda de usuarios") y el test `F8: what going private does NOT hide`
  gana su complemento: privado ⇒ fuera del índice.
- **Despliegue**: rules → app, un solo despliegue de rules. El bloque
  `userSearch/` es aditivo e inerte, y la cláusula nueva de `userProfiles/`
  no rompe a un bundle cacheado: mientras una cuenta no tenga doc de
  búsqueda, `!existsAfter` es verdadero y sus escrituras de siempre pasan tal
  cual. El único choque posible es una cuenta que ya creó su doc con el
  bundle nuevo y guarda en privado desde un bundle viejo — se deniega en la
  dirección segura y se resuelve recargando; no hace falta el despliegue en
  dos fases de F8.

#### Pasada hostil sobre P16 — **HECHA** (2026-08-20), rules re-desplegadas

La revisión con ojos hostiles encontró cuatro agujeros reales, reproducidos
contra las rules desplegadas y cerrados en una pasada aparte. El detalle está
en `STATE.md`; lo que importa para el plan:

- **La igualdad `nameLower == displayName.lower()` no bastaba.** Se comprobaba
  al escribir la entrada, así que se satisfacía una vez y se abandonaba: indexar
  un nombre legal y luego renombrar el perfil dejaba el índice anunciando un
  nombre que el perfil no tenía. Lo mismo con el handle, y ahí la fila acababa
  abriendo el perfil de otra persona. Ahora una escritura pública de perfil
  tiene que dejar la entrada cuadrando con el perfil que produce.
- **`userSearch` no tenía borrado de admin**, así que un perfil retirado por
  moderación dejaba una entrada que nadie podía quitar.
- **La entrada pierde `createdAt`**: las rules lo exigían igual a `request.time`
  en cada escritura y el cliente la reescribía en cada guardado, así que era un
  reloj de última edición, legible y **ordenable** por cualquiera con sesión.
- **El índice exige elección explícita de privacidad.** Público-por-ausencia
  abre tu página, que siempre fue pública; no te mete en un índice buscable.
  Una cuenta anterior a F8 se indexa cuando responde al prompt de F8, no cuando
  edita su bio.
- **El tope de pines sigue en 6** — medido, no supuesto — pero **el margen de
  una entrada que F1 dejó está gastado**: seis es ahora techo y tope a la vez, y
  la siguiente cláusula que se añada a `userProfiles/` lo baja a 5. Quien
  re-mida: subir el tope no basta, hay que extender el desenrollado de
  `validPinnedLists`, y la única señal fiable es `allowed`.

---

## Mapa de dependencias

```
P1 → P2 → P3 → P4                    (F1, F2)
P5 ─┐
P2 ─┴→ P6 → P7 → P8                  (F3, F4)
P9 ✔                                  (F5, hecha)
P10 → P11 → P12                       (F6 núcleo)
P10 → P13                             (F6 afiliación)
P10 + P3 → P14                        (F7)
P1 + P3 + P4 → P15                    (F8, hecha)
P16 ✔                                 (F9, hecha)
```

Bloqueadas por humano: **P10** (service account), **P11** (cliente ORCID).
P9 ya no: su bloqueo se levantó y F5 está hecha. Todo lo demás está listo para
empezar.
