# Auditoría de comentarios (2026-09-05)

Tres fallos reportados sobre la hoja de comentarios y la página «Mis
comentarios»: el aviso «Comentario publicado» que no se va, el historial que
tarda y luego dice «Todavía no has comentado», y la hoja que a veces abre sin la
barra de escribir. Cada uno tiene una causa raíz distinta y ninguna es un
capricho del navegador.

## Cómo se comprobó

Lectura del código en `main` (ee6b967) más dos comprobaciones contra producción
sin sesión, desde Node con `fetch` contra la REST de Firestore, que las reglas
permiten (`allow list: if request.query.limit <= 1000` en
`firestore.rules:1232`):

- `handles/mugar` → uid `SrqikE0w…` (la cuenta del autor).
- La consulta exacta que hace `fetchMyCommentsPage` (collection group
  `comments`, `authorUid ==`, `createdAt desc`, límite 20), tres veces seguidas.

| Intento | HTTP | Filas | Tiempo |
| --- | --- | --- | --- |
| 1 | 200 | 1 | 391 ms |
| 2 | 200 | 1 | 96 ms |
| 3 | 200 | 1 | 91 ms |

El índice compuesto está desplegado (`firebase firestore:indexes` lo lista con
`authorUid ASC, createdAt DESC`). La única fila es «Probando los comentarios
desde el feed», del 19-08. No se listaron comentarios de otros autores.

No hubo reproducción con sesión en el navegador: la sesión es del usuario
([[papertok-auth-verification-boundary]]).

## Hallazgos

### C1. El aviso «Comentario publicado» no se va nunca

`CommentsSheet.jsx:404` guarda el aviso en `notice = { tone, text }` y
`submit()` lo fija en `:689` tras publicar. **No existe ningún temporizador en
el fichero** (`grep setTimeout` devuelve cero). El único momento en que el
texto se vacía es el arranque de la siguiente acción (`:665`, `:704`, `:735`):
publicar, borrar o reportar otra vez. Hasta entonces el chip se queda, y como el
párrafo se monta siempre (`:1033-1039`, con `.has-text` como único interruptor
de aspecto), no hay ni entrada ni salida: el borde y el fondo aparecen en un
fotograma y se quedan.

El commit 95ebdc2 (03-09) introdujo el comportamiento a propósito para que los
lectores de pantalla oyeran la confirmación: antes el párrafo nacía a la vez que
su mensaje y muchas veces no se anunciaba. La región viva persistente es
correcta y hay que conservarla; lo que falta es el ciclo de vida visual.

Además el color es el neutro (`CommentsSheet.css:420-429`, `--tint-neutral-*`)
para todos los tonos: éxito y error se ven igual. Los tokens verdes ya existen
(`--tint-green-bg/fg/line`, `variables.css:90-92` y su par oscuro `:376-378`).

**Diseño propuesto.**

- Frecuencia: ocasional (una vez por comentario). Propósito: *feedback*.
  Herramienta: framer, porque el aviso necesita salida y ya está en el árbol.
- Mantener el `<p role="status" aria-live="polite">` **siempre montado** como
  región viva. Dentro, `<AnimatePresence initial={false}>` con un
  `ThreadSlot` (`CommentsSheet.jsx:68`, el mismo que usan el chip de respuesta y
  el error del compositor) envolviendo el chip visible, con `key` que cambie en
  cada aviso (un contador `seq` en el estado) para que dos confirmaciones
  iguales seguidas sean dos entradas y no un no-op. Cambiar el texto dentro de
  la región viva sigue anunciando.
- Entrada y salida heredadas de `ThreadSlot`: altura 240 ms `ARRIVE` con
  opacidad 180 ms tras 40 ms; salida altura 200 ms `RESIZE` con opacidad
  120 ms. Con `prefersReducedMotion`, duración 0 (ya lo hace el slot). Se usa
  altura y no `transform` por la misma razón que el chip de respuesta: el aviso
  está en flujo dentro del cuerpo, y un transform dejaría un hueco que salta.
- Autodescarte **solo del tono `success`**, a 2 400 ms desde que se fija, en un
  efecto con `clearTimeout` en el cleanup y en cada nuevo aviso. Los errores
  (`tone: 'error'`, `role="alert"`) se quedan hasta la siguiente acción, como
  ahora.
- Tono: `.comments-sheet-notice.is-success` con los tokens verdes,
  `.is-error` con los rojos, neutro para el resto.
- A comprobar de oído, no de código: que 2 400 ms dé tiempo a leer «Comentario
  publicado.» sin que el chip parezca colgado; probar a ×3 en el inspector de
  animaciones.

### C2. «Mis comentarios» tarda y luego dice que no hay ninguno

Dos hechos distintos que se suman.

**(a) El vacío que muestra no lo confirmó el servidor.** `MyCommentsPage.jsx:71`
llama a `fetchMyCommentsPage()` a pelo: sin `patientRead`, sin
`withReadTimeout`, sin mirar `snapshot.metadata.fromCache`
(`commentService.js:244-258` descarta los metadatos al mapear). Firestore en
esta app usa cache **solo de memoria** (`firebase.js:49`), y una `getDocs`
contra un canal mudo **no rechaza**: a los 10 003 ms el SDK se declara offline y
resuelve con éxito, vacío y `fromCache: true` (medido el 21-08,
[[papertok-firestore-transient-reads]]). La página lo toma por conocimiento y
pinta «Todavía no has comentado». Es exactamente el caso que
`queryIsAuthoritative` (`utils/cacheAuthority.js`) existe para evitar y que ya
mordió al modal de listas y a la página de listas.

Por qué es *esta* pantalla la que lo sufre: la hoja de comentarios lee el hilo
por el Worker (`fetchThreadAnchor`, `threadAnchorClient.js`), así que abre en
un par de cientos de milisegundos aunque el canal de Firestore esté frío. «Mis
comentarios» no tiene camino por el borde: es la única lectura de comentarios
que toca el WebChannel, y se llega a ella tras un rato en Ajustes sin tráfico
de Firestore, cuando el stream ya se cerró por inactividad (60 s). Diez
segundos de esqueleto y un vacío falso es la firma completa.

**(b) El servidor devuelve un solo comentario para @mugar.** La tabla de arriba
es la verdad de la base de datos hoy: un comentario, del 19-08. Si se han
escrito más comentarios «recientemente» con esa cuenta y no aparecen, no es
este bug. Lo más probable es que se publicaran con la otra identidad (Google y
GitHub son uids distintos) o que se borraran desde la hoja. Conviene
confirmarlo desde la cuenta con la que se probó.

**Arreglo propuesto.**

- `defaultReadAuthorPage` devuelve también `fromCache` (como hace
  `fetchLibraryRecords`), y `fetchMyCommentsPage` lo expone.
- La página carga con `patientRead` + `AbortController` como la hoja
  (`CommentsSheet.jsx:428-534`), trata un vacío `fromCache` como transitorio
  (reintento con backoff, `onLateResult` cura la pantalla) y estrena los
  estados `slow` / `offline` / `stalled` con la misma copia que la hoja, en
  lugar de esqueleto mudo diez segundos.
- Opcional, para el «tarda»: precargar el chunk (`lazyWithPreload` ya lo
  permite, `App.jsx:56`) al pasar por la fila de Ajustes que lleva a la página.

### C3. La hoja abre sin barra de escribir

`composerState` (`CommentsSheet.jsx:590-598`) tiene cinco valores y el pie
(`:1042-1141`) pinta cuatro: `signed-out`, `no-profile`, `private` y `ready`.
**Para `loading` no hay rama**: el `<footer>` se renderiza vacío. Es el estado
en que está la hoja mientras `readOwnUserProfile()` (`:555`) no ha resuelto, y
esa lectura es un `getDoc` de Firestore **sin acotar**: ni `patientRead` ni
`withReadTimeout`, al contrario que el hilo, que va por el Worker. El mismo
desfase que en C2: el hilo llega por el borde y pinta «Nadie ha comentado
todavía» en 200 ms; el perfil espera al WebChannel, que si está frío tarda el
handshake y si está mudo, diez segundos. Durante ese hueco no hay barra.

Dos agravantes:

- La caché de la hoja (`viewerProfileCache`, `:45`) solo se siembra cuando la
  propia hoja ya resolvió una vez en esta sesión. Ignora `ownProfileCache` y el
  perfil que `hydrateAccountCaches` lee de `localStorage` en cuanto hay sesión
  (`AuthContext.jsx:88-89`, `accountWarmup.js:44-54`). El dato ya está en el
  dispositivo y la hoja no lo mira.
- Cuando la lectura acaba rechazando (`unavailable` a los 10 s), el `catch`
  (`:563-565`) la convierte en `profile: null`, y el pie pasa a decir «Comentar
  necesita un perfil público» a una cuenta que lo tiene. Falso positivo peor
  que el vacío.

**Arreglo propuesto.**

- Sembrar `ownProfile` desde `ownProfileCache.get(ownProfileKey(uid))` tras
  `hydrateAccountCaches(uid)`; el estado `loading` pasa a ser raro (solo primer
  arranque sin perfil guardado).
- Rama de pie para `loading`: el compositor tal cual, con el textarea y el botón
  deshabilitados y el placeholder «Cargando...», para que la hoja mida lo mismo
  antes y después (la columna anclada abajo empuja hacia arriba lo que llega
  tarde, [[papertok-bottom-anchored-column-late-elements]]).
- La lectura va por `patientRead`; un fallo transitorio deja el compositor en
  `loading` y sigue reintentando, y solo un `profile: null` **autoritativo**
  (`documentIsAuthoritative`) abre la puerta «crea tu perfil». Las reglas
  siguen siendo la última palabra: si alguien publica con un perfil que en
  realidad es privado, `explainDenial` ya lo cuenta.

## Orden sugerido

C3 primero (es el que impide comentar), luego C2 (comparten la receta:
`patientRead` + autoridad de cache), y C1 al final porque toca diseño y quiere
una comprobación a ojo.

## Estado (2026-09-05)

Los tres hallazgos, cerrados en la rama `worktree-comentarios-arreglo`, doce
commits sobre `3672991`. La suite pasa a 2187 (línea base 2140) y el build es
limpio. Lo que sigue abierto está dicho como tal.

- **C1 — el aviso eterno.** Cerrado por `412d0a5` (el módulo puro
  `noticeLifecycle.js`: secuencia, vida por tono, caducidad) y `69553ea` (el
  chip keyed por secuencia que entra y sale por el `ThreadSlot` de la hoja,
  verde para éxito y rojo para error desde los tokens `--tint-*`, con el éxito
  caducando a 2 400 ms y el error esperando a la siguiente acción). `e0e2095`
  añadió lo que la revisión final encontró: la región viva ya no cambia de
  `role` en el mismo commit que su texto, porque varios lectores de pantalla
  la vuelven a registrar y se comen esa primera mutación. Ahora hay dos
  regiones montadas, una `status` y otra `alert`, y el chip entra en la que
  toca.

- **C2 — el historial vacío.** Cerrado por `ed1aabb` (la consulta de autor
  dice si vino de la cache), `83d2bd2` (un vacío sin confirmar es un error
  `unavailable` que `patientRead` reintenta, más la copia de lento / sin
  conexión / atascado) y `069009f` (la precarga del chunk). `0875ea1` corrigió
  un efecto secundario que encontró la revisión final: como `onSlow` dispara
  con cualquier rechazo transitorio, y un vacío de cache llega en medio
  milisegundo, la página decía «está tardando más de lo normal» a los 2 ms.
  Ahora el aviso espera 1 200 ms, salvo cuando el navegador dice que no hay
  red.

- **C3 — la hoja sin barra de escribir.** Cerrado por `751ab3b` (el módulo
  puro `composerGate.js`), `8180735` (el compositor deshabilitado durante la
  carga, la lectura del perfil con `patientRead`, y de paso el `aria-label`
  duplicado que la migración a shadcn había dejado en el campo) y `3c9770d`,
  que es el hallazgo que esta auditoría pedía y el plan se dejó: la ausencia
  del perfil propio ahora tiene que venir del servidor. `readConfirmedOwnUserProfile`
  comprueba `documentIsAuthoritative` y convierte una ausencia servida por la
  cache en un error `unavailable`, que se reintenta en vez de abrir la puerta
  «crea tu perfil». Sin eso, el arreglo cubría solo la mitad de la avería: el
  rechazo a los 10 s, no el `exists:false, fromCache:true` que llega en medio
  milisegundo.

  El mismo agujero tenía dos puertas más. `aead32f` cerró la peor: el
  calentamiento de cuenta corre en cada inicio de sesión, antes que nada, y
  escribía esa ausencia sin confirmar en la cache compartida además de borrar
  la copia guardada en el dispositivo. `21eec45` cerró la del editor de perfil.

  La tercera, `PublicProfilePage.jsx` en modo propio (la ruta `/profile`),
  la cerró `8c7bb61` el 06-09: sembraba la misma cache compartida con un
  `null` que podía venir de la cache de Firestore, y de ahí la hoja repetía
  el mensaje. No era un cambio de una línea porque ese efecto no tenía
  `patientRead`, y la lectura confirmada a secas habría convertido un
  arranque lento en pantalla de error. Ahora la rama propia del efecto va
  por `patientRead` (dos intentos, aborto al desmontar, `onLateResult`), la
  cache solo se escribe desde la función que aplica una respuesta del
  servidor, y la espera reutiliza lo que la página ya tenía: el esqueleto
  hasta el umbral de `slowNoticeStatus`, y después la página de estado con
  dos títulos nuevos («está tardando», «no hay conexión»), el mismo cuerpo y
  el mismo Reintentar, que ahora devuelve el esqueleto antes de leer de
  nuevo. Una página ya sembrada (cache de sesión o copia del dispositivo)
  nunca vuelve a una espera. La rama de visitante no cambia. Test de regex
  sobre el fuente en `ownProfileConfirmedRead.test.js`, con una trampa
  anotada: el comentario que cita el glob `/public/user/*` abre un bloque
  para un despojador de comentarios ingenuo, así que las líneas `//` se
  quitan antes que los bloques.

### Lo que queda abierto

Tres cosas menores quedan anotadas y no bloquean: el umbral de 1 200 ms es un
juicio y no una medida (es inyectable), las dos regiones del aviso pueden
solaparse brevemente al cambiar de tono, y la línea de espera del compositor
nace junto a su texto, así que su garantía fuerte es que el campo es
alcanzable con `aria-describedby`, no el anuncio.

### Lo que falta comprobar a mano

Con sesión iniciada, que es lo único que no se puede verificar desde aquí:

1. Abrir comentarios nada más cargar la app. La barra de escribir está desde
   el primer momento, deshabilitada un instante y luego viva. Nunca dice
   «Comentar necesita un perfil público» a una cuenta que lo tiene.
2. Publicar un comentario. El chip entra en verde, se lee, y se va solo. Dos
   seguidos: el segundo espera a que salga el primero.
3. Borrar un comentario sin red. El chip rojo se queda hasta la siguiente
   acción.
4. Ajustes → Mis comentarios tras un rato sin tocar Firestore. O pinta la
   lista, o dice que está tardando y ofrece reintentar. Nunca «Todavía no has
   comentado» mientras la lectura sigue en el aire.
5. Confirmar con qué cuenta se escribieron los comentarios que se esperaban
   ver: el servidor solo tiene uno de @mugar, del 19 de agosto.
