# Estado / pendientes

## Red social — F3 (P5+P6+P7): comentarios en papers (2026-08-19)

**Implementado; rules e índices DESPLEGADOS en `papertok-168df`; verificado en
vivo la parte de visitante y de datos (REST sin auth). La pasada con sesión
(@mugar/@nick_mugar) está pendiente del usuario** — lista de pasos abajo.

### Qué entró

| Pieza | Archivo |
| --- | --- |
| Clave canónica de paper (P5): `doi:` > `arxiv:` sin versión > id crudo con prefijo; base64url; candidatos duales para el split-brain | `src/utils/paperCanonicalKey.js` (+21 tests, puro) |
| Stubs `papers/{paperKey}`: cache mínimo de metadatos, create por el primer comentarista, **inmutable salvo admin**, `list: false` (no hay directorio de papers) | `firestore.rules`, `src/services/paperStubService.js` |
| Comentarios `papers/{key}/comments/{id}` con hilos de un nivel (`replyTo`), editar/borrar propios, borrado de padre en cascada | rules + `src/services/commentService.js` |
| Throttle declarativo `users/{uid}/rateLimits/{action}` (comments 15 s, stubs 30 s, reports 60 s), en el mismo batch, con `getAfter` | rules (match top-level aparte, para no tocar el bloque `users/` que edita la otra sesión) |
| Reportes `reports/{id}` create-only + cola FIFO de admin; killswitch `config/moderation` escribible por admin sin deploy | rules + `src/services/reportService.js` |
| Hoja de comentarios en la página del paper (botón flotante, lazy: 0 lecturas hasta abrirla) | `src/components/Comments/CommentsSheet.{jsx,css}`, `PublicPaperPage.{jsx,css}` |
| "Mis comentarios" en ajustes (collection-group por autor; ahí ve el autor sus ocultos) | `src/components/Settings/MyCommentsPage.{jsx,css}`, fila en `SettingsPage` |
| Cola de moderación en ruta no listada `/admin/moderation` (ocultar/mostrar, borrar con cascada, resolver/descartar, killswitch) | `src/components/Admin/ModerationPage.{jsx,css}`, `App.jsx` |
| Índices: CG `comments (authorUid, createdAt desc)` y `reports (status, createdAt asc)` | `firestore.indexes.json` |

### Decisiones tomadas al implementar (y por qué)

- **Sin contador denormalizado `commentCount`: el recuento es `count()`
  acotado a 1000, el patrón de F2.** El plan (00/01) diseñó un increment ±1
  validado en rules, pero la cascada de borrado lo rompe: borrar padre +
  N respuestas en un batch exigiría validar "decremento exactamente N" y las
  rules no pueden contar los deletes de un batch. Permitir decrementos
  arbitrarios sería deflación libre; hacer N batches de ±1, absurdo. `count()`
  da el mismo número por 1 lectura al abrir la hoja, deja el stub **totalmente
  inmutable** para clientes y no añade superficie de inflado. Es la desviación
  del plan de esta fase; los campos `commentCount`/`annotationCount` del
  boceto simplemente no existen.
- **El punto de entrada fue primero la página del paper** (PaperCard estaba
  vetado por los cambios del compañero). **Superseded en la pasada
  siguiente**: el veto se levantó y el botón vive en la tarjeta — ver la
  sección "Botón de comentarios en el feed" de abajo.
- **Hilos en orden cronológico ascendente, una sola query.** Una respuesta
  siempre es posterior a su padre, así que en orden ascendente el padre ya
  está en pantalla cuando llega la respuesta: cero respuestas huérfanas por
  paginación, cero recuentos por padre, cero índices compuestos para el hilo.
  Responder a una respuesta responde a su hilo (nivel único, estilo TikTok).
- **La cascada**: primer batch = padre + hasta 400 respuestas (atómico); si
  hubiera más, barridos acotados de huérfanos (`!exists(parent)` permite a
  cualquier autenticado rematar). Un corte a mitad deja solo docs invisibles
  (una respuesta jamás se pinta sin su padre) y reintentable. En rules, la
  excepción está acotada: un extraño solo puede borrar una respuesta ajena si
  el padre cae en el mismo batch a manos de su autor.
- **`isAdmin()` ya lleva el uid real de @mugar** (`SrqikE0wbtPOsTZMnvK4lcLVHhD3`,
  resuelto de `handles/mugar`): P7 lo exigía (acción humana 4, hecha). Cambiar
  de cuenta admin = editar esa línea y desplegar. Los tests del emulador leen
  el uid del propio archivo, así que sobreviven al cambio.
- **Ocultos legibles a nivel de datos** (la opción simple que 02-SECURITY.md
  §1 dejaba abierta): el cliente oficial los filtra, el autor los ve marcados
  en "Mis comentarios", y el borrado definitivo es del admin. Hay un test que
  fija la postura para que un cambio futuro no la rompa en silencio.
- **Reportar queda fuera del killswitch y abierto a perfiles privados**
  (reportar no es un acto público; la alarma no se congela con la sala).
  El reportante deja de ver lo reportado en su dispositivo (localStorage,
  acotado a 300).
- **Split-brain**: la hoja lee la clave alternativa (2ª lectura solo si el
  objeto trae DOI+arXiv), fusiona la vista y auto-reporta `dup-stub` una vez
  (id determinista no — auto-id con throttle; el admin fusiona a mano, como
  dice el plan).

### Lo que las rules imponen (93 tests de emulador, todos de comportamiento)

Perfil privado o inexistente no comenta; `authorHandle` debe ser el handle
real del autor (nadie firma con nombre ajeno); nadie escribe/edita/borra
comentarios de otro; el admin solo mueve `status` (no reescribe texto); el
throttle corta de verdad y su ledger ni se borra ni se backdatea (ni en el
create, hueco que encontró la mutación); comentario sin stub no existe;
respuestas a un nivel; queries sin `limit` o por encima de 1000 denegadas
(CG incluido); stub inmutable y coherente con su identidad (doi minúsculas,
arXiv sin versión); reportes create-only con cola solo-admin; killswitch
congela comments+stubs pero no reports; `config/` solo expone `moderation`.

**Pasada de mutación: 41 cláusulas nuevas eliminadas una a una → 40 muertas,
1 superviviente demostrado redundante** (el check de autor del padre en la
cascada: el delete del padre en el mismo batch ya exige a su autor con el
mismo auth). Anotado en las rules como defensa en profundidad, calcando el
precedente del `hasAll` de F2. Dos supervivientes de la primera ronda eran
huecos de test, no de rules (backdate en el create del ledger; reporte sin
sello enmascarado por un helper que siempre sellaba): tests añadidos y ambas
mutaciones ahora mueren. Script en el scratchpad de la sesión, no versionado.

### Costes

| Camino | Lecturas |
| --- | --- |
| **Carga de feed** | **1, sin cambios** — nada de F3 se importa en el camino del feed; el test SOURCE ahora veta `commentService\|paperStubService\|reportService` además de `followUserService`, y el test COST sigue verde |
| Página del paper (sin abrir comentarios) | 0 de Firestore (como antes) |
| Abrir la hoja | 1 stub (+1 si identidad dual) + 1 count + 1 página de 20 + 1 perfil propio (gating del composer; solo autenticado) |
| Publicar comentario | batch de 2 escrituras (4 si estrena stub) + ~4 lecturas de rules (killswitch, perfil, getAfter, existsAfter; +1 en respuestas) |
| "Mis comentarios" / cola admin | 1 query acotada por página |

### Tests

- `npm run test:rules`: **93** (29+4 nuevos F3). `npm test`: **590** (86
  nuevos: clave canónica, stubs, comentarios con cascada, reportes, SOURCE).
- Lint y build limpios.

### Verificación en vivo (2026-08-19) — hecha la mitad sin sesión

Contra las rules **desplegadas** en `papertok-168df`, por REST sin cabecera
de auth: stub get permitido (404 en ausente; el primer intento dio 403 por
propagación de las rules recién liberadas — reintentar antes de alarmarse),
query de comments sin `limit` → 403, con `limit(20)` → pasa, `limit(1001)` →
403, crear stub sin auth → 403, `reports` → 403, `config/moderation` legible
y `config/other` → 403. En el navegador, como visitante: la página del paper
muestra el botón Comments, la hoja abre con contador 0 real de producción,
estado vacío y la puerta "Sign in to join the conversation"; consola sin
`permission-denied` (solo los 429 de OpenAlex de siempre).

**Pendiente de tu sesión (el navegador quedó en el login del server de esta
sesión):**

1. Con @mugar (público): comentar en un paper → estrena stub; responder,
   editar, borrar propio. Al borrar un padre con respuestas de la otra
   cuenta, verificar que se van juntas.
2. Con @nick_mugar: comentar en EL MISMO paper llegado por otra ruta (p. ej.
   uno por el feed/arXiv y otro por su URL con DOI) → mismo hilo.
3. Poner @nick_mugar en privado (Ajustes → Perfil) → la hoja debe mostrar
   "Tu perfil es privado…" con el camino al editor, y el composer no enviar.
4. Reportar un comentario de la otra cuenta (desaparece localmente) y, como
   @mugar, abrir `/admin/moderation`: cola con el reporte, Ocultar (la otra
   cuenta deja de verlo; el autor lo ve marcado en Mis comentarios),
   Mostrar, Borrar, Resolver. Probar el killswitch: congelar → comentar
   falla con el aviso honesto → descongelar.
5. `/settings/comments` con cualquiera de las dos.

**Datos de prueba**: en producción no se creó NADA (todas las escrituras de
verificación fueron denegadas por diseño; la hoja de visitante solo lee).
Lo que crees en la pasada con sesión se borra desde la propia UI (borrar
comentario borra el hilo; el stub que quede huérfano es inerte y solo el
admin puede borrarlo — hazlo desde la consola de Firebase si quieres cero
rastro, colección `papers`).

### Qué desplegar, en qué orden

1. **Rules + índices: YA DESPLEGADOS** (2026-08-19, este chat). Aditivos:
   ningún cliente viejo pierde nada; el índice CG de `comments` nace con la
   colección vacía, sin backfill.
2. **La app** (`npm run build` + push a `main` para GitHub Pages), cuando
   quieras exponer la UI. No hay ventana de incompatibilidad: la UI vieja
   no toca las colecciones nuevas.
3. **⚠️ FUSIÓN MANUAL de `firestore.rules`**: la otra sesión (worktree
   `brave-keller-ea1633`) también lo toca. Todo lo de F3 está **al final del
   archivo** (desde el separador "F3: paper stubs…" hasta antes del
   catch-all global), aposta para que la fusión sea coger ese bloque entero;
   el único cambio fuera del bloque es el uid real en `isAdmin()` (línea de
   `REPLACE_WITH_ADMIN_UID`). Si su rama redefine `userProfileKeys()` o el
   bloque `users/`, no colisiona con nada de F3 — el match de `rateLimits`
   es top-level aparte precisamente por eso. **Tras fusionar: re-desplegar
   rules y volver a correr `npm run test:rules`.**

### Botón de comentarios en el feed (2026-08-19, pasada posterior)

**Hecho y verificado en vivo.** El veto sobre `PaperCard.{jsx,css}` se
levantó (working tree comprobado: limpio, último toque el commit `82764ef`
del compañero), y el botón vive en el carril lateral de la tarjeta, entre
Like y Save, con el estilo de sus hermanos (`pc-side-btn` — **cero CSS
nuevo** en PaperCard).

- **Cómo mantiene el invariante de coste**: PaperCard solo gana una prop
  (`onOpenComments`) y un import puro (`paperCanonicalKey`, para no pintar
  el botón en papers que no pueden anclar hilo). La hoja, sus servicios y
  toda lectura viven en **App.jsx**, que ya alojaba `PDFViewer` y
  `SaveToListModal` por la misma razón: el feed entrega el paper y nada más.
  Ningún servicio social entra en el grafo de módulos del feed — el test
  SOURCE pasa **sin tocarlo**, no debilitado.
- Cableado por prop a los tres feeds (For you, Following, invitado — el
  invitado puede LEER hilos; el composer le pide sesión) y a la tarjeta
  anidada de relacionados.
- `PublicPaperPage` se unifica: fuera la píldora flotante (JSX + CSS), el
  botón del carril abre la hoja que esa página ya alojaba.
- En la hoja, navegar por un @handle ahora cierra la hoja (contrato
  `onNavigate` de FollowSheet), necesaria al ser modal global.
- **Medido en vivo**: `__papertokReads` tras cargar el feed = aggregate 2
  (StrictMode; 1 en prod), interactions 0, library 0 — sin cambios. Nada de
  contadores por tarjeta (R7): el número se cuenta al abrir la hoja.
- **Verificado en vivo con la sesión de @mugar** (sobrevivió en el origen
  `localhost:57212`; hay entrada `papertok-dev-57212` en `.claude/launch.json`
  para reencontrarla): abrir la hoja desde el feed → comentar → cerrar →
  seguir deslizando, sin roturas. El comentario pasó el batch completo
  contra las rules desplegadas y **estrenó el primer stub real**:
  `papers/YXJ4aXY6MjYwOC4xODAzMA` (`arxiv:2608.18030`), clave coherente y
  campos saneados. La query collection-group de producción respondió (el
  índice CG está vivo).
- **Dato de prueba en producción**: el comentario "Probando los comentarios
  desde el feed" de @mugar en ese paper. Se borra desde la propia hoja o
  desde `/settings/comments`; el stub restante es inerte (solo admin puede
  borrarlo, consola de Firebase, colección `papers`).

### Fuera, a propósito

- **Anotaciones (F4/P8)**: siguiente fase; `annotationsFrozen` ya existe en
  el killswitch y el stub no necesita cambios.
- **Digest de reportes por email** (02-SECURITY §3): el cron del Worker
  existe, pero tocar `worker/` no era de esta fase.
- **Insignia "N comentarios" en tarjetas del feed**: sería N lecturas por
  carga de feed, la familia de bug que R7 documenta. El número vive solo en
  la hoja.
- Publicar papers propios: sigue fuera (decisión previa).

## Privacidad del perfil — F8 / P15 (2026-08-19)

**Implementado, fase 1 de rules desplegada, verificado en vivo.** Fase escrita
en `docs/plan/04-PHASES.md` como P15; no existía en el plan original, que daba
por hecho que todo perfil es público.

### Las cuatro decisiones, y por qué

| Pregunta | Decisión | Razón |
| --- | --- | --- |
| ¿El handle de un perfil privado sigue reservado? | **Sí**, y nadie más puede pedirlo | Volverse privado es reversible; si el handle se liberase, alguien podría cogerlo mientras estás fuera y el interruptor dejaría de tener vuelta. Un interruptor sin vuelta no es un interruptor. |
| ¿Qué ve quien abre `/public/user/:handle` de un perfil privado? | **"Este perfil no está disponible"**, idéntico a un handle que no existe | Mínima revelación y cero texto nuevo. Verificado: la salida es la misma palabra por palabra en ambos casos. |
| ¿Y los enlaces ya compartidos de listas publicadas? | **Siguen funcionando** | Publicar una lista es un acto propio con su control en Mis listas. `publicLists` es anónimo por diseño de F1: ser privado quita la **atribución**, no la lista. |
| ¿Se puede seguir a un perfil privado? | **No se crean aristas nuevas; las que había se conservan** | Borrarlas sería destructivo e irreversible. Dejar de seguir sigue abierto siempre: hay que poder salir. |

**No hay nivel "solo seguidores"**, y no por esfuerzo: seguir es unilateral e
instantáneo, así que ese nivel sería "todo el mundo con un clic de más" hasta
que exista aprobación de solicitudes, que es otra fase.

### Lo que ser privado NO cubre — dicho en pantalla, antes de elegir

Tres cosas, en el propio flujo de elección y en Ajustes: las listas ya
publicadas siguen accesibles por su enlace, el handle sigue reservado (lo que
implica que se puede saber que existe), y el número de seguidores se puede
seguir contando. Los tres están **asertados contra el emulador**
(`F8: what going private does NOT hide`) para que el texto no se convierta en
mentira si alguien cambia las rules más adelante.

### El modelo

`visibility: 'public' | 'private'` en `userProfiles/{uid}`, string y no
booleano porque **la ausencia del campo es portante**: un documento escrito
antes de esta fase no lo tiene y debe seguir leyéndose como público. Un
booleano ausente se lee `false` y habría puesto en privado a todo el mundo sin
preguntar, que es justo lo que esta fase existe para evitar.

| Archivo | Qué cambió |
| --- | --- |
| `firestore.rules` | `allow get` de `userProfiles` acotado a `profileIsPublic(resource.data) \|\| dueño`; `visibility` y `showPinnedLists` validados; `follows` exige destino público al crear; **nueva subcolección** `users/{uid}/profileStash/{id}`, owner-only y de forma cerrada |
| `src/services/userProfileService.js` | `PROFILE_VISIBILITY`, `isVisibilityChoice`, `profileIsPublic`, `needsVisibilityChoice`, `pinnedListsAreVisible`, `saveProfileVisibility`, `setPinnedListsVisible`; `createUserProfile` **exige** la elección; `readUserProfileByHandle` traduce `permission-denied` a "no existe" |
| `src/components/Profile/VisibilityChoice.{jsx,css}` + `visibilityCopy.js` | La elección, sin nada preseleccionado, con las tres limitaciones a la vista |
| `src/components/Profile/VisibilityPrompt.{jsx,css}` | La pregunta única para cuentas que ya existían |
| `src/components/Profile/ProfilePage.jsx` | Elección en el alta; dos interruptores en Privacidad que guardan al instante |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Insignia "Privado" y aviso, solo para el dueño; el prompt |

**Los interruptores guardan al momento**, sin pasar por "Guardar cambios": un
control de privacidad que necesita una confirmación aparte es un control que
la gente cree que ya ha usado.

### Ocultar listas fijadas saca las entradas, no las tapa

Firestore **no tiene seguridad por campo**: si el documento se lee, se leen
todos sus campos. Así que "listas fijadas: no" no puede ser un flag que la UI
respete — el array sale del documento público y espera en
`users/{uid}/profileStash/pinnedLists`, owner-only, en el mismo batch. Vuelve
intacto al encender. `showPinnedLists` existe para que "no tengo pines" y
"los tengo ocultos" no sean el mismo estado al recargar.

**Por qué una subcolección y no un campo en `users/{uid}`**: porque ese
documento **no se puede escribir** en las cuentas antiguas. Ver el bug de
abajo.

### Verificación en vivo (2026-08-19)

Contra las rules desplegadas en `papertok-168df`:

| | |
| --- | --- |
| Perfil privado por REST **sin cabecera de auth** | **403 PERMISSION_DENIED** |
| `handles/mugar` sin auth | 200 (no protegido, documentado) |
| Perfil público de otra cuenta | 200 (nada roto) |
| Página del perfil privado, sin sesión | "This profile is not available", **idéntico** a un handle inexistente |
| El mismo privado a través de la hoja de seguidores de otro | fila "Account unavailable", sin filtrar nombre ni handle |
| `users/{uid}/profileStash/pinnedLists` sin auth | 403 |
| Ciclo privado → público → privado | funciona en ambos sentidos, `visibility` cuadra en el doc |
| Ocultar y volver a mostrar pines | los pines vuelven intactos desde el guardado privado |
| Prompt en cuenta con perfil heredado | aparece, sin preselección, con el botón deshabilitado hasta elegir |
| Coste del feed | sin cambios (nada de esto entra en su camino) |

**Pendiente de tu sesión**: la lectura denegada **desde otra cuenta con
sesión**. Está cubierta por el emulador con un contexto autenticado real
(`F8: a private profile is unreadable to another signed-in account`), pero en
vivo hace falta iniciar sesión como `@nick_mugar`. A propósito he dejado
`@nick_mugar` **sin elegir todavía**, así que al entrar con esa cuenta verás
el prompt de migración tal cual lo verá cualquier usuario existente.

`@mugar` quedó **público**, que es como estaba antes de empezar.

### Tests

- **61 contra el emulador** (14 nuevos), de comportamiento.
- **531 unitarios**.
- **Pasada de mutación: 14 cláusulas nuevas, 14 muertas.** Una sobrevivió al
  primer intento (la lista blanca de claves del guardado privado): el test
  colaba una clave extra en un documento que ya era inválido por otro motivo,
  así que otra cláusula lo denegaba y la mutación no se notaba. El test ahora
  cuela la clave en un documento **por lo demás válido**, que es la única
  forma de que esa cláusula sea la que decide.

### Bug preexistente encontrado (no de esta fase, no arreglado aquí)

**Las cuentas antiguas no pueden escribir su propio `users/{uid}`.** Los
documentos creados por una versión temprana llevan `email`, `displayName`,
`photoURL` y `createdAt`, y la lista blanca `userProfileKeys()` de las rules no
los incluye; como todas las escrituras son `merge`, la lista blanca ve el
documento entero resultante y deniega. Confirmado en producción con una
escritura idempotente: `permission-denied`.

Afecta a preferencias, nivel de IA, foto de perfil y la migración de
seguimientos — conviene revisar si alguno lo traga en silencio. Hay una tarea
aparte con el diagnóstico y tres opciones de arreglo. Esta fase **no lo
arregla ni lo esquiva a medias**: guarda los pines en una subcolección, que no
depende de esa lista blanca. Hay un test que asterta que el documento padre
hoy es inescribible, para que el arreglo se note ahí también.

### Qué desplegar, en este orden

1. **Rules, fase 1** — `git checkout dbf141b -- firestore.rules` no hace falta:
   **ya está desplegada** (2026-08-19). Permite el campo, impone la lectura y
   valida; un cliente viejo sigue pudiendo crear perfiles.
2. **La app** (`npm run build` + tu despliegue habitual de GitHub Pages).
3. **Rules, fase 2** — `firebase deploy --only firestore:rules` desde `HEAD`,
   que ya lleva el `'visibility' in request.resource.data` del create. **No
   antes del paso 2**: un bundle cacheado que cree un perfil sin el campo sería
   rechazado. Ese es todo el motivo de que sean dos despliegues.

### Fuera, a propósito

- Nivel "solo seguidores" y solicitudes de seguimiento (razón arriba).
- Cerrar `handles/{handle}` para privados: exigiría denormalizar la
  visibilidad en el doc de handle y mantener dos documentos en sincronía, que
  es justo donde un bug rompe la unicidad. Y "está cogido" se sabe igual
  intentando registrarlo.
- Ocultar el grafo de seguidores de un perfil privado: costaría un `get()` por
  fila en una query de lista. Las aristas guardan solo uids.
- Arreglar el bug de `users/{uid}` (tarea aparte, decisión de producto).

## Rediseño integral de perfil y ajustes — séptima pasada (2026-08-19)

**Hecho y verificado en vivo** con las dos cuentas (`@mugar` / `@nick_mugar`),
en escritorio (800/1280) y móvil (375), en dev y, para la vista de visitante
anónimo, contra el build servido desde un origen limpio (`vite preview`, sin
sesión de Firebase). 524 tests verdes, lint y build limpios.

### El bug que iba primero (commit aislado `5b7afee`)

Los títulos de Me gusta morían si se cambiaba de pestaña antes de aterrizar
`fetchLibraryRecords`: los ids se marcaban como pedidos **antes** del fetch,
el cleanup del efecto descartaba la respuesta al cambiar `activeTab`, y no
había reintento — 40 × "Paper sin título" hasta recargar. 100 % reproducible
(Me gusta → otra pestaña en <1 s → volver). Fix de raíz: la respuesta se
fusiona siempre (la caché `likedExtra` es por id, idempotente; setState tras
unmount es no-op) y un batch fallido des-marca sus ids para que la siguiente
activación reintente. Commit propio ANTES del rediseño; la secuencia exacta
se verificó antes (40/40 sin título) y después (0/40), y otra vez sobre la
página ya rediseñada.

### La semántica que cambia: los contadores de cabecera cuentan usuarios

La cabecera decía *Siguiendo* = entidades del feed (privado) con el botón
*Siguiendo* = usuarios al lado: misma palabra, dos grafos. Ahora los tres
contadores del dueño son **Siguiendo (usuarios) / Seguidores / Me gusta** —
Siguiendo sale de `countFollowedUsers`, la agregación pública que la hoja ya
pedía, así que **cero lecturas nuevas** (y en vista de dueño se ahorra el
`isFollowing` contra uno mismo que antes sí se pedía). Las **entidades**
tienen su propia puerta etiquetada: chip "Contenido seguido · N" →
`/settings/following`, solo dueño. En perfil ajeno ya no hay guiones "—":
se ven Siguiendo y Seguidores **reales** (el grafo es público por diseño de
F2) y Me gusta simplemente no está — dos stats, composición completa, sin
huecos. La hoja vuelve a decir "Siguiendo": el renombrado "Usuarios seguidos"
de la pasada F2 quedó superseded (ya no colisiona con nada y en móvil se
partía en dos líneas).

### El resto del rediseño

| Cambio | Dónde |
| --- | --- |
| Navbar con sesión también en `/public/user/*` (como ya hacía `/public/paper/*`); el eyebrow "PAPERTOK · PUBLIC PROFILE" queda solo para visitantes sin sesión | `App.jsx`; clase `--app` por `hasAppChrome` en la página |
| Títulos de filas con `ScientificText` (el mismo KaTeX del feed) + saneado al pintar | `PublicProfilePage.jsx` + `src/utils/paperText.js` (+6 tests) |
| Botón Seguir: hover/focus cambian etiqueta y color **juntos** ("Dejar de seguir" en rojo) vía clase de estado, no `:hover`; tras pulsar Seguir descansa en "Siguiendo" neutro aunque el puntero siga encima | `PublicProfilePage.{jsx,css}` |
| Perfil ajeno: heading "Listas fijadas" en vez de tab-bar de un solo tab; fuera el CTA "Ir a mis listas" con sesión (la Navbar ya da la vuelta); el CTA de login queda solo sin sesión | ídem |
| Estados vacíos icono+título+hint (el patrón de FollowingSettingsPage) en las tres pestañas y en la hoja | ídem + `FollowSheet.jsx` |
| Skeleton completo (cabecera+stats+tab bar+filas) y filas fantasma al cargar pestañas | ídem |
| Móvil: cabecera retrato centrada (avatar 88 px, stats en columnas centradas, acciones centradas), no el escritorio estirado de antes | `PublicProfilePage.css` |
| Hoja: **altura fija por breakpoint** (cambiar de pestaña ya no salta ni re-centra), bottom-sheet real en móvil (muelle desde el borde) y scale-fade en escritorio, trampa de foco (Tab cicla dentro), pills de recuento, esqueleto de filas | `FollowSheet.{jsx,css}` |
| Stagger sobrio de filas/tarjetas (delay con tope 0,22 s); `prefers-reduced-motion` en todas las piezas | ambos |
| Ajustes: fila Perfil público → "**Editar**" (era "Ver todo"), chips de seguimiento a 0 ocultos, tarjetas de nivel IA alineadas arriba, toggle de analítica a ancho completo en ≤520 px, `<title>` propio reactivo al idioma | `SettingsPage.{jsx,css}` |
| Editor: `<title>` propio y entrada suave | `ProfilePage.{jsx,css}` |
| El `a:hover` morado global neutralizado en tarjetas/filas del perfil (el feedback ahí es borde+elevación) | `PublicProfilePage.css` |
| Entrada `papertok-preview` (vite preview) para auditar la vista sin sesión desde un origen limpio | `.claude/launch.json` |

### Privacidad re-verificada (2026-08-19)

- REST sin auth contra prod: `userProfiles/{uid}` expone solo campos
  públicos; `users/{uid}` y subcolecciones → 403.
- Visual sin sesión (origen limpio, build): cabecera pública + Listas
  fijadas + contadores del grafo público, nada más — sin Guardados, sin
  Me gusta, sin engranaje, sin editar. Follow sin sesión → prompt de auth,
  cero escrituras. La hoja funciona sin sesión (lecturas públicas acotadas).
- `resolveProfileView` intacto; los efectos de dueño siguen detrás de
  `view.isOwner`.
- Feed tras el rediseño, medido en vivo: `__papertokReads` = aggregate 2
  (doble montaje de StrictMode; 1 en prod), interactions 0, library 0.

### Deuda de datos anotada (no tocada, a propósito — amplía R8)

Documentos de `interactions` con títulos que llevan HTML literal
(`La <sub>2</sub> CuO <sub>4</sub>`) y autores en formato "Apellido, I.".
**No se reescriben los documentos**: el saneado es solo de presentación
(`src/utils/paperText.js`: sub/sup numéricos → Unicode ₂/², tags fuera,
"Do, T." → "T. Do" solo con iniciales inequívocas). La migración real de esos
docs queda pendiente y pertenece al mismo lote que R8 (ids de interacción no
canónicos).

### Notas de esta pasada

- Los clics del panel del navegador se cuelgan en emulación móvil y se
  pierden con viewport redimensionado a 1280: la verificación móvil/ancha fue
  con capturas + `.click()` sintético (dispara React; el router no, como ya
  documenta la memoria de la sesión).
- "Research" sigue sin traducir en la Navbar española — Navbar fuera del
  encargo y con riesgo de conflicto con la rama del compañero.
- El idioma de la cuenta quedó devuelto a inglés, como estaba al empezar.
- `SettingsPage.css` conserva sus colores/px hardcodeados (no está en el
  test de tokens); solo se tocó lo que la auditoría señaló.

### Choques con el rediseño del compañero

`PaperCard.{jsx,css}` y `Navbar.jsx` intactos. El riesgo de conflicto se
concentra ahora en `PublicProfilePage.{jsx,css}` y `FollowSheet.{jsx,css}`,
reescritos enteros en esta pasada.

## Perfil unificado estilo TikTok — hecho, pendiente de pasada con sesión (2026-08-19)

Una sola página de perfil para el dueño y para los visitantes, con el
contenido decidido por quién mira (`resolveProfileView`, puro y con tests).
Dos rutas la renderizan: `/public/user/:handle` (la URL compartible de F1, sin
cambios de contrato) y la nueva `/profile` (propia, tras ProtectedRoute, sale
en la Navbar y renderiza incluso sin perfil público creado, con CTA al editor).

| Archivo | Qué cambió |
| --- | --- |
| `src/components/Public/PublicProfilePage.{jsx,css}` | Ahora es LA página de perfil: cabecera con contadores, engranaje (→ `/settings`) y "Editar perfil" (→ `/settings/profile`) solo del dueño; pestañas Listas/Guardados/Me gusta. Conserva skeleton, estados de error, metadata y la animación de entrada. |
| `src/utils/profileAccess.{js,test.js}` | El gating dueño/visitante como función pura. Visitante = solo pestaña Listas. |
| `src/services/userProfileService.js` (+tests) | `readOwnLists()`: todas las listas propias, una página `limit(60)` sin `orderBy` (para no perder docs sin `createdAt`), orden en cliente, insignia `isPublished`. Pasa el test SOURCE de límites. |
| `src/context/FeedContext.jsx` | +6 líneas: `getCuratedInteractionIds(name)` expone los ids curados del agregado en orden de recencia. Solo memoria, cero lecturas. |
| `src/components/Layout/Navbar.jsx` | La foto navega **síncrono** a `/profile` (el navigate asíncrono se atasca con `AnimatePresence mode="wait"`). El desplegable entero desaparecido: Ajustes y Cerrar sesión ya vivían en SettingsPage (engranaje), "Mis listas" ahora es enlace "Gestionar" en la pestaña Listas. |
| `src/App.jsx` | Ruta `/profile` + entrada en `navbarRoutes`. |
| `src/components/Profile/ProfilePage.jsx` | Solo el botón volver: ahora → `/profile` (su padre natural). El editor sigue en `/settings/profile`. |
| `vite.config.js` | El server respeta `process.env.PORT` (dos sesiones de dev a la vez); sin PORT sigue siendo 5173. |
| `src/utils/myProfileRoute.{js,test.js}` | **Borrados**: la entrada de menú que resolvía el destino por lectura quedó superseded por la ruta fija `/profile`. |

**Contadores** (cabecera, estilo TikTok): *Siguiendo* = `followedEntities.length`
del FollowingContext (los autores/temas/instituciones de `users/{uid}/following`,
ya en memoria); *Seguidores* = 0 fijo, hueco listo para F2/P4, sin funcionalidad;
*Me gusta* = `likedPaperIds.size` del agregado de interacciones vía FeedContext.
En perfil ajeno, Siguiendo y Me gusta muestran "—": son datos privados
(`users/{uid}/*` es owner-only) y exponerlos exigiría tocar rules, que estaba
explícitamente fuera. Cero lecturas extra en los tres.

**Pestañas y costes**: Listas propias = 1 query acotada; Listas ajenas = las
`pinnedLists` del doc público (0 extra, como F1). Guardados = `personalLibrary`
readLater vía `ensurePersonalLibrary()` (acotado, ya existía). Me gusta = ids
curados del agregado (recencia) + `fetchLibraryRecords` solo de los ≤60 que se
pintan y solo al abrir la pestaña. El feed no cambia: `grep userProfileService
src/context src/components/Feed` sigue vacío y el test de coste sigue verde.

**Verificado** (2026-08-19): `npm test` 482 verdes (incluye los nuevos), lint,
build. En vivo sin auth contra prod: `/public/user/mugar` renderiza la vista
de visitante exacta (— / 0 / — , solo pestaña Listas con la lista fijada, sin
engranaje/editar); `/profile` sin sesión redirige a login. Por REST sin auth:
`userProfiles/{uid}` expone solo los campos públicos, y `users/{uid}`,
`users/{uid}/lists`, `users/{uid}/interactions`, `users/{uid}/following` y el
agregado devuelven todos `PERMISSION_DENIED` — guardados, likes y listas no
publicadas de otro son ilegibles a nivel de datos, no solo de UI.

**Pendiente de humano**: pasada con sesión iniciada (vista de dueño: contadores
reales, tres pestañas, engranaje, editar, foto de Navbar → perfil). Los clics
sintéticos no disparan el router en este entorno, así que la navegación por
clic real la prueba el usuario. La pestaña del navegador quedó en el login del
server de esta sesión.

**Fuera a propósito**: seguir usuarios y contador real de seguidores (F2/P4);
la pseudo-lista "Leídos" no tiene pestaña (sigue en `/lists`); las tarjetas de
lista propias llevan a `/lists` sin deep-link a la lista concreta (ListsPage no
tiene selección por URL); en modo demo `/profile` muestra el estado
"unsupported", como todo lo de perfiles desde F1; miniaturas tipo TikTok en las
pestañas (los docs de interacción no guardan imagen).

**Choques con el rediseño del compañero**: `PaperCard.{jsx,css}` intactos (sus
cambios sin commitear siguen tal cual). `Navbar.css` no se tocó: los estilos
del desplegable quedan muertos en CSS — borrarlos cuando su rama aterrice, no
antes. Si su rama toca `Navbar.jsx`, el conflicto es seguro: avisar antes de
fusionar.

### Segunda pasada (2026-08-19): privacidad, navegación y compartir

Verificada **en vivo con sesión del dueño** (el usuario inició sesión en el
navegador de la sesión): vista de dueño en `/profile` y en la URL pública,
pestañas Guardados/Me gusta con contenido real (títulos por `fetchLibraryRecords`
en orden de recencia), navegación por clic real (los clics del panel del
navegador son eventos confiables; la limitación de F1 era solo para eventos
sintéticos de JS).

| Cambio | Dónde |
| --- | --- |
| Editor rediseñado en secciones: Identidad pública / **Privacidad** / Listas fijadas / **Despublicar** | `ProfilePage.{jsx,css}` |
| Resumen de privacidad (qué es público vs qué nunca) + interruptor **"Mostrar mi foto de cuenta"**: controla si el doc público lleva `photo`; apagarlo borra el campo al guardar (`savePublicProfilePhoto(null)`, el update solo no lo elimina porque la sanitización descarta el vacío) | `ProfilePage.jsx` |
| **Despublicar perfil**: `deleteOwnUserProfile()` borra `userProfiles/{uid}` + `handles/{handle}` en un batch — la forma exacta que exigen las rules (endurecimiento C). Las listas publicadas quedan publicadas y anónimas. Sin tocar rules. | `userProfileService.js` (+3 tests) |
| Botón atrás con historial (`location.key !== 'default'` → `navigate(-1)`): perfil → Siguiendo → atrás vuelve al **perfil**, no a ajustes (bug reportado); mismo arreglo en el editor | `FollowingSettingsPage.jsx`, `ProfilePage.jsx` |
| Tarjeta de lista propia en el perfil → abre **la lista en sí**: `navigate('/lists', {state:{openListId}})` y ListsPage la expande al llegar (una vez por id; el estado sobrevive en la entrada de historial a propósito) | `PublicProfilePage.jsx`, `ListsPage.jsx` |
| "Copy link" → **"Share"** con hoja nativa (`navigator.share`) y fallback a portapapeles; hoja cerrada = silencio, no error; "Publicar y copiar enlace" → "Publicar y compartir" | `ListsPage.jsx`, `src/utils/shareLink.js` (+6 tests) |

`shareOrCopyLink` vive en `src/utils/shareLink.js` con inyección del share
nativo y del copy, por el detalle de que la activación transitoria puede
caducar durante el await de publicar (la hoja tira `NotAllowedError` y se cae
al portapapeles).

**Pendiente de humano (esta pasada)**: probar la hoja nativa de compartir en
un móvil real (en desktop cae a portapapeles o abre la hoja del sistema) y el
flujo completo de **Despublicar perfil** (no se ejecutó en vivo: habría borrado
el perfil real; el batch está cubierto por tests y calca las rules).

491 tests verdes, lint y build limpios. El test de tokens CSS cubre los dos
stylesheets tocados.

### Tercera pasada (2026-08-19): papers likeados resilientes, volver contextual, animaciones

Todo verificado en vivo con la sesión del dueño.

- **Los papers likeados ya no mueren con el rate limit de arXiv.** El bug: la
  página pública del paper siempre re-descargaba de la red (`id_list` de arXiv
  + enriquecido OpenAlex) aunque la app ya tuviera el paper en memoria, y un
  **429 de arXiv** la dejaba en "The paper could not be loaded" — con 40 likes
  y el feed compartiendo cuota, pasaba siempre. Ahora las filas del perfil
  entregan su copia por `location.state.paper`, `PublicPaperPage` la adapta
  (`paperLegacyAdapter`), la **ancla a la URL** (`encodePaperKey(semilla) ===
  paperKey`, para que un estado rancio no disfrace un paper de otro) y pinta al
  instante; la red queda como mejora opcional que ya no puede degradar a error
  lo que está en pantalla. Verificado con arXiv devolviendo 429 en vivo: la
  tarjeta sale completa (abstract "unavailable" hasta que la red vuelva). Los
  stubs solo se siembran para ids con forma de arXiv — el adaptador legacy
  fabricaría enlaces PDF rotos para cualquier otra cosa.
- **Volver desde una lista abierta del perfil vuelve al perfil.** `ListsPage`
  distingue si la lista expandida llegó por `openListId` (`openedFromRoute`):
  el control pasa a "← Volver" y hace `navigate(-1)` en vez de plegar al
  índice de Mis listas; abrir una lista desde el índice restaura el
  comportamiento clásico.
- **Animaciones de pestañas.** Indicador que se desliza entre pestañas
  (`layoutId` compartido, muelle 500/40) y panel único con
  `AnimatePresence mode="wait"` (fundido+desplazamiento 160 ms). Con
  `prefers-reduced-motion`: solo opacidad y sin muelle.

Detalle conocido (deuda R8, no de esta pasada): algún título likeado llega con
`<sub>` literal en el texto (metadatos de origen sin limpiar) y el corazón de
la página del paper no se rellena si el id de la interacción no coincide con
el canónico del adaptador.

### Cuarta pasada (2026-08-19): la página del paper es parte de la app

- **Cabecera**: con sesión, `/public/paper/*` mantiene la Navbar de la app
  (predicado `startsWith` en `App.jsx`; los visitantes sin sesión conservan la
  página autónoma con su mini-cabecera). La página añade solo un botón de
  volver flotante bajo la Navbar. Verificado en vivo: abrir un like se ve como
  el feed, no como la vista de invitado.
- **Abstract bajo rate limit**: `loadPaper` ya no depende solo de arXiv — si
  el `id_list` falla o vuelve vacío, cae a
  `fetchPaperByArxivIdViaOpenAlex()` (nuevo en `openAlexService`, mismo filtro
  de landing-page que el enriquecido, pero con abstract reconstruido del
  `abstract_inverted_index`), con `pdfUrl` derivado del id de arXiv pedido.
  Verificado en vivo **con arXiv devolviendo 429**: la página cargó completa
  con abstract vía OpenAlex; al levantarse el ban, la vía arXiv volvió sola
  (y con id canónico coincidente, el corazón de Like sale relleno).
- **"No me deja leer el paper"**: era el mismo ban de arXiv por IP (429),
  ganado a pulso en dev entre el feed y las recargas de verificación; el visor
  es un `<iframe>` directo a `arxiv.org/pdf/...` (el mismo del feed de
  siempre) y la URL quedó verificada sana por curl (200 `application/pdf`).
  El navegador empotrado de la sesión no renderiza PDFs en iframes
  (limitación de herramienta), así que la comprobación final del visor es del
  usuario en su navegador. El botón "New tab" del visor abre el PDF fuera en
  cualquier caso.

### Quinta pasada (2026-08-19): la tarjeta como destino, y que se note

- **Un paper de una lista abre su tarjeta, no el PDF.** `openPaperCard()` en
  `ListsPage` navega a `/public/paper/{key}` con el paper como semilla (el PDF
  sigue a un clic, en "Read article" de la propia tarjeta). Sin clave canónica
  cae al visor de PDF, para que el clic nunca quede muerto.
- **Volver desde esa tarjeta restaura la lista abierta**, no el índice: antes
  de salir se re-sella la entrada de historial con `{openListId, fromRoute}`, y
  `fromRoute` viaja para que el "volver" de la lista siga apuntando a donde
  apuntaba. Cerrar la lista limpia el sello.
- **Reconstrucción progresiva del paper**: la tarjeta entra con fundido y
  desplazamiento (0,45 s) y, cuando la copia sembrada se convierte en el paper
  completo, cruza un disolvido de 0,6 s en vez de aparecer de golpe. Solo
  opacidad en ese segundo tiempo: una `transform` ahí se convertiría en bloque
  contenedor de las hojas `position: fixed` de la propia tarjeta.

**Tres fallos encontrados y arreglados durante la verificación en vivo**, los
tres invisibles en tests y visibles solo pulsando:

1. La restauración no funcionaba para Favoritos / Leer después / Historial: el
   efecto buscaba en `lists` (solo las de Firestore) y esas tres se ensamblan
   en `displayLists`.
2. Corregido eso, seguía sin abrir: el efecto marcaba la lista como "ya
   abierta" **antes** del `setTimeout`, así que la primera rehidratación de
   contexto cancelaba el timer y el reintento se auto-rechazaba. La marca se
   pone ahora dentro del callback, cuando la apertura ocurre de verdad.
3. En la animación: si el paper completo llegaba antes de que acabara la
   entrada (caso caché), el segundo `start` cancelaba el primero y la tarjeta
   quedaba congelada 12 px desplazada. Ambos `start` fijan ahora `y: 0`.

### Sexta pasada (2026-08-19): esqueleto en lugar de pantalla negra

Cuando la página del paper no tiene semilla que pintar (un like cuyo título
aún no ha llegado, un DOI, o una URL abierta en frío), el estado de carga era
un spinner diminuto sobre negro. Ahora usa **`SkeletonCard`**, el mismo
esqueleto que el feed ya emplea: misma silueta que la tarjeta que viene
—pastillas de metadatos, título, autores, texto y botones— con su shimmer, y
ya trae su propia guarda de `prefers-reduced-motion`. Quitado el spinner muerto
(`.public-paper-spinner`, su keyframe y su regla de reduced-motion).

**Primer intento fallido, y por qué**: el esqueleto se ató solo a
`status === 'loading'`, y ese estado no se da nunca al abrir un like — la
semilla marca la página como lista al instante. El negro que se veía no era
la espera de red sino **el revelado de la tarjeta**: la entrada estaba
gobernada por `useAnimationControls`, y un `start()` que no encuentra su
elemento montado deja la tarjeta parada en su `initial` (opacidad 0) hasta
que otra animación la rescata — justo el segundo o dos que duraba el negro.

Arreglado en dos frentes:

1. **Animación declarativa**: `variants` + `animate` en lugar de controles
   imperativos, así no hay `start()` que pueda perder su enlace. La fase se
   deriva sin refs (`hasCurrentResult && seededPaper` ⇒ disolvido; si no,
   entrada normal).
2. **El esqueleto cubre el revelado, no solo la red**: se pinta por encima
   (`position: absolute; inset: 0; z-index: 800; pointer-events: none`) desde
   el primer fotograma y se retira con un fundido de 0,3 s cuando la tarjeta
   ha terminado de entrar (`onAnimationComplete`, con temporizador de 1,2 s
   como red de seguridad). Sea cual sea la causa de una demora futura, no
   puede volver a verse como pantalla vacía.

Verificado en vivo en el caso exacto reportado (perfil → Me gusta → clic):
capturados los tres fotogramas — esqueleto, disolvido sobre la tarjeta
emergiendo, y tarjeta completa.

## Red social — F2 (P4): seguimiento entre usuarios (2026-08-19)

**Implementado, desplegado y verificado en vivo con dos cuentas reales**
(`@mugar` y `@nick_mugar`) el 2026-08-19. Rules e índices en `papertok-168df`.

### El modelo

`follows/{followerUid}_{targetUid}`, un documento por arista, con
`followerUid`, `targetUid` y `createdAt`. El id compuesto **es** el diseño:
una arista no se puede duplicar (el segundo create cae sobre un documento que
ya existe y Firestore lo rechaza), dejar de seguir es un delete por id sin
query, y "¿le sigo?" es un `get`, no una búsqueda.

`users/{uid}/following` **no se toca**: sigue siendo privada, owner-only y de
entidades externas (autores, temas, instituciones) para el feed. El contador
*Siguiendo* de la cabecera sigue leyendo eso. Los usuarios seguidos viven
aparte y salen en la pestaña "Siguiendo" de la hoja.

| Archivo | Qué es |
| --- | --- |
| `src/services/followUserService.js` (+27 tests) | follow/unfollow idempotentes, `isFollowing`, contadores por `count()` acotado, páginas con cursor. Inyección de dependencias como `userProfileService`. |
| `src/components/Public/FollowSheet.{jsx,css}` | Hoja con pestañas Seguidores / Siguiendo, paginada (30 por página, "Cargar más"), Esc y clic fuera para cerrar. |
| `src/components/Public/PublicProfilePage.{jsx,css}` | El hueco "Seguidores" que F1 dejó a 0 ahora es un botón con el número real; botón **Seguir / Siguiendo** en el perfil ajeno, en el mismo slot que "Editar perfil" del dueño. Cabecera sin rediseñar. |
| `firestore.rules` | Bloque **aditivo** `follows/`. Cero líneas borradas. |
| `firestore.indexes.json` (nuevo) + `firebase.json` | Los dos compuestos que exige el plan: `(targetUid, createdAt desc)` y `(followerUid, createdAt desc)`. |
| `tests/firestore.rules.test.js` | +15 tests de comportamiento contra el emulador (41 en total). |
| `src/components/Profile/profileStyles.test.js` | `FollowSheet.css` entra en la lista de hojas con tokens verificados. |

### Contadores: `count()` acotado a 1000, y por qué

El plan pedía `count()` bajo demanda sin denormalizar, y así queda —
`followerCount` **sigue congelado** en las rules, junto a `orcid` y
`verified`. No hizo falta descongelarlo, así que la garantía de F1 (endurecimiento
B: nadie se auto-infla el contador) sigue intacta sin añadir nada: el número
no es un campo escribible, es una agregación sobre las aristas, y cada arista
exige `followerUid == request.auth.uid`.

El tope de 1000 no es decorativo. Firestore factura una agregación como **una
lectura por cada 1000 entradas de índice**, así que cortar exactamente en 1000
hace que un contador cueste **una lectura, siempre**, crezca lo que crezca el
grafo. Pasado el tope la cabecera dice "1000+" en vez de un número que no ha
contado. La escalada documentada si alguien pasa de verdad de ahí es el
`followerCount` denormalizado que mantendría la identidad de servicio — que
es justo por qué el campo sigue congelado para clientes.

**El techo lo impone el servidor, no el cliente.** `allow list: if
request.query.limit <= 1000` en las rules, y está comprobado contra el
emulador: una query sin `limit` se deniega, una con `limit(1001)` se deniega,
y una agregación sin `limit` **también** se deniega. No hay patrón sin tope
porque la base de datos no lo acepta.

### Coste por pantalla

| Acción | Lecturas |
| --- | --- |
| Abrir un perfil (visitante sin sesión) | 2 del perfil (F1) + 2 agregaciones |
| Abrir un perfil (visitante con sesión) | + 1 `get` de "¿le sigo?" |
| Seguir / dejar de seguir | 1 escritura (+1 lectura solo si la escritura choca, para distinguir idempotencia de fallo real) |
| Abrir la hoja de seguidores | 1 query acotada + 1 lectura por fila en pantalla (≤30), memoizadas por uid mientras la hoja vive |
| **Carga de feed** | **1, sin cambios** |

Las aristas guardan uids y nada más, a propósito: denormalizar nombre o handle
dejaría a un seguidor escribir texto que se pinta en el perfil de otro, que es
una superficie de suplantación a cambio de ahorrar lecturas. Por eso cada fila
resuelve su propio `userProfiles/{uid}`.

### Tests

- **41 contra el emulador** (`npm run test:rules`), de comportamiento, cero
  aserciones sobre el texto del fichero: no seguirse a uno mismo, seguir dos
  veces deja una arista y un seguidor, no crear ni borrar el follow de otro,
  contadores cuadrados tras seguir → dejar de seguir → volver a seguir,
  aristas inmutables, forma cerrada, `createdAt` de servidor, no seguir a un
  uid sin perfil público, techo de página, grafo público en lectura, nadie
  infla `followerCount`, y **el coste del feed sigue en 1 documento**.
- **518 unitarios** en `npm test`, incluidos 27 del servicio y tres
  estructurales: ninguna query sin `limit`, el servicio no menciona
  `users/`/`following`, y **ningún módulo del camino del feed importa
  `followUserService`** — que es donde el invariante de 1 lectura se puede
  romper de verdad, con un import.

**Pasada de mutación**: 14 cláusulas nuevas eliminadas una a una, **12
muertas** por el test que tocaba. Las 2 supervivientes (`hasAll` y el
`request.auth != null` del create) son **redundantes, no huecos**, y la propia
corrida lo demuestra: al quitarlas la escritura siguió denegada por otra
cláusula (desreferenciar `request.auth.uid` con `auth == null`, y
`createdAt == request.time` sobre un campo ausente, deniegan solas). Se
mantienen porque son el patrón de casa de `02-SECURITY.md`, y llevan comentario
en las rules para que nadie las crea portantes.

**El uid no puede llevar `_`** (`validFollowUid`). Firebase Auth emite uids
alfanuméricos de 28 caracteres, así que no rechaza nada real; sin esa cláusula
la cuenta `alice_uid` podría ocupar el documento que `alice` necesita para
seguir a `uid_bob` y bloquear ese follow para siempre. Hay test.

### Qué queda fuera, a propósito

- **Feed de actividad de seguidos**: excluido por el plan (`01-DATA-MODEL.md`),
  no por falta de tiempo.
- **Contador de "usuarios seguidos" en la cabecera**: la cabecera no se
  rediseña, y sus tres huecos ya están ocupados (Siguiendo = entidades,
  Seguidores, Me gusta). El número de usuarios seguidos sale en la pestaña
  "Siguiendo" de la hoja.
- **Notificar al seguido**: no hay infraestructura de notificaciones sociales;
  sería F7 o posterior.
- **Seguir desde otro sitio que no sea el perfil**: las rules exigen que el
  destino tenga perfil público, y el perfil es el único sitio donde eso se
  sabe sin una lectura extra.

### Verificación en vivo (2026-08-19)

**Rules, contra producción y sin cabecera de auth** (REST, no el navegador,
que comparte sesión y daría falsos positivos). Seis de seis:

| | |
| --- | --- |
| query `follows` con `limit(30)` | permitida |
| query `follows` **sin** `limit` | denegada |
| query `follows` con `limit(1001)` | denegada |
| `count()` con `limit(1000)` | permitida |
| `count()` **sin** `limit` | denegada |
| crear una arista sin sesión | denegada |

El techo de página no es una convención del cliente: producción rechaza
cualquier query sobre `follows` que no lo lleve, agregaciones incluidas.

**Flujo completo con sesión**, `@mugar` sobre el perfil de `@nick_mugar`:
contador real en 0 (ya no "—", que era el estado pre-deploy) → Seguir → 1 y
botón a "Siguiendo" → recarga y persiste → hoja de seguidores con la fila de
`@mugar` resuelta (el índice compuesto responde) → desde el perfil propio, la
pestaña de usuarios seguidos muestra `@nick_mugar` → dejar de seguir → 0 →
volver a seguir → 1. Sin descuadre en ningún paso. En consola, cero
`permission-denied`; los únicos errores son los 429 de OpenAlex, que son el
rate limit de dev ya conocido y ajeno a esto.

**Coste del feed medido en la app real**: `window.__papertokReads` tras cargar
el feed da `interactions: 0` y `library: 0` — cero escaneo, el agregado hizo
su trabajo. (`aggregate: 2` es el doble montaje de StrictMode en dev; en
producción es 1, y el test COST lo fija.)

**Un fallo encontrado y arreglado durante la pasada**: la cabecera dice
*Siguiendo* para las entidades del feed y la hoja decía *Siguiendo* para los
usuarios, a un clic de distancia y con números distintos (0 y 1). Misma
palabra, dos cosas. La pestaña pasa a llamarse **"Usuarios seguidos"** /
"Following users"; la cabecera no se toca.

**Datos vivos que quedan**: una arista real `mugar → nick_mugar`. Es un follow
legítimo, no basura de test; para deshacerlo basta pulsar "Siguiendo" en
`/public/user/nick_mugar`.

### Choques con el rediseño del compañero

`PaperCard.{jsx,css}` intactos otra vez. `Navbar.jsx` no se tocó en esta fase.
El riesgo sigue concentrado en `PublicProfilePage.{jsx,css}`, que ya venía muy
tocada por las seis pasadas del perfil: si su rama toca esa página, el
conflicto es seguro.

## Red social del conocimiento — F1 implementada (2026-08-19)

**Fase actual**: **F1 (P1+P2+P3) hecha y verificada en vivo**. Rules
desplegadas en `papertok-168df` el 2026-08-19. **F2/P4 hecha, desplegada y verificada en
vivo** (sección de arriba). Siguiente: **P5** (clave canónica de paper), que
es paralelizable.

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
  permitido en rules pero nadie lo escribe): es F2/P4. **Hecho**, ver la
  sección de F2 arriba; `followerCount` sigue congelado porque los contadores
  salieron por `count()`, sin denormalizar.
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

**Siguiente**: **P8** (anotaciones, F4) — P5/P6/P7 hechos, ver la sección de
F3 arriba —, más las acciones humanas de abajo (la 4, el uid de admin, quedó
hecha en F3).

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
