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

## F10 — Privacidad granular

### P17 `[rules]`+UI — Tres interruptores: me gusta, guardados, seguidores

P15 dejó la privacidad en una sola decisión: perfil público o privado. Esta
fase la vuelve granular — mis me gusta, mis guardados y mi lista de
seguidores, cada uno con su interruptor independiente — y añade una señal en
MI propia página: un ojo junto a cada métrica que cualquiera puede ver, para
saber de un vistazo qué está expuesto sin entrar en ajustes.

**El punto de partida es asimétrico y decide media fase.** Hoy los me gusta y
los guardados NO son públicos: el visitante de un perfil ve cabecera, listas
fijadas y contadores de follows; las pestañas Guardados/Me gusta son solo del
dueño (`PublicProfilePage` las alimenta de `users/{uid}/interactions` y
`users/{uid}/savedPapers`, owner-only). La lista de seguidores, en cambio, es
pública siempre desde F2 (`follows/` se lee en ambas direcciones). Así que
dos interruptores son de ABRIR — me gusta y guardados, cuyo defecto tiene que
ser privado — y uno de CERRAR — seguidores, cuyo defecto tiene que ser
público. La migración se deriva sola de ahí (abajo).

- **Los interruptores de me gusta y guardados no son campos del perfil: son
  la existencia de un documento.** Firestore no tiene seguridad por campo, y
  las colecciones de origen llevan telemetría (viewTime, skips, notas) que
  jamás debe abrirse; "mis me gusta son públicos" es publicar una
  PROYECCIÓN: `profileShowcase/{uid}/shelves/{likes|saved}`, un doc por
  estantería con las últimas ≤6 tarjetas ligeras (`01-DATA-MODEL.md`).
  Encender = escribir el doc; apagar = borrarlo. No existe un flag que pueda
  discrepar del artefacto, y el guardado ordinario de perfil no gana NI UNA
  expresión — la pasada hostil de P16 dejó el presupuesto sin margen, y este
  diseño existe para no gastarlo. El primer candidato medido —
  `showLikes`/`showSaved` como campos del perfil más una cláusula de
  coherencia perfil↔doc — bajaba el tope de pines de 6 a 5 y se descartó.
- **Apagar no destruye nada, por construcción**: la fuente de verdad sigue
  siendo privada e intacta; el doc público es una proyección regenerable. Es
  la pregunta que P15 resolvió con el stash de pines, con mejor respuesta:
  aquí no hay que aparcar el array porque el original nunca se fue de casa.
- **Seguidores: un flag en el perfil, `showFollowers`, ausencia = pública.**
  Aquí no hay proyección que publicar sino una puerta que cerrar: el dato ES
  el grafo público existente, y las rules de `follows/` leen el flag con un
  `get()`. Una sola rule de `list` distingue las dos direcciones: la
  igualdad de la query sobre `followerUid` deja al motor probar
  `resource.data.followerUid is string` (medido — no era obvio que el solver
  lo probara), así que "a quién sigue X" queda abierto mientras "quién sigue
  a X" pasa a exigir el flag del destino o ser el propio destino. El `get`
  de una arista suelta se acota igual (dueño de la arista, destino, o flag),
  y el `count()` de seguidores cae bajo la misma puerta: seguidores ocultos
  = contador oculto para extraños. Seguir a la cuenta sigue permitido — el
  interruptor esconde la lista, no te hace inseguible. Qué esconde y qué no
  (la arista es un dato compartido), en `02-SECURITY.md` §8.

**Dónde vive cada dato en cada estado:**

| Dato | Privado (defecto likes/guardados) | Público (defecto seguidores) | Con el perfil entero privado |
| --- | --- | --- | --- |
| Me gusta | Solo `users/{uid}/interactions`, owner-only; no existe artefacto público | Ídem + proyección `shelves/likes` (≤6 tarjetas, mundo-legible) | Proyección BORRADA en el mismo batch (las rules lo exigen); la intención queda en `profileStash/showcase` |
| Guardados | Solo `users/{uid}/savedPapers` y listas, owner-only | Ídem + `shelves/saved` | Como los me gusta |
| Seguidores | Grafo intacto; la dirección "quién sigue a X" denegada a extraños vía flag | Grafo `follows/` legible como hoy | El flag SIGUE operativo: es el único interruptor con efecto en un perfil privado |

- **Interacción con el interruptor maestro (P15)**: privado SOBREESCRIBE los
  de me gusta/guardados sin apagarlos. Las estanterías no pueden existir
  bajo un perfil privado — la escritura exige `visibility == 'public'`
  explícito tras el batch (la forma endurecida de la pasada hostil de P16,
  no público-por-ausencia) y volverse privado exige `!existsAfter` de ambas
  —, así que salen en el mismo batch que apaga el perfil, y la intención
  ({likes, saved}) se apunta en `users/{uid}/profileStash/showcase`,
  owner-only: el patrón exacto del stash de pines. Al volver a público, el
  cliente lee la intención y republica en el batch de vuelta — el ciclo
  completo está probado contra el emulador. El de seguidores NO se
  sobreescribe: gobierna un dato que ya era visible con el perfil privado
  (P15 lo avisaba en pantalla como su tercer límite), así que sigue mandando
  en privado — y de paso cierra ese aviso: ahora sí se puede ocultar el
  contador. La copy de `visibilityCopy` y el test `F8: what going private
  does NOT hide` ganan el matiz ("…salvo que ocultes también tu lista de
  seguidores").
- **Búsqueda (P16): sin efecto, y dicho explícitamente.** La pertenencia a
  `userSearch/` depende SOLO del interruptor maestro; ninguno de los tres la
  toca, y sus estados no viajan en la entrada (su forma cerrada no cambia).
  Apagar los tres no te saca de la búsqueda; encenderlos no indexa a un
  perfil privado. Los tests de P16 deben seguir verdes sin editarlos.
- **Migración: nadie cambia de visibilidad a sus espaldas, y esta vez sin
  prompt.** La ausencia hereda el comportamiento de hoy: sin doc de
  estantería = me gusta/guardados privados (como hoy); sin `showFollowers` =
  seguidores públicos (como hoy). A diferencia de P15 no hace falta pregunta
  única: el statu quo es un defecto válido para todos — P15 la necesitó
  porque estrenaba una frontera en la que la ausencia no podía significar
  nada seguro. Los tres interruptores se descubren en Ajustes → Privacidad,
  junto a los dos de P15, y guardan al instante como aquellos.

**El presupuesto de expresiones — medido contra el emulador, y el tope de
pines NO baja.** `tests/p17-measure.test.js`, con el método de `f9-measure`
(candidata por cirugía sobre las rules embarcadas con anclajes asertados,
`validPinnedLists` desenrollado de verdad a N, y la única señal fiable es
`allowed`), contra el archivo POSTERIOR a la pasada hostil de P16:

- Guardado ordinario, renombre de handle y salida a privado (deslistar +
  tirar ambas estanterías, un solo batch), todos con 6 pines y las dos
  estanterías vivas: **pasan**. Techo real de la candidata = techo embarcado
  = **6/6/6**. La clave es doble: el camino público no evalúa nada nuevo (la
  ausencia de estanterías solo se comprueba en la rama privada del ternario
  de `profileSearchStateValid`, el cortocircuito de P16), y al perfil solo
  se le añade `showFollowers` (un item de `hasOnly` y un type check).
- Techo de tarjetas por estantería: **8 pasan, 10 no**. Tope embarcado: **6**,
  con holgura doble porque la colección es nueva y su validación crecerá (la
  lección de F1: el tope por debajo del presupuesto, no encima). Un doc por
  estantería y no las dos juntas es resultado medido, no gusto: dos
  estanterías de 6 tarjetas en un mismo doc revientan la evaluación.
- La matriz de `follows/` con el flag ausente: **once permisos idénticos a
  hoy** — desplegar no cambia nada para nadie hasta que alguien apague algo.

**El ojo.** Señal del dueño, renderizada solo bajo `view.isOwner`, sobre la
superficie exacta que un visitante recibe: junto al chip "Seguidores" de la
cabecera cuando la lista está expuesta (`showFollowers !== false` — nótese
que se expone TAMBIÉN con el perfil privado, y el ojo lo dice: es el único
que puede lucir en un perfil privado), y en las pestañas "Me gusta" y
"Guardados" cuando su estantería existe y el perfil es público. No hay ojo en
el contador de likes de la cabecera: ese número es owner-only y lo sigue
siendo — la estantería no publica totales, publica "los últimos", no
"cuántos". El icono es un SVG inline de 14 px (12 px bajo 480 px), botón con
`aria-label` ("Visible para todos — abre los ajustes de privacidad") que
navega a la sección de privacidad; en móvil no hay hover, así que el toque
hace de tooltip. Verificar a 375 px que ni el chip ni la fila de pestañas
rompen línea; si rompen, el recorte previsto es pasar el ojo a insignia en la
esquina del chip — no encoger los textos.

**Costes:**

| Camino | Coste |
| --- | --- |
| Carga de feed | **1 lectura, sin cambios** — nada de esto entra en su grafo; `profileShowcaseService` se suma al veto del test SOURCE |
| Guardado de perfil público | Sin cambios (+0 lecturas de rules; la rama privada gana 2 `existsAfter`) |
| Like/guardar desde el feed | Sin cambios — la estantería NO se escribe desde el camino del feed; se refresca perezosamente al visitar tu propio perfil (el patrón perezoso de P16) |
| Visitante abre una pestaña pública | +1 lectura (el doc de la estantería) |
| Lista o `count()` de seguidores de un tercero | +1 lectura de rules (el `get` del flag); la dirección "siguiendo" no paga nada |
| Encender/apagar un interruptor | 1–2 escrituras en batch |

- **Toca**: `firestore.rules` (bloque `profileShowcase/`, `showFollowers` en
  `validPublicProfile`, rama privada de `profileSearchStateValid`, delete de
  perfil, rules de lectura de `follows/`, forma nueva en `profileStash/`);
  `profileShowcaseService` nuevo + tests; `userProfileService` (helpers de
  exposición para el ojo y los interruptores); `PublicProfilePage` (pestañas
  de visitante, el ojo, y estado "lista privada" traduciendo
  `permission-denied` a estado — el patrón de `readUserProfileByHandle` — en
  FollowSheet y contadores); `ProfilePage` (tres interruptores en Privacidad,
  guardado instantáneo como los de P15); `visibilityCopy.js` y su test.
- **Depende de**: P15 (maestro, stash, copy), P16 (coherencia, cortocircuito
  y la posición real del presupuesto — esta fase se midió contra el archivo
  posterior a su pasada hostil), P4 (follows). Va aquí y no antes porque
  cualquier fase que toque la escritura de `userProfiles/` tiene que medirse
  contra el archivo REAL del momento, y P16 lo movió dos veces en un día.
- **Tests que la cierran**: los cinco bloques de `p17-measure` promovidos a
  la suite de emulador (techo de pines intacto en 6/6/6; techo de estantería;
  matriz de follows en ambos estados del flag; ciclo de vida de estanterías
  con sus seis denegaciones — privado, nombre desconocido, ajena, séptima
  tarjeta, privado-con-estantería-viva, delete-con-estantería-viva —; cuenta
  legacy intacta); pasada de mutación de cada cláusula nueva; unitarios del
  servicio; test SOURCE ampliado; el complemento de la copy de P15; y el
  coste del feed re-ejecutado.
- **Despliegue**: rules → app, UN solo despliegue de rules (todo aditivo:
  flag ausente y estanterías inexistentes = comportamiento de hoy, medido en
  la fila de deploy-safety de la matriz). **Coordinar antes de
  `firebase deploy`**: producción lleva la pasada hostil de P16 (2026-08-20,
  13:29) y un deploy desde una copia anterior la revertiría — el archivo
  desde el que se despliegue tiene que contener `searchIndexCoherentAfter`.
- **Fuera, a propósito**:
  - Ocultar "a quién sigo yo": nadie lo ha pedido y la puerta simétrica queda
    diseñada (la misma rama, sobre `followerUid`); sería una fase corta.
  - Totales públicos de likes/guardados: un contador exacto es superficie de
    coherencia nueva (¿contra qué se valida?) por un dato que nadie pidió.
    La estantería dice "últimos", no "cuántos".
  - Frescura en tiempo real de la estantería: quitar un like desde el feed
    no la reescribe hasta la próxima visita al propio perfil. Deriva
    cosmética con la misma dirección que P16 aceptó — rancio posible,
    filtrado imposible (apagar sí es instantáneo y por rules). Dicho en la
    copy del interruptor.
  - Verificar el CONTENIDO de la estantería contra `interactions`: las rules
    no pueden (un acceso por tarjeta) y no hace falta — mentir en tu propia
    estantería es mentir en tu bio, sin tercero dañado. Análisis en
    `02-SECURITY.md` §8.

## F11 — Publicar listas sin el techo de las rules

Contexto: publicar una lista está **roto en producción** desde que el
documento público lleva papers reales. No es un fallo de lógica sino del
presupuesto de las rules: Firestore corta a 1000 expresiones evaluadas por
petición y `validPublicPaper` no cabe. Medido en emulador contra el batch real
de tres escrituras de `publishPublicList()`:

| payload por paper | papers que llegan a publicarse |
|---|---|
| 20 autores, 12 conceptos, todos los campos (lo que escribe la app) | **0** |
| 5 autores, 3 conceptos, todos los campos | 1 |
| id + título + 1 autor, nada más | 2 |

El tamaño del dato es irrelevante (un abstract de 10 y otro de 1200 caracteres
dan el mismo techo): se pagan cláusulas, no bytes. El sumidero son las dos
llamadas a `validBoundedStringList`, que cuestan ~140 expresiones **aunque la
lista tenga un solo elemento**, porque `values.size()` se reevalúa en las 20
líneas desenrolladas aunque cortocircuiten.

Lo importante es que **adelgazar no basta**. A 12 papers el presupuesto es de
~76 expresiones por paper, y la frontera medida es:

| validación por paper | papers que caben |
|---|---|
| `hasOnly`(12 claves) + `hasAll` | 12 |
| + tipos (`is string` / `is list`) | 12 |
| + topes de longitud de id/title | 11 |
| + tope de nº de autores | 10 |
| + tope de longitud de abstract | 8 |
| + regex https de openUrl | 7 |
| + validación por elemento de autores | 0–2 |

Se midieron y se descartaron tres escapes: cambiar listas por cadenas
pre-unidas (`authorsLine`) da 2 de 12; `map.get(clave, defecto)` en vez de
`!('x' in paper) || …` es **peor** (pierde el cortocircuito); y guardar solo
los campos que la página pinta, todos acotados, tope en **6**, no en 10 —
porque el coste fijo por paper (indexar `papers[k]`, la guarda del
desenrollado, `is map`, `hasOnly`, `hasAll`, acotar id y title) ya se come casi
todo el presupuesto, y el número de campos es secundario.

Conclusión: **validar N papers en las rules no escala, y ningún recorte
honesto deja el tope de producto por encima de 6.** La salida es sacar la
escritura del cliente. Decisión tomada 2026-08-20: no se acepta un tope
artificial en una feature cuyo sentido es compartir bibliografías.

### P18 `[worker]` — Identidad de servicio (es P10) — **HECHA** (2026-08-20)
Idéntica a **P10**; se ejecutó aquí porque F11 la necesitaba antes que F6/F7.
Desbloqueada el 2026-08-20: service account `papertok-worker` con rol
**Cloud Datastore User** y los dos secrets cargados con `wrangler`.

Entró `worker/firestore-admin.js`: firma RS256 con WebCrypto, canje del grant
`jwt-bearer` por token OAuth2, cache del token en el isolate (una firma por
arranque en frío y ninguna después), códec de valores tipados del REST de
Firestore, y `commit()` atómico. 21 tests, incluida la verificación real de la
firma contra la clave pública del par. **P11/P13/P14 dejan de estar bloqueadas
por infraestructura**: el módulo que esperaban ya existe.

El smoke de `serviceSmoke/` que P10 pedía se sustituyó por algo más fuerte: los
endpoints reales de P19, con 24 tests, y la comprobación en las rules de que el
cliente no puede escribir esas colecciones (P20).

### P19 `[worker]` — Endpoints de publicación — **HECHA** (2026-08-20)
- **Necesita antes**: P18.
- **Entra**: `POST /lists/publish`, `POST /lists/update`, `POST /lists/unpublish`
  en el Worker. Verifican el ID token con `verifyFirebaseIdentity()` (ya
  existe, `worker/firebase-auth.js`) **sin** el cache de 60 s, comprueban que
  el `uid` es dueño de la lista privada, validan el payload en JS real
  reutilizando los topes de `PUBLIC_LIST_LIMITS`, y cometen vía P18. Cuota por
  usuario con `REQUEST_QUOTA_LEDGER` (ya existe); CORS con el allowlist
  existente.
- **Tope de papers**: deja de ser técnico y pasa a ser producto. El único
  freno duro es el 1 MiB por documento de Firestore. Con los topes actuales un
  paper en su peor caso ocupa ~11 KB (id 300 + title 500 + abstract 3000 +
  20 autores × 160 + 12 conceptos × 120 + openUrl 2000 + doi 300 + arxivId 100
  + category 120 + date 40 + enteros + nombres de campo), o sea **~90 papers**
  antes de tocar el límite, y varios cientos con papers de tamaño real
  (~1,8 KB). Se fija **50** como tope explícito, aplicado en el Worker, más un
  guardia duro sobre el documento serializado (rechazar por encima de ~700 KB)
  para que el tope no se pueda esquivar con papers inflados. 50 × 11 KB =
  550 KB en el peor caso, con el guardia de respaldo.
- **La lectura sigue costando 1**: es el mismo documento único.
- **Tests**: unitarios del Worker (validación, propiedad, cuota, payload
  hostil, tope de 50, guardia de bytes).

### P20 `[rules]` — Cerrar la escritura de cliente — **HECHA** (2026-08-20)
- **Necesita antes**: P19 desplegado (si no, publicar queda muerto).
- **Entra**: `publicLists/{shareId}` y `publicListOwners/{shareId}` pasan a
  `allow read: if true; allow write: if false;`. Desaparece
  `validPublicPaper`/`validPublicPapers` y con ellas el problema de
  presupuesto. `validBoundedStringList` **se queda**: la usa
  `savedPapers` (documento privado, una llamada por documento, sin problema).
- **Trampa encontrada al medir, no obviarla**: la regla de borrado de
  `users/{userId}/lists/{listId}` exige hoy
  `!existsAfter(publicLists/…) && !existsAfter(publicListOwners/…)`, y el
  cliente lo cumple borrando los tres documentos en un batch. Cuando el
  cliente ya no pueda borrar los públicos, **borrar una lista privada
  publicada quedaría bloqueado para siempre**. P20 tiene que rehacer esa
  regla y el Worker tiene que limpiar `publicShareId` de la lista privada al
  despublicar. Sin esto, P20 rompe borrar listas.
- **Tests**: emulador — cliente no puede crear/editar/borrar `publicLists`;
  dueño sí puede borrar su lista privada publicada tras despublicar.

### P21 — Cambiar el cliente — **HECHA** (2026-08-20)
- **Necesita antes**: P19, P20.
- **Entra**: `publicListService.js` deja de cometer el batch de tres
  escrituras y llama al Worker con el ID token. `sanitizePublicList()` se
  queda para la UI optimista y como primera pasada.
- **Tests**: los de `publicListService.test.js`, reescritos contra el
  endpoint.

### Listas ya publicadas
No hay migración de datos: **la forma del documento no cambia**, solo cambia
quién lo escribe. Las listas publicadas siguen leyéndose igual, con una
lectura, sin tocar nada. La única lista publicada hoy quedó a medias (un paper
de varios) por este mismo fallo; se arregla republicándola por el endpoint
nuevo una vez esté vivo. Sus documentos de `publicListOwners` y su
`publicShareId` siguen donde estaban, así que editar y despublicar funcionan
desde el primer día.

### Orden de despliegue, que importa

**El orden es Worker → app → rules**, y con ese orden no hay ninguna ventana
rota:

1. **Worker** (`npm run worker:deploy`). Nadie lo llama todavía: inerte.
2. **App** (push a `main`, que dispara `deploy.yml`). La app nueva llama al
   Worker y **publicar empieza a funcionar ya**. Las rules viejas siguen
   permitiendo escritura de cliente, pero nadie la usa.
3. **Rules** (`firebase deploy --only firestore:rules`). Cierra la escritura de
   cliente. La app nueva ni se entera: escribe por el Worker.

El orden Worker → **rules** → app, que es el que parecía natural, sí abre una
ventana: entre rules y app, una sesión con la app vieja en caché pierde
despublicar y borrar listas publicadas, cosas que hoy sí puede hacer. La app
nueva, en cambio, funciona con las rules viejas **y** con las nuevas: borra
llamando primero a despublicar, que deja el estado que ambas redacciones de la
regla de borrado aceptan. Por eso la app va en medio.

### Lo que cambió al implementar, respecto a lo escrito arriba
- **Un agujero preexistente cerrado de paso**: `publicLists` tenía
  `allow read: if true`, que cubre `get` **y** `list` — cualquiera podía paginar
  la colección y cosechar todas las listas jamás publicadas, un directorio que
  el producto no ofrece. Ahora `allow get: if true; allow list: if false;`.
  Nadie paginaba: la página pide un share id y los pines se pintan del perfil.
- **`publicShareId` pasa a ser inmutable para el cliente**
  (`publicShareIdUntouched()`, misma forma que `legacyUserFieldsUntouched()`).
  Sin eso, la nueva regla de borrado era esquivable: bastaba con que el dueño
  borrase el campo de su lista privada y luego la lista, dejando los dos
  documentos públicos huérfanos e inalcanzables para siempre.
- **El saneado vive en `src/services/publicListPayload.js`**, importado por el
  navegador y por el Worker. Se descartó duplicarlo en `worker/` con un test de
  deriva: una segunda copia de los topes es justo la forma silenciosa de
  reintroducir este fallo.
- **Pasada de mutación**: 10 mutantes sobre las cláusulas nuevas, **9 muertos**.
  El superviviente es la comprobación de formato del share id en la escritura de
  `lists/`, inalcanzable mientras `publicShareIdUntouched()` aguante. Se queda
  por el mismo motivo que las tres vivas de P16: el Worker escribe ese documento
  **por fuera de estas rules**, y ahí la cláusula deja de ser redundante.

### Acción humana que desbloquea todo — **HECHA** (2026-08-20)
Fue la acción 3 ya registrada en `03-AUTH.md`, sin cambios:
1. Crear una service account en Google Cloud, en el proyecto de Firebase, con
   rol **Cloud Datastore User** (`roles/datastore.user`) — lee y escribe
   documentos, y nada más: ni IAM, ni Auth, ni gestión de rules.
2. Crear y descargar su clave JSON.
3. Cargar dos secrets del Worker (los ejecuta la persona, no el agente:
   `FIREBASE_SERVICE_ACCOUNT_EMAIL` y `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY`,
   la clave PEM del campo `private_key`). `FIREBASE_PROJECT_ID` va como var
   en claro en `wrangler.toml`, no es secreto.

Hecho el 2026-08-20: service account `papertok-worker`, rol Cloud Datastore
User, dos secrets cargados. `FIREBASE_PROJECT_ID` y los dos topes diarios
quedaron como vars en claro en `wrangler.toml`.

### Plan Spark: por qué esto cabe en el tier gratuito
Publicar cuesta **1 lectura y 1 commit de 3 escrituras**; editar, 1 lectura y 1
escritura; despublicar, 1 lectura y 3 escrituras. Los topes del Worker
(`PUBLIC_LIST_USER_DAILY_LIMIT=60`, `PUBLIC_LIST_GLOBAL_DAILY_LIMIT=2000`)
acotan la ruta entera en unas 6000 escrituras y 2000 lecturas al día, frente a
las 20 000 escrituras y 50 000 lecturas que da Spark. El ledger de cuota
**falla cerrado**: si no está cableado, la ruta responde 503 en vez de quedarse
sin tope, porque en el tier gratuito el tope es lo que protege la cuota diaria.
Ni el REST de Firestore ni el canje de token ni `accounts:lookup` exigen
facturación. Leer una lista pública sigue sin pasar por el Worker: una lectura
directa de Firestore, sin sesión.

---

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
P15 + P16 + P4 → P17                  (F10)
P18 ✔ → P19 ✔ → P20 ✔ → P21 ✔         (F11, publicar listas, hecha)
```

Bloqueadas por humano: **P11** (cliente ORCID) y nada más. P9 y P10 ya no: sus
bloqueos se levantaron. **P10 se hizo como P18**, así que P13 y P14 pasan a
estar listas para empezar, y P11 solo espera al registro del cliente de ORCID.

Publicar listas deja de ser una regresión abierta en cuanto se despliegue: el
orden es **Worker → app → rules**. Ver "Orden de despliegue" en F11.
