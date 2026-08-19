# Estado / pendientes

## Red social del conocimiento — F1 implementada (2026-08-19)

**Fase actual**: **F1 (P1+P2+P3) hecha y verificada en vivo**. Rules
desplegadas en `papertok-168df` el 2026-08-19. Siguiente: **P4** (grafo de
follows) o **P5** (clave canónica de paper), que es paralelizable.

### Qué entró en F1

| Archivo | Qué es |
| --- | --- |
| `src/utils/userHandle.js` (+test) | Gramática del handle y lista de reservados. Puro. |
| `src/services/userProfileService.js` (+test) | Crear/editar perfil, reservar/cambiar handle en batch, leer por uid y por handle, pineo. Inyección de dependencias como `publicListService`. |
| `src/components/Profile/ProfilePage.{jsx,css}` | Editor del perfil propio + pineo/despineo. Ruta `/settings/profile`. |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Perfil público en `/public/user/:handle`. Sin sesión. |
| `firestore.rules` | Bloque **aditivo** `userProfiles/` + `handles/` + `isAdmin()`. Cero líneas borradas del bloque anterior. |
| `tests/firestore.rules.test.js` + `tests/README.md` | 26 tests de comportamiento contra el emulador. `npm run test:rules`. |
| `src/utils/publicNavigation.js` | `getPublicProfilePath/Url`. |
| `src/utils/profileImage.js` | `PUBLIC_AVATAR_PRESET` (≤60 KB) y opciones en `prepareProfileImage`; los valores por defecto no cambian. |
| `src/App.jsx`, `src/components/Settings/SettingsPage.jsx` | Rutas y punto de entrada. |

### Endurecimiento tras la revisión adversarial (2026-08-19)

Una relectura del bloque de rules "como si lo hubiera escrito otro" encontró
tres agujeros que los tests de texto no podían ver, porque comprueban que las
cláusulas escritas siguen ahí, no que falte alguna. Los tres arreglados,
desplegados y probados ejecutando el ataque contra producción:

| | Era | Ahora |
| --- | --- | --- |
| **A** | Cualquiera podía fijar la lista de otro: solo se validaba el *formato* del shareId. Confirmado fijando `deadbeef…`, que ni existe. | `ownsPinnedShare()` lee `publicListOwners/{shareId}` y exige `ownerId == request.auth.uid`. |
| **B** | `followerCount` era auto-escribible. Confirmado poniéndome 999999. | Congelado junto a `orcid` y `verified`. |
| **C** | Borrar el perfil no liberaba el handle ⇒ borrar-y-recrear acumulaba reservas sin límite. | El delete exige `!existsAfter(handles/{handle})`. Probado en producción: la secuencia de acumulación se deniega y una cuenta acaba con **una** reserva, no dos. |

Además, `allow read` era `get` **y** `list`: cualquiera podía volcar el
directorio de usuarios con sus fotos, a tu cuota. Ahora `allow get: if true` +
`allow list: if false` en `userProfiles/` y `handles/`.

**El tope de listas fijadas es 6, y el número está medido, no elegido.** El
límite que manda no es el de 10 accesos a documento que supuse, sino el de
**1000 expresiones por evaluación**: contra el emulador, 7 pines pasan y 8
fallan con error de límite de expresiones. 6 deja una entrada de margen para
que la próxima cláusula que se añada a `firestore.rules` (F2, F6) no empiece a
rechazar guardados de quien esté en el tope. Para ganar ese margen se quitó la
lista de 44 handles reservados de `validPublicProfile`: era redundante, porque
todo handle de un perfil tiene que estar respaldado por un `handles/{handle}`,
y es *ahí* donde se aplica. Hay un test de emulador que lo cubre.

**Efecto secundario que hay que conocer**: despublicar una lista borra el
`publicListOwners/{shareId}` que lee la comprobación de propiedad, así que un
pin huérfano bloquea *cualquier* escritura del perfil. No hay bloqueo
permanente — quitar el pin no lo valida, porque las rules validan el array que
se escribe — y `/settings/profile` detecta los pines huérfanos al cargar
(cruzándolos con las listas publicadas, sin lectura extra) y ofrece quitarlos.
`partitionStalePins()` en el servicio.

### Tests de rules que sí ejecutan las rules

`tests/firestore.rules.test.js`: 26 tests de comportamiento contra el emulador
de Firestore, vía `npm run test:rules`. Cubren los tres arreglos, el cierre de
`list`, la carrera de dos cuentas por un handle, y los dos límites del motor.
Pasada de mutación: 7 cláusulas **eliminadas** una a una, las 7 cazadas — que
es justo lo que los tests de texto no hacían.

Requiere una JRE. Instalada con `brew install openjdk` (la fórmula, no el cask
`temurin`, que necesita `sudo`). Es keg-only, así que hace falta
`export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"`. Detalle en
`tests/README.md`.

Los tests de texto siguen en `src/services/userProfileService.test.js`: son
gratis, corren sin emulador dentro de `npm test`, y ahora tienen encima la
cobertura de comportamiento que les faltaba.

### Invariantes que F1 respeta (verificados, no asumidos)

- **Handle atómico**: `handles/{handle}` es *create-only* en rules (no hay
  `allow update`). Firestore rechaza un create sobre un doc existente, así
  que el perdedor de una carrera recibe `permission-denied`; el servicio lo
  traduce a `HandleUnavailableError`. El `getAfter` cruzado perfil↔handle
  calca `publicLists`/`publicListOwners`.
- **`publicLists` y `publicListOwners` intactos**: comprobado en vivo — tras
  pinear, despinear y volver a pinear, el `updateTime` del doc público no se
  movió. Hay un test que compara ambos bloques de rules carácter a carácter
  contra su texto anterior.
- **El feed sigue costando 1 lectura**: nada social entra en su camino
  (`grep` de `userProfileService` en `src/context/` y `src/components/Feed/`
  no devuelve nada). El test de coste sigue verde sin tocarlo.
- **Sin lecturas de colección sin tope**: el selector de listas pineables usa
  `orderBy('publicShareId') + limit(60)`. El `orderBy` hace el trabajo de
  filtrado (Firestore descarta los docs sin ese campo), así que no hay ni
  índice nuevo ni escaneo en cliente. Un test del *fuente* falla si aparece
  un `getDocs` que no pase por una query con `limit`.
- **Perfil público sin sesión**: verificado contra la REST API de Firestore
  sin cabecera de auth — `handles/mugar` y `userProfiles/{uid}` se leen;
  `users/{uid}` y `publicListOwners/{shareId}` siguen dando
  `PERMISSION_DENIED`.
- **`orcid` y `verified`**: intocables desde cliente, en el servicio (lista
  blanca) y en rules (`publicProfileServiceFieldsAbsent/Unchanged`).

### Cómo se probó

`npm test` (458 verdes) más una pasada de mutación: 11 fallos reintroducidos
a mano (lectura pública cerrada, comprobación de dueño quitada, `allow
update` añadido a `handles`, reservado eliminado, plegado de mayúsculas
quitado, deduplicación de pineo quitada…) y los 11 los cazó el test
correspondiente. El script vive en el scratchpad de la sesión; si hace falta
repetirlo, es reescribirlo, no está versionado.

**Límite conocido de los tests de rules**: son aserciones sobre el *texto* de
`firestore.rules`, la convención que ya usaba `publicListService.test.js`.
Muerden ante cualquier borrado de cláusula, pero **no ejecutan** las rules.
Ejecutarlas de verdad necesita `@firebase/rules-unit-testing` + el emulador,
y el emulador necesita una JRE que esta máquina no tiene (`java` es el stub
de macOS). La cobertura de comportamiento la dio la verificación en vivo.

### Fuera de alcance en F1, a propósito

- **Despublicar una lista no la despinea automáticamente.** El plan lo quería
  en el mismo batch, pero eso obliga a tocar `ListsPage.jsx`, que tiene
  cambios sin commitear. Mitigado, no resuelto: `/settings/profile` detecta
  los pines huérfanos y ofrece quitarlos, lo cual ahora es obligatorio porque
  bloquean cualquier otra escritura del perfil. El cierre limpio sigue siendo
  quitarlo en el mismo batch que el despublicado.
- Seguir usuarios, contadores de seguidores (`followerCount` ya está
  permitido en rules pero nadie lo escribe): es F2/P4.
- `isAdmin()` está con el UID en marcador de posición
  (`REPLACE_WITH_ADMIN_UID`), inerte hasta P7.

El freeze del rediseño de UI se levantó el 2026-08-19: `src/` vuelve a ser
editable. `PaperCard.{jsx,css}` sigue con cambios del compañero sin
commitear; F1 no los tocó.

**Hecho**: los seis documentos de `docs/plan/` — `00-ARCHITECTURE.md` (qué
escrituras van directas vs Worker; stubs de paper con clave canónica),
`01-DATA-MODEL.md` (colecciones, índices, costes), `02-SECURITY.md` (rules,
rate limiting, moderación unipersonal, relay F7, reclamación de investigador
F6), `03-AUTH.md` (GitHub, ORCID por dos vías con la B recomendada, correo
universitario, vinculación), `04-PHASES.md` (P1–P14 de una sesión cada una),
`05-RISKS.md`.

**Siguiente**: **P4** (grafo de follows) o **P5** (clave canónica + rules de
stubs), que es paralelizable, más las acciones humanas de abajo.

**Decisiones clave y por qué** (detalle en cada doc):

- Comentarios/anotaciones: escritura directa con rules + throttle declarativo
  (`getAfter` sobre `users/{uid}/rateLimits/`), NO vía Worker. Umbral de
  reversión documentado en `00-ARCHITECTURE.md`.
- Stubs: `papers/{base64url(doi:…| arxiv:…| id crudo)}`, DOI antes que arXiv,
  arXiv sin versión; inmutables salvo contadores; el feed no los lee nunca.
- Perfil público en `userProfiles/{uid}` separado del `users/{uid}` privado;
  handles únicos calcando el patrón `publicListOwners`; atribución de listas
  **por pineo opt-in** (publicLists sigue anónimo).
- Seguir usuarios: colección propia `follows/{follower}_{target}`, no se toca
  `users/{uid}/following` (modela entidades externas). Contadores por
  `count()`, sin denormalizar. El feed de actividad de seguidos queda FUERA.
- F6: ORCID como *verificación* vía Worker (Vía B), no como login — evita el
  upgrade a Identity Platform (verificado: OIDC genérico lo exige; Tier 2
  gratis solo ≤50 MAU, luego ~$0.015/MAU). Página de investigador indexada
  por ORCID iD, nunca por nombre. Correo edu = solo insignia de afiliación,
  jamás reclamación automática de página.
- F7: relay en el Worker; el email del receptor se resuelve por
  `accounts:lookup` administrativo al enviar y no se persiste ni viaja al
  cliente. Opt-in `allowContact`, cuotas en el `RequestQuotaLedger` existente.
- Infra nueva única: identidad de servicio (service account) en el Worker
  (P10), requisito compartido de F6+F7. Colecciones de servicio con
  `write: false` para clientes.
- Fuera de alcance confirmado: publicar papers propios (decisión previa),
  feed de actividad, anclaje posicional de anotaciones (alternativas en
  `05-RISKS.md` R3), mensajería en-app.

**Acciones humanas pendientes (bloquean fases concretas)**:

1. OAuth App de GitHub + activar proveedor en consola Firebase → bloquea P9.
2. Registrar cliente del API público de ORCID con redirect a la URL del
   Worker → bloquea P11.
3. Crear service account con rol mínimo de Firestore + `wrangler secret` →
   bloquea P10 (y por tanto P11–P14).
4. Copiar el UID de admin a `isAdmin()` en rules → bloquea P7. La función ya
   existe en `firestore.rules` con `'REPLACE_WITH_ADMIN_UID'`; hoy no casa con
   nadie, que es el fallo seguro.

**Preguntas abiertas**:

- ORCID: condiciones exactas del registro de cliente del API público
  (redirect URIs admitidas, requisitos), detalles del sandbox
  (`sandbox.orcid.org`), y si `openid` a secas devuelve `name` en el
  id_token. No asumido en el diseño; verificar al registrar (acción 2).
- Service account desde Workers: confirmar grant `jwt-bearer` contra
  `oauth2.googleapis.com/token` con WebCrypto y elegir el rol IAM mínimo
  (los roles de Firestore no son por colección; el aislamiento del lado
  cliente lo dan las rules).
- App Check con reCAPTCHA en GitHub Pages: ¿viable y gratis a este volumen?
  Sin verificar; afecta solo a R2 (`05-RISKS.md`).
- `fetchSignInMethodsForEmail` con protección de enumeración activada:
  confirmar comportamiento al implementar P9.
- Lecturas de docs `hidden`: ¿exigir `where status=='visible'` en rules o
  filtrar en cliente? Decidir en P6/P7 (`02-SECURITY.md` §1).
- Licencia del dataset abierto de dominios universitarios antes de usarlo
  como semilla (P13).

**Para ponerse al día sin reexplorar el repo**: leer `docs/plan/00` → `04`
en orden (05 opcional pero corto), más `docs/INTERACTION_PROFILE.md` si se
toca el feed. El reconocimiento que sustenta el plan está resumido en las
tablas de `00-ARCHITECTURE.md`; no hace falta releer `firestore.rules` ni el
Worker para seguir diseñando, sí para implementar.

**Deuda detectada en el reconocimiento (no bloquea, no mezclar con el plan)**:
`interactions` usa `paper.id` crudo como ID de doc (DOIs con `/` anidan
rutas; prefijos inconsistentes arXiv/OpenAlex según ruta de entrada) — R8;
doble implementación de auth en el Worker (`firebase-auth.js` vs
`email-notifications.js:688`) — R10; `PUBLIC_DISCOVERY.md` dice 20 papers
donde las rules dicen 12 — R9.

## Hecho: reparación automática de deriva del agregado

`loadInteractionProfile` compara `sourceDocCount` con un `count()` de
`users/{uid}/interactions` y fuerza un rebuild si el agregado ignora más de
`max(25, 2%)` documentos. Throttled a una vez por semana y por dispositivo vía
`localStorage`, para que una carga de feed normal siga costando una lectura.
Detalle en `docs/INTERACTION_PROFILE.md`.

## Pendiente: acotar `enrichPapersBatch` en el perfil semántico del feed

**Dónde:** [src/context/FeedContext.jsx](src/context/FeedContext.jsx), bloque
"OpenAlex Semantic Profile" dentro de `loadInteractions`, y
[src/services/openAlexService.js](src/services/openAlexService.js).

**Qué pasa:** al cargar el feed se llama a `enrichPapersBatch(positiveIds)` con
la unión completa de `liked` y `saved` para reconstruir `conceptAffinities`. Es
un fan-out HTTP a OpenAlex que crece con el número de papers que el usuario ha
marcado, sin tope propio.

**Por qué no es urgente:** no es Firestore, así que no consume la cuota de
lecturas del free tier, y desde el agregado de interacciones
(`docs/INTERACTION_PROFILE.md`) queda acotado de rebote por los topes de los
sets curados — 2.000 liked + 2.000 saved como máximo absoluto. Aun así son
hasta 4.000 IDs por carga de feed en el peor caso, contra un servicio público
con rate limiting.

**Opciones a evaluar:**

1. Limitar a los N positivos más recientes. Los sets curados ya se guardan en
   orden de recencia, así que es un `.slice(0, N)`. Cambia `conceptAffinities`
   y por tanto el ranking: hay que medir cuánto.
2. Persistir `conceptAffinities` en el propio documento agregado y mantenerlo
   incrementalmente, como se hace con `categoryAffinities`. Elimina el fan-out
   de la carga de feed por completo, pero hace persistentes los bumps que hoy
   son solo de sesión, lo cual también es un cambio de comportamiento.
3. Cachear el resultado de OpenAlex por ID con TTL, y pedir solo los que falten.
   No cambia el ranking; reduce el tráfico pero no el peor caso en frío.

**No estaba en el encargo** del agregado de interacciones; se detectó al
investigarlo.
